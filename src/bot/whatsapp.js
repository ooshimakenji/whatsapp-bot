const { Client, LocalAuth, Poll, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const config = require('../config');
const { validateLegend, isNumberAllowed } = require('../services/validator');
const { saveBatch, getPhotosFolder } = require('../services/storage');
const { logActivity } = require('../services/email');

// Sessoes ativas por usuario
const sessions = new Map();

// Cache do grupo de supervisores
let supervisorChat = null;

// Timers de lembrete e timeout
const reminders = new Map();
const timeouts = new Map();

// Constantes de tempo
const REMINDER_TIME = 2 * 60 * 1000;  // 2 minutos
const TIMEOUT_TIME = 5 * 60 * 1000;   // 5 minutos

// Estados da sessao
const STATE = {
  IDLE: 'idle',
  COLLECTING: 'collecting',
  READY_TO_SEND: 'ready_to_send',
  WAITING_ACTION: 'waiting_action'
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
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

/**
 * Retorna cumprimento baseado no horario
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return 'Bom dia';
  if (hour >= 12 && hour < 18) return 'Boa tarde';
  return 'Boa noite';
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
 * Cria ou obtem sessao do usuario
 */
function getSession(number) {
  if (!sessions.has(number)) {
    sessions.set(number, {
      state: STATE.IDLE,
      photos: [],
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
        await chat.sendMessage(`Faltam ${missing} foto(s) para completar o envio.`);
      } else if (!session.legend) {
        await chat.sendMessage(`Falta informar a AS (formato 202XXXXXXX).`);
      }
    }
  }, REMINDER_TIME));
}

/**
 * Configura timeout de 5 minutos
 */
