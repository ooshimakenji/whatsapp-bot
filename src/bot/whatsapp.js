const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const { validateLegend, isNumberAllowed } = require('../services/validator');
const { saveBatch, getPhotosFolder, ensureDir } = require('../services/storage');
const { logActivity } = require('../services/email');

// Caminho para salvar QR Code como imagem (util para EC2/headless)
const QR_CODE_PATH = process.env.QR_CODE_PATH || './qrcode.png';

// Pasta para persistencia de sessoes
const SESSIONS_FILE = './data/sessions.json';
const PHOTOS_TEMP_DIR = './data/temp_photos';

// Sessoes ativas por usuario
const sessions = new Map();

// Cache do grupo de supervisores
let supervisorChat = null;

// Timers de lembrete e timeout
const reminders = new Map();
const timeouts = new Map();
const photoDebounce = new Map();  // Timer para agrupar fotos

// Constantes de tempo
const REMINDER_TIME = 2 * 60 * 1000;  // 2 minutos
const TIMEOUT_TIME = 5 * 60 * 1000;   // 5 minutos
const PHOTO_DEBOUNCE_TIME = 5 * 1000; // 5 segundos para agrupar fotos
const MESSAGE_DELAY = 800;            // 800ms entre mensagens (evita ordem invertida)

/**
 * Delay entre mensagens para garantir ordem
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Estados da sessao
const STATE = {
  IDLE: 'idle',
  COLLECTING: 'collecting',
  READY_TO_SEND: 'ready_to_send',
  WAITING_ACTION: 'waiting_action',
  RECOVERING: 'recovering',           // Perguntando se quer continuar apos reinicio
  CONFIRMING_AS: 'confirming_as',     // Perguntando se tem certeza da AS
  ADDING_MORE: 'adding_more'          // Perguntando se quer adicionar mais fotos
};

// Cumprimentos reconhecidos
const GREETINGS = ['oi', 'ola', 'olá', 'bom dia', 'boa tarde', 'boa noite', 'hey', 'eai', 'e ai'];

// Cliente WhatsApp
const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: './session'
  }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process'
    ],
    // No Linux/EC2, usa o Chromium do sistema
    ...(process.platform === 'linux' && { executablePath: '/usr/bin/chromium-browser' })
  }
});

/**
 * Retorna cumprimento baseado no horario (MAIUSCULO)
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return 'BOM DIA';
  if (hour >= 12 && hour < 18) return 'BOA TARDE';
  return 'BOA NOITE';
}

/**
 * Verifica se texto e um cumprimento
 */
function isGreeting(text) {
  const normalized = text.toLowerCase().trim();
  return GREETINGS.some(g => normalized.includes(g));
}

/**
 * Obtem nome do contato
 */
async function getContactName(message) {
  try {
    const contact = await message.getContact();
    return contact.pushname || contact.name || contact.number;
  } catch {
    return 'Colaborador';
  }
}

/**
 * Calcula hash MD5 de um buffer
 */
