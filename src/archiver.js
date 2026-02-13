import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';
import { CONFIG } from './config.js';
import { initAlerts, stopAlerts, addAlert } from './alerts.js';
import {
  saveTextMessage,
  saveMedia,
  saveBufferedMedia,
  saveBufferedMediaNoLabel,
  extractProtocolo,
  sanitizarNomeGrupo,
} from './storage.js';

// Grupos monitorados: Map<groupId, groupName>
const monitoredGroups = new Map();

// Buffer de mídia pendente: Map<"groupId:authorId", { items[], timer, groupName, authorName }>
const pendingBuffer = new Map();

let client = null;

export async function startArchiver() {
  client = new Client({
    authStrategy: new LocalAuth({
      dataPath: CONFIG.sessionDir,
    }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
      ],
      ...(process.platform === 'linux' && { executablePath: '/usr/bin/chromium-browser' }),
    },
  });

  // QR Code
  client.on('qr', (qr) => {
    console.log('\n  Escaneie o QR Code abaixo com seu WhatsApp:\n');
    qrcode.generate(qr, { small: true });
  });

  client.on('authenticated', () => {
    console.log('  Autenticado com sucesso!');
  });

  client.on('auth_failure', (msg) => {
    console.error('  Falha na autenticação:', msg);
    process.exit(1);
  });

  // Ready
  client.on('ready', async () => {
    console.log('  Bot conectado e pronto!\n');

    // Inicializa alertas com o client
    initAlerts(client);

    // Encontra os grupos configurados
    await findGroups();

    console.log('\n  Monitorando mensagens... (Ctrl+C para parar)\n');
  });

  // Listener de mensagens
  client.on('message_create', async (msg) => {
    try {
      await handleMessage(msg);
    } catch (err) {
      console.error('  Erro ao processar mensagem:', err.message);
    }
  });

  client.on('disconnected', (reason) => {
    console.log('  Desconectado:', reason);
    stopAlerts();
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n  Encerrando...');
    // Salva todos os buffers pendentes
    await flushAllBuffers();
    stopAlerts();
    await client.destroy();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('  Iniciando WhatsApp Archiver...\n');
  await client.initialize();
}

// ============================================
// ENCONTRAR GRUPOS
// ============================================

async function findGroups() {
  const chats = await client.getChats();
  const configuredNames = CONFIG.groups.map(g => g.toLowerCase());

  console.log('  Procurando grupos configurados...');

  for (const chat of chats) {
    if (chat.isGroup) {
      const nameLC = chat.name.trim().toLowerCase();
      if (configuredNames.includes(nameLC)) {
        monitoredGroups.set(chat.id._serialized, chat.name);
        console.log(`    + "${chat.name}" encontrado`);
      }
    }
  }

  // Verifica quais não foram encontrados
  const foundNames = [...monitoredGroups.values()].map(n => n.trim().toLowerCase());
  for (const name of CONFIG.groups) {
    if (!foundNames.includes(name.toLowerCase())) {
      console.log(`    - "${name}" NÃO encontrado!`);
      await addAlert('grupo_nao_encontrado', `Grupo "${name}" não encontrado. Verifique se você é membro e o nome está correto.`);
    }
  }

  console.log(`\n  ${monitoredGroups.size}/${CONFIG.groups.length} grupo(s) monitorado(s)`);
}

// ============================================
// HANDLER DE MENSAGENS
// ============================================

async function handleMessage(msg) {
  const chatId = msg.from;

  // Só processa mensagens dos grupos monitorados
  if (!monitoredGroups.has(chatId)) return;

  const groupName = monitoredGroups.get(chatId);
  const contact = await msg.getContact();
  const author = contact.pushname || contact.name || msg.author || 'desconhecido';
  const timestamp = new Date(msg.timestamp * 1000);

  // Verifica tipo da mensagem
  if (msg.hasMedia) {
    await handleMediaMessage(msg, groupName, author, chatId, timestamp);
  } else if (msg.body) {
    await handleTextMessage(msg, groupName, author, chatId, timestamp);
  }
}

// ============================================
// MENSAGEM DE TEXTO
// ============================================

async function handleTextMessage(msg, groupName, author, chatId, timestamp) {
  const text = msg.body;

  // Salva no log JSONL
  saveTextMessage(groupName, author, text, timestamp);

  // Verifica se é um protocolo (10 dígitos)
  const protocolo = extractProtocolo(text);
  if (protocolo) {
    // Tenta associar com mídias no buffer
    const bufferKey = `${chatId}:${msg.author || author}`;
    const pending = pendingBuffer.get(bufferKey);

    if (pending && pending.items.length > 0) {
      // Limpa timer
      if (pending.timer) clearTimeout(pending.timer);
      pendingBuffer.delete(bufferKey);

      console.log(`  [${groupName}] ${author}: protocolo ${protocolo} associado a ${pending.items.length} mídia(s) do buffer`);
      await saveBufferedMedia(groupName, author, pending.items, protocolo, timestamp);
      return;
    }
  }

  console.log(`  [${groupName}] ${author}: ${text.slice(0, 80)}${text.length > 80 ? '...' : ''}`);
}

// ============================================
// MENSAGEM DE MÍDIA
// ============================================

async function handleMediaMessage(msg, groupName, author, chatId, timestamp) {
  // Verifica se é tipo aceito
  const type = msg.type;
  if (CONFIG.ignoredTypes.includes(type)) {
    return; // Ignora áudio, documento, sticker
  }

  // Baixa a mídia
  let media;
  try {
    media = await msg.downloadMedia();
  } catch (err) {
    console.error(`  [${groupName}] Erro ao baixar mídia de ${author}:`, err.message);
    return;
  }

  if (!media) {
    console.log(`  [${groupName}] Mídia indisponível de ${author}`);
    return;
  }

  const caption = msg.body || '';
  const protocolo = extractProtocolo(caption);

  if (protocolo) {
    // Tem protocolo na caption — salva direto
    console.log(`  [${groupName}] ${author}: mídia com protocolo ${protocolo}`);
    await saveMedia(groupName, author, media.data, media.mimetype, caption, timestamp);
  } else {
    // Sem protocolo na caption — vai pro buffer
    const bufferKey = `${chatId}:${msg.author || author}`;
    let pending = pendingBuffer.get(bufferKey);

    if (!pending) {
      pending = {
        items: [],
        timer: null,
        groupName,
        authorName: author,
      };
      pendingBuffer.set(bufferKey, pending);
    }

    // Reseta timer a cada nova mídia
    if (pending.timer) clearTimeout(pending.timer);

    pending.items.push({
      mediaData: media.data,
      mimetype: media.mimetype,
      caption,
      timestamp,
    });

    console.log(`  [${groupName}] ${author}: mídia sem legenda → buffer (${pending.items.length} item(s), aguardando ${CONFIG.bufferTimeoutMs / 1000}s)`);

    // Timer de timeout
    pending.timer = setTimeout(async () => {
      const p = pendingBuffer.get(bufferKey);
      if (p && p.items.length > 0) {
        pendingBuffer.delete(bufferKey);
        console.log(`  [${groupName}] ${author}: timeout do buffer → sem_legenda/`);
        await saveBufferedMediaNoLabel(groupName, author, p.items);
      }
    }, CONFIG.bufferTimeoutMs);
  }
}

// ============================================
// FLUSH BUFFERS (shutdown)
// ============================================

async function flushAllBuffers() {
  for (const [key, pending] of pendingBuffer.entries()) {
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.items.length > 0) {
      console.log(`  Salvando ${pending.items.length} mídia(s) pendentes de ${pending.authorName}...`);
      await saveBufferedMediaNoLabel(pending.groupName, pending.authorName, pending.items);
    }
  }
  pendingBuffer.clear();
}