function setTimeout5min(number, chat) {
  clearTimers(number);

  timeouts.set(number, setTimeout(() => {
    const session = sessions.get(number);
    if (session && session.state !== STATE.IDLE) {
      console.log(`Sessao expirada: ${number}`);
      sessions.delete(number);
      clearTimers(number);
    }
  }, TIMEOUT_TIME));
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
 * Envia enquete
 */
async function sendPoll(chat, title, options) {
  try {
    // Tenta enviar poll nativo
    await chat.sendMessage(new Poll(title, options));
    return true;
  } catch (error) {
    // Fallback: envia como texto formatado
    const optionsText = options.map((opt, i) => `${i + 1}. ${opt}`).join('\n');
    await chat.sendMessage(`${title}\n\n${optionsText}\n\n_Digite o numero da opcao._`);
    return false;
  }
}

/**
 * Inicializa o bot
 */
function initialize() {
  client.on('qr', (qr) => {
    console.log('\nEscaneie o QR Code:');
    qrcode.generate(qr, { small: true });
  });

  client.on('ready', async () => {
    console.log('\nBot conectado e pronto.');
    console.log(`Pasta de fotos: ${getPhotosFolder()}`);

    // Busca grupo de supervisores
    if (config.supervisorGroup) {
      console.log(`Buscando grupo: ${config.supervisorGroup}...`);
      await findSupervisorGroup();
    }
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

  // Listener para respostas de enquete
  client.on('message_create', async (message) => {
    if (message.fromMe) return;

    // Processa votos em enquetes
    if (message.type === 'poll_response') {
      await handlePollResponse(message);
    }
  });

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
    session.legend = null;
  }

  // Se estava esperando acao pos-envio, inicia novo lote
  if (session.state === STATE.WAITING_ACTION) {
    session.state = STATE.COLLECTING;
    session.photos = [];
    session.legend = null;
  }

  const caption = message.body || '';

  // Verifica legenda na foto
  if (caption.trim()) {
    const validation = validateLegend(caption);
    if (validation.valid) {
      if (session.legend && session.legend !== validation.code) {
        await chat.sendMessage(`AS diferente do lote atual (${session.legend}).`);
        return;
      }
      session.legend = validation.code;
    }
  }

  // Baixa foto
  const media = await message.downloadMedia();
  if (!media) {
    await chat.sendMessage('Erro ao baixar foto. Reenvie.');
    return;
  }

  const buffer = Buffer.from(media.data, 'base64');
  const extension = media.mimetype.split('/')[1] || 'jpg';
  const fileName = `foto_${Date.now()}.${extension}`;

  session.photos.push({ buffer, fileName });

  // Configura lembrete
  setReminder(number, chat, session);

  // Verifica se lote esta completo
  const hasMinPhotos = session.photos.length >= config.minPhotosPerBatch;
  const hasLegend = !!session.legend;

  if (hasMinPhotos && hasLegend) {
    session.state = STATE.READY_TO_SEND;
    clearTimers(number);

    await chat.sendMessage(
      `*Resumo do lote:*\n` +
      `- Fotos: ${session.photos.length}\n` +
      `- AS: ${session.legend}`
    );

    await sendPoll(chat, 'Deseja enviar?', ['Sim, enviar', 'Adicionar mais fotos']);
    setTimeout5min(number, chat);

  } else {
    // Feedback do progresso
    const remaining = config.minPhotosPerBatch - session.photos.length;
    let status = `Foto ${session.photos.length} recebida.`;

    if (remaining > 0) {
      status += ` Faltam ${remaining}.`;
    }
    if (!hasLegend) {
      status += ` AS pendente.`;
    }

    await chat.sendMessage(status);
  }
}

/**
 * Processa texto/comandos
 */
async function handleText(message, number, chat, session) {
  const text = message.body.trim();
  const textUpper = text.toUpperCase();

  // Verifica resposta numerica (fallback de enquete)
  if (session.state === STATE.READY_TO_SEND) {
    if (textUpper === '1' || textUpper === 'SIM' || textUpper === 'ENVIAR') {
      await doSend(number, chat, session);
      return;
    }
    if (textUpper === '2' || textUpper === 'ADICIONAR' || textUpper === 'MAIS') {
      session.state = STATE.COLLECTING;
      await chat.sendMessage('Ok, envie mais fotos.');
      setReminder(number, chat, session);
      return;
    }
  }

  if (session.state === STATE.WAITING_ACTION) {
    if (textUpper === '1' || textUpper === 'OUTRA' || textUpper === 'NOVA') {
      session.state = STATE.COLLECTING;
      session.photos = [];
      session.legend = null;
      await chat.sendMessage(`${getGreeting()}! Envie as fotos (min ${config.minPhotosPerBatch}) e a AS.`);
      return;
    }
    if (textUpper === '2' || textUpper === 'FINALIZAR' || textUpper === 'FIM') {
      clearTimers(number);
      sessions.delete(number);
      return;
    }
  }

  // Cumprimento
  if (isGreeting(text) && session.state === STATE.IDLE) {
    session.state = STATE.COLLECTING;
    session.photos = [];
    session.legend = null;

    await chat.sendMessage(
      `${getGreeting()}! Envie as fotos (minimo ${config.minPhotosPerBatch}) e a AS (formato 202XXXXXXX).`
    );
    setReminder(number, chat, session);
    return;
  }

  // Verifica se e uma AS
  const validation = validateLegend(text);
  if (validation.valid) {
    if (session.state === STATE.IDLE) {
      session.state = STATE.COLLECTING;
      session.photos = [];
    }

    if (session.legend && session.legend !== validation.code) {
      await chat.sendMessage(`AS diferente do lote atual (${session.legend}).`);
      return;
    }

    session.legend = validation.code;
    await chat.sendMessage(`AS ${validation.code} registrada.`);

    // Verifica se pode enviar
    if (session.photos.length >= config.minPhotosPerBatch) {
      session.state = STATE.READY_TO_SEND;
      clearTimers(number);

      await chat.sendMessage(
        `*Resumo do lote:*\n` +
        `- Fotos: ${session.photos.length}\n` +
        `- AS: ${session.legend}`
      );

      await sendPoll(chat, 'Deseja enviar?', ['Sim, enviar', 'Adicionar mais fotos']);
      setTimeout5min(number, chat);
    } else {
      setReminder(number, chat, session);
    }
    return;
  }

  // Comando CANCELAR
  if (textUpper === 'CANCELAR') {
    if (session.state !== STATE.IDLE) {
      const count = session.photos.length;
      clearTimers(number);
      sessions.delete(number);
      await chat.sendMessage(`Lote cancelado. ${count} foto(s) descartadas.`);
    } else {
      await chat.sendMessage('Nenhum lote ativo.');
    }
    return;
  }

  // Comando STATUS
  if (textUpper === 'STATUS') {
    if (session.state === STATE.IDLE) {
      await chat.sendMessage('Nenhum lote ativo. Envie um oi para comecar.');
    } else {
      const remaining = Math.max(0, config.minPhotosPerBatch - session.photos.length);
      await chat.sendMessage(
        `*Status:*\n` +
        `- Fotos: ${session.photos.length}\n` +
        `- AS: ${session.legend || 'pendente'}\n` +
        `- Faltam: ${remaining > 0 ? remaining + ' foto(s)' : 'completo'}`
      );
    }
    return;
  }

  // Comando AJUDA
  if (textUpper === 'AJUDA' || textUpper === 'HELP') {
    await chat.sendMessage(
      `*Como usar:*\n` +
      `1. Envie "Oi" ou "Bom dia"\n` +
      `2. Envie as fotos (min ${config.minPhotosPerBatch})\n` +
      `3. Envie a AS (202XXXXXXX)\n` +
      `4. Confirme o envio\n\n` +
      `Comandos: STATUS, CANCELAR`
    );
    return;
  }

  // Se esta coletando e recebeu texto desconhecido
  if (session.state === STATE.COLLECTING && session.photos.length === 0) {
    // Assume que quer comecar
    await chat.sendMessage(
      `${getGreeting()}! Envie as fotos (minimo ${config.minPhotosPerBatch}) e a AS (formato 202XXXXXXX).`
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
        await chat.sendMessage('Ok, envie mais fotos.');
        setReminder(number, chat, session);
      }
    }

    if (session.state === STATE.WAITING_ACTION) {
      if (selectedOption.includes('outra') || selectedOption.includes('nova')) {
        session.state = STATE.COLLECTING;
        session.photos = [];
        session.legend = null;
        await chat.sendMessage(`Envie as fotos e a AS.`);
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

  await chat.sendMessage(`Salvando ${session.photos.length} fotos...`);

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

    await chat.sendMessage(`AS ${session.legend} enviada com sucesso!`);

    logActivity({
      type: 'batch_complete',
      message: `AS ${session.legend} - ${session.collaboratorName}`,
      photoCount: session.photos.length,
      collaborator: session.collaboratorName
    });

    // Limpa lote atual
    const photosCopy = [...session.photos]; // Guarda copia antes de limpar
    session.photos = [];
    session.legend = null;
    session.state = STATE.WAITING_ACTION;

    // Enquete pos-envio
    await sendPoll(chat, 'O que deseja fazer?', ['Enviar outra AS', 'Finalizar']);
    setTimeout5min(number, chat);

  } else {
    await chat.sendMessage(`Erro ao salvar: ${result.failed} falha(s). Tente novamente.`);
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