function calculateHash(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

/**
 * Cria ou obtem sessao do usuario
 */
function getSession(number) {
  if (!sessions.has(number)) {
    sessions.set(number, {
      state: STATE.IDLE,
      photos: [],
      photoHashes: new Set(),  // Hashes das fotos do lote
      duplicateCount: 0,       // Contador de duplicatas
      legend: null,
      collaboratorName: null,
      todayCount: 0
    });
  }
  return sessions.get(number);
}

/**
 * Limpa timers do usuario
 */
function clearTimers(number) {
  if (reminders.has(number)) {
    clearTimeout(reminders.get(number));
    reminders.delete(number);
  }
  if (timeouts.has(number)) {
    clearTimeout(timeouts.get(number));
    timeouts.delete(number);
  }
}

/**
 * Configura lembrete de 2 minutos
 */
function setReminder(number, chat, session) {
  clearTimers(number);

  reminders.set(number, setTimeout(async () => {
    if (session.state === STATE.COLLECTING) {
      const missing = config.minPhotosPerBatch - session.photos.length;
      if (missing > 0) {
        await chat.sendMessage(`Faltam *${missing} foto(s)* para completar.`);
      } else if (!session.legend) {
        await chat.sendMessage(`Envie o *NUMERO DA AS*`);
      }
    }
  }, REMINDER_TIME));
}

/**
 * Configura timeout de 5 minutos - ENVIA AUTOMATICAMENTE se nao responder
 */
function setTimeout5min(number, chat, autoSendCallback) {
  clearTimers(number);

  timeouts.set(number, setTimeout(async () => {
    const session = sessions.get(number);
    if (!session) return;

    if (session.state === STATE.READY_TO_SEND) {
      // Auto-envia apos 5 minutos sem resposta
      console.log(`[${number}] Auto-enviando apos timeout...`);
      await chat.sendMessage(`Enviando automaticamente...\n(sem resposta em 5 min)`);
      if (autoSendCallback) {
        await autoSendCallback();
      }
    } else if (session.state === STATE.WAITING_ACTION) {
      // Finaliza sessao
      console.log(`[${number}] Finalizando sessao apos timeout`);
      await chat.sendMessage(`Sessão finalizada.\n(sem resposta em 5 min)`);
      sessions.delete(number);
      clearTimers(number);
      saveSessionsToFile();
    } else if (session.state !== STATE.IDLE) {
      console.log(`[${number}] Sessao expirada`);
      sessions.delete(number);
      clearTimers(number);
      saveSessionsToFile();
    }
  }, TIMEOUT_TIME));
}

/**
 * Salva sessoes em arquivo para persistencia
 */
function saveSessionsToFile() {
  try {
    ensureDir(path.dirname(SESSIONS_FILE));
    ensureDir(PHOTOS_TEMP_DIR);

    const data = {};
    for (const [number, session] of sessions.entries()) {
      // Salva fotos em arquivos temporarios
      const photoFiles = [];
      for (let i = 0; i < session.photos.length; i++) {
        const photo = session.photos[i];
        const photoPath = path.join(PHOTOS_TEMP_DIR, `${number}_${i}_${photo.fileName}`);
        fs.writeFileSync(photoPath, photo.buffer);
        photoFiles.push({ fileName: photo.fileName, path: photoPath });
      }

      data[number] = {
        state: session.state,
        legend: session.legend,
        collaboratorName: session.collaboratorName,
        todayCount: session.todayCount,
        photoFiles: photoFiles,
        savedAt: new Date().toISOString()
      };
    }

    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
    console.log(`Sessoes salvas: ${Object.keys(data).length}`);
  } catch (error) {
    console.error('Erro ao salvar sessoes:', error.message);
  }
}

/**
 * Carrega sessoes do arquivo
 */
function loadSessionsFromFile() {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) {
      return {};
    }

    const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    console.log(`Sessoes encontradas: ${Object.keys(data).length}`);
    return data;
  } catch (error) {
    console.error('Erro ao carregar sessoes:', error.message);
    return {};
  }
}

/**
 * Restaura sessao do arquivo para memoria
 */
function restoreSession(number, savedSession) {
  const photos = [];
  for (const photoFile of savedSession.photoFiles || []) {
    if (fs.existsSync(photoFile.path)) {
      const buffer = fs.readFileSync(photoFile.path);
      photos.push({ buffer, fileName: photoFile.fileName });
    }
  }

  sessions.set(number, {
    state: savedSession.state,
    photos: photos,
    legend: savedSession.legend,
    collaboratorName: savedSession.collaboratorName,
    todayCount: savedSession.todayCount || 0
  });

  return photos.length;
}

/**
 * Limpa arquivos temporarios de uma sessao
 */
function cleanupTempPhotos(number) {
  try {
    if (!fs.existsSync(PHOTOS_TEMP_DIR)) return;

    const files = fs.readdirSync(PHOTOS_TEMP_DIR);
    for (const file of files) {
      if (file.startsWith(`${number}_`)) {
        fs.unlinkSync(path.join(PHOTOS_TEMP_DIR, file));
      }
    }
  } catch (error) {
    console.error('Erro ao limpar temp:', error.message);
  }
}

/**
 * Busca o grupo de supervisores pelo nome
 */
async function findSupervisorGroup() {
  if (!config.supervisorGroup) {
    return null;
  }

  if (supervisorChat) {
    return supervisorChat;
  }

  try {
    const chats = await client.getChats();
    const group = chats.find(chat =>
      chat.isGroup && chat.name.toLowerCase() === config.supervisorGroup.toLowerCase()
    );

    if (group) {
      supervisorChat = group;
      console.log(`Grupo de supervisores encontrado: ${group.name}`);
      return group;
    }

    console.log(`Grupo "${config.supervisorGroup}" nao encontrado.`);
    return null;
  } catch (error) {
    console.error('Erro ao buscar grupo:', error.message);
    return null;
  }
}

