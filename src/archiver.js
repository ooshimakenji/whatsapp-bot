import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';
import { CONFIG } from './config.js';
import { initAlerts, stopAlerts, addAlert } from './alerts.js';
import {
  saveTextMessage,
  saveBufferedBlock,
  extractProtocolo,
  extractAllProtocolos,
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

  console.log('  Iniciando WhatsApp Bila Organizer...\n');
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
      // Reseta timer — texto com protocolo faz parte do bloco
      if (pending.timer) clearTimeout(pending.timer);
      pending.protocolos.add(protocolo);

      console.log(`  [${groupName}] ${author}: protocolo ${protocolo} adicionado ao bloco (${pending.items.length} mídia(s))`);

      // Reinicia timer para aguardar mais mensagens do bloco
      pending.timer = setTimeout(() => flushBuffer(bufferKey), CONFIG.bufferTimeoutMs);
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
  const protocolosCaption = extractAllProtocolos(caption);

  // Toda mídia vai pro buffer do autor (com ou sem legenda)
  const bufferKey = `${chatId}:${msg.author || author}`;
  let pending = pendingBuffer.get(bufferKey);

  if (!pending) {
    pending = {
      items: [],
      protocolos: new Set(),
      timer: null,
      groupName,
      authorName: author,
    };
    pendingBuffer.set(bufferKey, pending);
  }

  // Reseta timer a cada nova mensagem
  if (pending.timer) clearTimeout(pending.timer);

  // Adiciona protocolos da caption ao bloco
  for (const proto of protocolosCaption) {
    pending.protocolos.add(proto);
  }

  pending.items.push({
    mediaData: media.data,
    mimetype: media.mimetype,
    caption,
    timestamp,
  });

  const protoInfo = protocolosCaption.length > 0
    ? `com protocolo ${protocolosCaption.join(', ')}`
    : 'sem legenda';
  console.log(`  [${groupName}] ${author}: mídia ${protoInfo} → buffer (${pending.items.length} item(s), aguardando ${CONFIG.bufferTimeoutMs / 1000}s)`);

  // Timer de timeout — quando o autor para de enviar, processa o bloco
  pending.timer = setTimeout(() => flushBuffer(bufferKey), CONFIG.bufferTimeoutMs);
}

// ============================================
// FLUSH BUFFER (processa bloco do autor)
// ============================================

async function flushBuffer(bufferKey) {
  const pending = pendingBuffer.get(bufferKey);
  if (!pending || pending.items.length === 0) return;

  if (pending.timer) clearTimeout(pending.timer);
  pendingBuffer.delete(bufferKey);

  const protocolos = [...pending.protocolos];
  console.log(`  [${pending.groupName}] ${pending.authorName}: processando bloco — ${pending.items.length} mídia(s), ${protocolos.length} protocolo(s)${protocolos.length > 0 ? ` (${protocolos.join(', ')})` : ''}`);

  await saveBufferedBlock(pending.groupName, pending.authorName, pending.items, protocolos);
}

// ============================================
// FLUSH ALL BUFFERS (shutdown)
// ============================================

async function flushAllBuffers() {
  for (const key of pendingBuffer.keys()) {
    await flushBuffer(key);
  }
  pendingBuffer.clear();
}