/**
 * Envia fotos para o grupo de supervisores com retry
 */
async function sendToSupervisors(session, retries = 3) {
  const group = await findSupervisorGroup();

  if (!group) {
    return { success: false, reason: 'Grupo nao configurado ou nao encontrado' };
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Envia mensagem com info do lote
      await group.sendMessage(`*AS ${session.legend}* - ${session.collaboratorName}`);

      // Envia cada foto
      for (const photo of session.photos) {
        const media = new MessageMedia(
          'image/jpeg',
          photo.buffer.toString('base64'),
          photo.fileName
        );
        await group.sendMessage(media);
      }

      console.log(`Fotos enviadas para supervisores: AS ${session.legend}`);
      return { success: true };

    } catch (error) {
      console.error(`Tentativa ${attempt}/${retries} falhou:`, error.message);

      if (attempt < retries) {
        // Aguarda 2 segundos antes de tentar novamente
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }

  return { success: false, reason: 'Falha apos 3 tentativas' };
}

/**
 * Envia pergunta de sim/nao
 */
async function sendYesNo(chat, question) {
  await chat.sendMessage(`${question}\n\n*SIM* ou *NAO*`);
}

/**
 * Recupera sessoes pendentes ao reiniciar o bot
 */
async function recoverPendingSessions() {
  const savedSessions = loadSessionsFromFile();
  const numbers = Object.keys(savedSessions);

  if (numbers.length === 0) {
    console.log('Nenhuma sessao pendente para recuperar.');
    return;
  }

  console.log(`Recuperando ${numbers.length} sessao(oes) pendente(s)...`);

  for (const number of numbers) {
    const saved = savedSessions[number];

    // Ignora sessoes muito antigas (mais de 24h)
    const savedAt = new Date(saved.savedAt);
    const hoursAgo = (Date.now() - savedAt.getTime()) / (1000 * 60 * 60);
    if (hoursAgo > 24) {
      console.log(`[${number}] Sessao muito antiga (${Math.round(hoursAgo)}h), descartando`);
      cleanupTempPhotos(number);
      continue;
    }

    // Restaura sessao na memoria
    const photosCount = restoreSession(number, saved);

    if (photosCount === 0 && !saved.legend) {
      console.log(`[${number}] Sessao vazia, descartando`);
      sessions.delete(number);
      cleanupTempPhotos(number);
      continue;
    }

    // Envia mensagem perguntando se quer continuar
    try {
      const chat = await client.getChatById(`${number}@c.us`);

      if (saved.state === STATE.READY_TO_SEND || saved.state === STATE.COLLECTING) {
        const session = sessions.get(number);
        await chat.sendMessage(
          `O bot foi reiniciado.\n\n` +
          `Você tinha um lote pendente:\n` +
          `- Fotos: *${photosCount}*\n` +
          `- AS: *${saved.legend || 'pendente'}*\n\n` +
          `Deseja continuar?\n\n*SIM* ou *NAO*`
        );
        session.state = STATE.RECOVERING;
        console.log(`[${number}] Perguntando se quer continuar (${photosCount} fotos)`);
      } else {
        // Outras sessoes, apenas limpa
        sessions.delete(number);
        cleanupTempPhotos(number);
      }
    } catch (error) {
      console.error(`[${number}] Erro ao recuperar:`, error.message);
      sessions.delete(number);
      cleanupTempPhotos(number);
    }
  }

  // Limpa arquivo de sessoes
  if (fs.existsSync(SESSIONS_FILE)) {
    fs.unlinkSync(SESSIONS_FILE);
  }
}

/**
 * Processa mensagens nao lidas enviadas enquanto o bot estava offline
 */
async function processUnreadMessages() {
  console.log('\nVerificando mensagens nao lidas...');

  try {
    const chats = await client.getChats();
    let processedCount = 0;

    for (const chat of chats) {
      // Ignora grupos e broadcasts
      if (chat.isGroup || chat.isBroadcast) continue;

      // Ignora se nao tem mensagens nao lidas
      if (chat.unreadCount === 0) continue;

      // Pega o numero do contato
      const number = chat.id.user;

      // Ignora se nao e autorizado
      if (!isNumberAllowed(number)) {
        console.log(`[${number}] Nao autorizado, ignorando ${chat.unreadCount} msg`);
        continue;
      }

      // Ignora se ja tem sessao ativa (foi recuperada do arquivo)
      if (sessions.has(number)) {
        console.log(`[${number}] Ja tem sessao ativa, ignorando`);
        continue;
      }

      console.log(`[${number}] Processando ${chat.unreadCount} mensagens nao lidas...`);

      // Busca mensagens recentes (ultimas 50)
      const messages = await chat.fetchMessages({ limit: 50 });

      // Filtra apenas mensagens nao lidas e recentes (ultimas 12h)
      const twelveHoursAgo = Date.now() - (12 * 60 * 60 * 1000);
      const unreadMessages = messages.filter(msg => {
        const msgTime = msg.timestamp * 1000;
        return !msg.fromMe && msgTime > twelveHoursAgo;
      });

      if (unreadMessages.length === 0) continue;

      // Processa mensagens para extrair fotos e AS
      const photos = [];
      let legend = null;
      let collaboratorName = null;

      for (const msg of unreadMessages) {
        // Pega nome do colaborador
        if (!collaboratorName) {
          try {
            const contact = await msg.getContact();
            collaboratorName = contact.pushname || contact.name || number;
          } catch {
            collaboratorName = number;
          }
        }

        // Verifica se e foto
        if (msg.hasMedia && (msg.type === 'image' || msg.type === 'sticker')) {
          try {
            const media = await msg.downloadMedia();
            if (media) {
              const buffer = Buffer.from(media.data, 'base64');
              const extension = media.mimetype?.split('/')[1] || 'jpg';
              const fileName = `foto_${msg.timestamp}.${extension}`;
              photos.push({ buffer, fileName });

              // Verifica legenda da foto
              if (msg.body) {
                const validation = validateLegend(msg.body);
                if (validation.valid && !legend) {
                  legend = validation.code;
                }
              }
            }
          } catch (err) {
            console.log(`[${number}] Erro ao baixar foto: ${err.message}`);
          }
        }

        // Verifica se e texto com AS
        if (msg.body && !msg.hasMedia) {
          const validation = validateLegend(msg.body);
          if (validation.valid && !legend) {
            legend = validation.code;
          }
        }
      }

      // Se encontrou fotos, cria sessao e pergunta
      if (photos.length > 0) {
        sessions.set(number, {
          state: STATE.RECOVERING,
          photos: photos,
          legend: legend,
          collaboratorName: collaboratorName,
          todayCount: 0
        });

        const hasMinPhotos = photos.length >= config.minPhotosPerBatch;

        await chat.sendMessage(
          `${getGreeting()}! Vi que voce enviou mensagens enquanto eu estava offline:\n` +
          `- Fotos: ${photos.length}${hasMinPhotos ? ' ✓' : ` (min ${config.minPhotosPerBatch})`}\n` +
          `- AS: ${legend || 'nao encontrada'}\n\n` +
          `DESEJA ENVIAR ESTE LOTE?\n\n_Responda: S ou N_`
        );

        processedCount++;
        console.log(`[${number}] Encontradas ${photos.length} fotos, AS: ${legend || 'N/A'}`);
      }

      // Marca como lido
      await chat.sendSeen();
    }

    if (processedCount > 0) {
      console.log(`Processadas mensagens de ${processedCount} colaborador(es)`);
    } else {
      console.log('Nenhuma mensagem pendente para processar.');
    }

  } catch (error) {
    console.error('Erro ao processar mensagens nao lidas:', error.message);
  }
}

/**
 * Inicializa o bot
 */
function initialize() {
  client.on('qr', async (qr) => {
    console.log('\nEscaneie o QR Code:');

    // Mostra no terminal (funciona local)
    qrcodeTerminal.generate(qr, { small: true });

    // Salva como imagem PNG (para EC2/headless)
    try {
      await QRCode.toFile(QR_CODE_PATH, qr, {
        width: 300,
        margin: 2
      });
      console.log(`\nQR Code salvo em: ${path.resolve(QR_CODE_PATH)}`);
      console.log('No servidor, baixe com: scp -i chave.pem ubuntu@IP:~/whatsapp-bot/qrcode.png .');
    } catch (err) {
      console.error('Erro ao salvar QR Code:', err.message);
    }
  });

  client.on('ready', async () => {
    console.log('\nBot conectado e pronto.');
    console.log(`Pasta de fotos: ${getPhotosFolder()}`);

    // Busca grupo de supervisores
    if (config.supervisorGroup) {
      console.log(`Buscando grupo: ${config.supervisorGroup}...`);
      await findSupervisorGroup();
    }

    // Recupera sessoes pendentes (do arquivo local)
    await recoverPendingSessions();

    // TODO: Descomentar quando quiser processar mensagens enviadas enquanto offline
    // await processUnreadMessages();
  });

  client.on('authenticated', () => {
    console.log('Autenticado.');
  });

  client.on('auth_failure', (msg) => {
    console.error('Falha na autenticacao:', msg);
  });

  client.on('disconnected', (reason) => {
    console.log('Desconectado:', reason);
  });

  client.on('message', handleMessage);

  client.initialize();
  return client;
}

/**
 * Processa mensagem recebida
 */
async function handleMessage(message) {
  try {
    const contact = await message.getContact();
    const number = contact.number;
    const chat = await message.getChat();

    if (!isNumberAllowed(number)) {
      console.log(`Bloqueado: ${number}`);
      logActivity({ type: 'rejected', message: `Numero bloqueado: ${number}` });
      return;
    }

    const session = getSession(number);

    // Atualiza nome do colaborador
    if (!session.collaboratorName) {
      session.collaboratorName = await getContactName(message);
    }

    // Processa baseado no tipo de mensagem
    if (message.hasMedia) {
      await handlePhoto(message, number, chat, session);
    } else if (message.body) {
      await handleText(message, number, chat, session);
    }
  } catch (error) {
    console.error('Erro:', error.message);
  }
}

/**
 * Processa foto recebida
 */
async function handlePhoto(message, number, chat, session) {
  // Se estava idle, inicia coleta
  if (session.state === STATE.IDLE) {
    session.state = STATE.COLLECTING;
    session.photos = [];
    session.photoHashes = new Set();
    session.duplicateCount = 0;
    session.legend = null;
  }

  // Se estava esperando acao pos-envio, inicia novo lote
  if (session.state === STATE.WAITING_ACTION) {
    session.state = STATE.COLLECTING;
    session.photos = [];
    session.photoHashes = new Set();
    session.duplicateCount = 0;
    session.legend = null;
  }

  const caption = message.body || '';

  // Verifica legenda na foto
  if (caption.trim()) {
    const validation = validateLegend(caption);
    if (validation.valid && !validation.needsConfirmation) {
      if (session.legend && session.legend !== validation.code) {
        await chat.sendMessage(`AS diferente do lote atual (${session.legend})`);
        return;
      }
      session.legend = validation.code;
    }
  }

  // Baixa foto
  const media = await message.downloadMedia();
  if (!media) {
    await chat.sendMessage(`Erro ao baixar foto. Reenvie.`);
    return;
  }

  const buffer = Buffer.from(media.data, 'base64');
  const extension = media.mimetype.split('/')[1] || 'jpg';
  const fileName = `foto_${Date.now()}.${extension}`;

  // Verifica duplicata por hash
  const hash = calculateHash(buffer);
  const isDuplicate = session.photoHashes.has(hash);

  if (isDuplicate) {
    session.duplicateCount++;
    console.log(`[${number}] Foto duplicada detectada (hash: ${hash.substring(0, 8)}...)`);
  }

  session.photoHashes.add(hash);
  session.photos.push({ buffer, fileName, hash, isDuplicate });

  // Configura lembrete
  setReminder(number, chat, session);

  // Cancela timer anterior de feedback (debounce)
  if (photoDebounce.has(number)) {
    clearTimeout(photoDebounce.get(number));
  }

  // Aguarda 5 segundos antes de enviar feedback (agrupa fotos)
  photoDebounce.set(number, setTimeout(async () => {
    photoDebounce.delete(number);
    await sendPhotoFeedback(number, chat, session);
  }, PHOTO_DEBOUNCE_TIME));
}

/**
 * Envia feedback apos receber foto(s) - com debounce
 */
async function sendPhotoFeedback(number, chat, session) {
  const hasMinPhotos = session.photos.length >= config.minPhotosPerBatch;
  const hasLegend = !!session.legend;

  if (hasMinPhotos && hasLegend) {
    session.state = STATE.READY_TO_SEND;
    clearTimers(number);

    await chat.sendMessage(
      `*RESUMO DO LOTE:*\n\n` +
      `Fotos: *${session.photos.length}*\n` +
      `AS: *${session.legend}*`
    );
    await delay(MESSAGE_DELAY);

    await sendYesNo(chat, `FINALIZAR AS: *${session.legend}*?`);
    setTimeout5min(number, chat, () => doSend(number, chat, session));
    saveSessionsToFile();

  } else {
    // Feedback do progresso
    const remaining = Math.max(0, config.minPhotosPerBatch - session.photos.length);

    const count = session.photos.length;
    let msg = `*${count}* foto${count > 1 ? 's' : ''} recebida${count > 1 ? 's' : ''}!\n`;

    if (remaining > 0) {
      msg += `\n*FALTAM ${remaining} FOTO(S)*`;
    }
    if (!hasLegend) {
      msg += `\n*ENVIE O NUMERO DA AS*`;
    }

    await chat.sendMessage(msg);
  }
}

/**
 * Processa texto/comandos
 */
async function handleText(message, number, chat, session) {
  const text = message.body.trim();
  const textUpper = text.toUpperCase();

  // LOG para debug
  console.log(`[${number}] Estado: ${session.state} | Texto: "${text}"`);

  // Respostas SIM/NAO
  const isYes = ['S', 'SIM', 'SS', 'SI', 'SIMMM', 'SIN'].includes(textUpper);
  const isNo = ['N', 'NAO', 'NÃO', 'NN', 'NO', 'NAOO'].includes(textUpper);

  // DESEJA ENVIAR? (S/N)
  if (session.state === STATE.READY_TO_SEND) {
    if (isYes) {
      await doSend(number, chat, session);
      return;
    }
    if (isNo) {
      session.state = STATE.ADDING_MORE;
      await sendYesNo(chat, 'Deseja adicionar mais fotos?');
      return;
    }
  }

  // DESEJA ADICIONAR MAIS FOTOS? (S/N)
  if (session.state === STATE.ADDING_MORE) {
    if (isYes) {
      session.state = STATE.COLLECTING;
      await chat.sendMessage(`Ok! Envie mais *FOTOS*`);
      setReminder(number, chat, session);
      return;
    }
    if (isNo) {
      clearTimers(number);
      cleanupTempPhotos(number);
      sessions.delete(number);
      saveSessionsToFile();
      await chat.sendMessage(`Lote cancelado. Até mais!`);
      return;
    }
  }

  // DESEJA ENVIAR OUTRA AS? (S/N)
  if (session.state === STATE.WAITING_ACTION) {
    if (isYes) {
      session.state = STATE.COLLECTING;
      session.photos = [];
      session.legend = null;
      await chat.sendMessage(`*ENVIE AS FOTOS (MINIMO ${config.minPhotosPerBatch}) E O NUMERO DA AS*`);
      return;
    }
    if (isNo) {
      clearTimers(number);
      sessions.delete(number);
      await chat.sendMessage(`Finalizado. Até mais!`);
      return;
    }
  }

  // DESEJA CONTINUAR? (apos reinicio do bot)
  if (session.state === STATE.RECOVERING) {
    if (isYes) {
      // Continua de onde parou
      const hasMinPhotos = session.photos.length >= config.minPhotosPerBatch;
      const hasLegend = !!session.legend;

      if (hasMinPhotos && hasLegend) {
        session.state = STATE.READY_TO_SEND;
        await chat.sendMessage(
          `*RESUMO DO LOTE:*\n\n` +
          `Fotos: *${session.photos.length}*\n` +
          `AS: *${session.legend}*`
        );
        await sendYesNo(chat, `FINALIZAR AS: *${session.legend}*?`);
        setTimeout5min(number, chat, () => doSend(number, chat, session));
      } else {
        session.state = STATE.COLLECTING;
        let msg = 'Continuando...\n';
        if (!hasLegend) msg += '\nEnvie o *NUMERO DA AS*';
        if (!hasMinPhotos) msg += `\n*FALTAM ${config.minPhotosPerBatch - session.photos.length} FOTO(S)*`;
        await chat.sendMessage(msg);
        setReminder(number, chat, session);
      }
      return;
    }
    if (isNo) {
      clearTimers(number);
      cleanupTempPhotos(number);
      sessions.delete(number);
      await chat.sendMessage(`Lote descartado. Até mais!`);
      return;
    }
  }

  // Cumprimento
  if (isGreeting(text) && session.state === STATE.IDLE) {
    session.state = STATE.COLLECTING;
    session.photos = [];
    session.legend = null;

    await chat.sendMessage(
      `Envie:\n- Mínimo *${config.minPhotosPerBatch} FOTOS*\n- *NUMERO DA AS*\n\n${getGreeting()}!`
    );
    setReminder(number, chat, session);
    return;
  }

  // TEM CERTEZA DESTE NUMERO DE AS? (confirmacao)
  if (session.state === STATE.CONFIRMING_AS) {
    if (isYes) {
      // Confirma a AS pendente
      session.legend = session.pendingLegend;
      session.pendingLegend = null;
      await chat.sendMessage(`AS *${session.legend}* registrada!`);

      // Verifica se pode enviar
      if (session.photos.length >= config.minPhotosPerBatch) {
        session.state = STATE.READY_TO_SEND;
        clearTimers(number);
        await chat.sendMessage(
          `*RESUMO DO LOTE:*\n\n` +
          `Fotos: *${session.photos.length}*\n` +
          `AS: *${session.legend}*`
        );
        await sendYesNo(chat, `FINALIZAR AS: *${session.legend}*?`);
        setTimeout5min(number, chat, () => doSend(number, chat, session));
        saveSessionsToFile();
      } else {
        session.state = STATE.COLLECTING;
        setReminder(number, chat, session);
      }
      return;
    }
    if (isNo) {
      session.pendingLegend = null;
      session.state = STATE.COLLECTING;
      await chat.sendMessage(`Ok! Envie o *NUMERO DA AS* correto`);
      return;
    }
  }

  // Verifica se e uma AS
  const validation = validateLegend(text);

  // Mostra erros especificos de AS
  if (!validation.valid && validation.reason !== 'NAO_NUMERICO' && validation.reason !== 'VAZIO') {
    if (validation.reason === 'FALTAM_DIGITOS') {
      await chat.sendMessage(`Numero da AS inválido.\n*FALTAM ${validation.faltam} DIGITOS*`);
      return;
    }
    if (validation.reason === 'MUITOS_DIGITOS') {
      await chat.sendMessage(`Numero da AS inválido.\n*DEVE TER 10 DIGITOS*`);
      return;
    }
    if (validation.reason === 'NAO_COMECA_202') {
      await chat.sendMessage(`Numero da AS inválido.\n*DEVE COMECAR COM 202*`);
      return;
    }
  }

  if (validation.valid) {
    if (session.state === STATE.IDLE) {
      session.state = STATE.COLLECTING;
      session.photos = [];
    }

    if (session.legend && session.legend !== validation.code) {
      await chat.sendMessage(`AS diferente do lote atual (*${session.legend}*)`);
      return;
    }

    // Se precisa confirmacao (nao e 2025 ou 2026)
    if (validation.needsConfirmation) {
      session.pendingLegend = validation.code;
      session.state = STATE.CONFIRMING_AS;
      await sendYesNo(chat, `Tem certeza deste numero de AS?\n*${validation.code}*`);
      return;
    }

    // AS valida (2025 ou 2026)
    session.legend = validation.code;
    await chat.sendMessage(`AS *${validation.code}* registrada!`);

    // Verifica se pode enviar
    if (session.photos.length >= config.minPhotosPerBatch) {
      session.state = STATE.READY_TO_SEND;
      clearTimers(number);

      await chat.sendMessage(
        `*RESUMO DO LOTE:*\n\n` +
        `Fotos: *${session.photos.length}*\n` +
        `AS: *${session.legend}*`
      );

      await sendYesNo(chat, `FINALIZAR AS: *${session.legend}*?`);
      setTimeout5min(number, chat, () => doSend(number, chat, session));
      saveSessionsToFile();
    } else {
      setReminder(number, chat, session);
    }
    return;
  }

  // Comando SAIR
  if (textUpper === 'SAIR') {
    if (session.state !== STATE.IDLE) {
      const count = session.photos.length;
      clearTimers(number);
      cleanupTempPhotos(number);
      sessions.delete(number);
      saveSessionsToFile();
      await chat.sendMessage(`Lote cancelado. *${count} foto(s)* descartadas.`);
    } else {
      await chat.sendMessage(`Nenhum lote ativo.`);
    }
    return;
  }

  // Comando STATUS
  if (textUpper === 'STATUS') {
    if (session.state === STATE.IDLE) {
      await chat.sendMessage(`Nenhum lote ativo.\nEnvie *OI* para começar.`);
    } else {
      const remaining = Math.max(0, config.minPhotosPerBatch - session.photos.length);
      await chat.sendMessage(
        `*STATUS*\n\n` +
        `Fotos: *${session.photos.length}*\n` +
        `AS: *${session.legend || 'pendente'}*\n` +
        `Faltam: *${remaining > 0 ? remaining + ' foto(s)' : 'completo'}*`
      );
    }
    return;
  }

  // Comando AJUDA
  if (textUpper === 'AJUDA' || textUpper === 'HELP') {
    await chat.sendMessage(
      `*COMO USAR*\n\n` +
      `1. Envie *OI* ou *BOM DIA*\n` +
      `2. Envie as *FOTOS* (mínimo ${config.minPhotosPerBatch})\n` +
      `3. Envie o *NUMERO DA AS*\n` +
      `4. Confirme o envio\n\n` +
      `Comandos: *STATUS*, *SAIR*`
    );
    return;
  }

  // Se esta coletando e recebeu texto desconhecido
  if (session.state === STATE.COLLECTING && session.photos.length === 0) {
    // Assume que quer comecar
    await chat.sendMessage(
      `Envie:\n- Mínimo *${config.minPhotosPerBatch} FOTOS*\n- *NUMERO DA AS*\n\n${getGreeting()}!`
    );
    setReminder(number, chat, session);
  }
}

/**
 * Processa resposta de enquete
 */
async function handlePollResponse(message) {
  try {
    const contact = await message.getContact();
    const number = contact.number;
    const chat = await message.getChat();
    const session = getSession(number);

    // Verifica qual opcao foi selecionada
    const selectedOption = message.body?.toLowerCase() || '';

    if (session.state === STATE.READY_TO_SEND) {
      if (selectedOption.includes('sim') || selectedOption.includes('enviar')) {
        await doSend(number, chat, session);
      } else if (selectedOption.includes('adicionar') || selectedOption.includes('mais')) {
        session.state = STATE.COLLECTING;
        await chat.sendMessage(`Ok! Envie mais *FOTOS*`);
        setReminder(number, chat, session);
      }
    }

    if (session.state === STATE.WAITING_ACTION) {
      if (selectedOption.includes('outra') || selectedOption.includes('nova')) {
        session.state = STATE.COLLECTING;
        session.photos = [];
        session.legend = null;
        await chat.sendMessage(`Envie as *FOTOS* e o *NUMERO DA AS*`);
      } else if (selectedOption.includes('finalizar') || selectedOption.includes('fim')) {
        clearTimers(number);
        sessions.delete(number);
      }
    }
  } catch (error) {
    console.error('Erro ao processar poll:', error.message);
  }
}

/**
 * Executa o envio do lote
 */
async function doSend(number, chat, session) {
  clearTimers(number);

  await chat.sendMessage(`Salvando *${session.photos.length} fotos*...`);

  // Salva localmente
  const result = saveBatch(session.photos, session.collaboratorName, session.legend);

  if (result.failed === 0) {
    session.todayCount += session.photos.length;

    // Envia para grupo de supervisores
    if (config.supervisorGroup) {
      const supervisorResult = await sendToSupervisors(session);
      if (!supervisorResult.success) {
        console.log(`Falha ao enviar para supervisores: ${supervisorResult.reason}`);
      }
    }

    await chat.sendMessage(`AS *${session.legend}* enviada com sucesso! ✅`);
    await delay(MESSAGE_DELAY);

    // Log com informacao de duplicatas
    const logData = {
      type: 'batch_complete',
      message: `AS ${session.legend} - ${session.collaboratorName}`,
      photoCount: session.photos.length,
      collaborator: session.collaboratorName
    };

    if (session.duplicateCount > 0) {
      logData.duplicates = session.duplicateCount;
      logData.message += ` (${session.duplicateCount} foto(s) duplicada(s))`;
      console.log(`[${number}] Lote com ${session.duplicateCount} foto(s) duplicada(s)`);
    }

    logActivity(logData);

    // Limpa lote atual e arquivos temporarios
    cleanupTempPhotos(number);
    session.photos = [];
    session.photoHashes = new Set();
    session.duplicateCount = 0;
    session.legend = null;
    session.state = STATE.WAITING_ACTION;

    // Pergunta se quer enviar outra
    await sendYesNo(chat, 'Deseja enviar *OUTRO* *NÚMERO* de AS?');
    setTimeout5min(number, chat);
    saveSessionsToFile();

  } else {
    await chat.sendMessage(`Erro ao salvar: *${result.failed} falha(s)*\nTente novamente.`);
    session.state = STATE.READY_TO_SEND;
  }
}

function getClient() {
  return client;
}

module.exports = {
  initialize,
  getClient
};
