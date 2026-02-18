import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';
import { CONFIG } from './config.js';
import { initAlerts, stopAlerts, addAlert } from './alerts.js';
import {
  saveTextMessage,
  saveBufferedBlock,
  extractProtocolo,
  extractAllProtocolos,
  sanitizarNomeGrupo,
  saveTempMedia,
  saveTempMeta,
  loadPersistentBuffers,
} from './storage.js';

// Grupos monitorados: Map<groupId, groupName>
const monitoredGroups = new Map();

// Buffer de mídia pendente: Map<"groupId:authorId", { items[], timer, groupName, authorName }>
const pendingBuffer = new Map();

// IDs de mensagens já processadas (deduplicação catch-up)
const processedIds = new Set();

let client = null;
let healthCheckInterval = null;
let isConnected = false;
let consecutiveFailures = 0;
const MAX_FAILURES = 3;
const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutos

// ============================================
// DEDUPLICAÇÃO DE MENSAGENS
// ============================================

function loadProcessedIds() {
  const logsDir = path.join(CONFIG.archiveDir, 'logs');
  if (!fs.existsSync(logsDir)) return;
  // Carrega hoje e ontem para cobrir reinícios à meia-noite
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  let count = 0;
  for (const date of [yesterday, today]) {
    const filePath = path.join(logsDir, `${date}_processed.txt`);
    if (!fs.existsSync(filePath)) continue;
    try {
      for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
        if (line.trim()) { processedIds.add(line.trim()); count++; }
      }
    } catch { /* ignora */ }
  }
  if (count > 0) console.log(`  [Dedup] ${count} ID(s) de mensagens já processadas carregados`);
}

function markAsProcessed(msgId) {
  if (!msgId || processedIds.has(msgId)) return;
  processedIds.add(msgId);
  try {
    const today = new Date().toISOString().slice(0, 10);
    const logsDir = path.join(CONFIG.archiveDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.appendFileSync(path.join(logsDir, `${today}_processed.txt`), msgId + '\n');
  } catch { /* best effort */ }
}

// ============================================
// LAST ACTIVE (catch-up inteligente)
// ============================================

function getLastActiveTime() {
  try {
    if (fs.existsSync(CONFIG.lastActiveFile)) {
      const ts = parseInt(fs.readFileSync(CONFIG.lastActiveFile, 'utf8').trim(), 10);
      if (!isNaN(ts)) return ts;
    }
  } catch {}
  return null;
}

function updateLastActive() {
  try {
    fs.mkdirSync(path.dirname(CONFIG.lastActiveFile), { recursive: true });
    fs.writeFileSync(CONFIG.lastActiveFile, Date.now().toString());
  } catch { /* best effort */ }
}

// ============================================
// HELPER: atualiza meta do buffer em disco
// ============================================

function updateTempMeta(bufferKey, pending) {
  if (pending.items.length === 0) return; // Sem itens = nada a persistir
  try {
    saveTempMeta(bufferKey, {
      bufferKey,
      groupName: pending.groupName,
      authorName: pending.authorName,
      protocolos: [...pending.protocolos],
      items: pending.items.map(i => ({
        filePath: i.filePath,
        mimetype: i.mimetype,
        caption: i.caption || '',
        timestamp: i.timestamp instanceof Date ? i.timestamp.toISOString() : i.timestamp,
      })),
    });
  } catch { /* best effort */ }
}

// ============================================
// RESTAURAR BUFFERS DO DISCO (crash recovery)
// ============================================

async function loadAndRestorePersistentBuffers() {
  const buffers = loadPersistentBuffers();
  if (buffers.length === 0) return;

  let restored = 0;
  for (const { meta } of buffers) {
    const { bufferKey, groupName, authorName, protocolos, items } = meta;

    const validItems = items.filter(i => i.filePath && fs.existsSync(i.filePath));
    if (validItems.length === 0) continue;

    const pending = {
      items: validItems.map(i => ({
        filePath: i.filePath,
        mimetype: i.mimetype,
        caption: i.caption || '',
        timestamp: new Date(i.timestamp),
      })),
      protocolos: new Set(protocolos || []),
      timer: null,
      groupName,
      authorName,
    };

    pendingBuffer.set(bufferKey, pending);
    // Timer: catch-up pode adicionar protocolos dentro dessa janela
    pending.timer = setTimeout(() => flushBuffer(bufferKey), CONFIG.bufferTimeoutMs);

    const protoInfo = protocolos?.length > 0 ? `, protocolo(s): ${protocolos.join(', ')}` : '';
    console.log(`  [Buffer] Restaurado: ${authorName} (${groupName}) — ${validItems.length} mídia(s)${protoInfo}`);
    restored++;
  }

  if (restored > 0) {
    await addAlert('info', `🔄 ${restored} buffer(s) de mídia recuperado(s) após reinício.`);
  }
}

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
        '--disable-software-rasterizer',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--no-first-run',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
        '--js-flags=--max-old-space-size=256',
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
    isConnected = true;
    consecutiveFailures = 0;

    // Reseta contador de crashes (conexão OK)
    const restartFile = CONFIG.sessionDir.replace(/[/\\]session$/, '') + '/.restart_count';
    try { fs.unlinkSync(restartFile); } catch (e) { /* ignora */ }

    // Carrega IDs já processados hoje (deduplicação)
    loadProcessedIds();

    // Lê horário da última atividade antes de atualizar
    const lastActive = getLastActiveTime();
    updateLastActive();

    // Inicializa alertas com o client
    await initAlerts(client);
    await addAlert('info', 'Bot iniciado com sucesso!');

    // Restaura buffers de mídia pendentes do disco (crash recovery)
    await loadAndRestorePersistentBuffers();

    // Encontra os grupos configurados
    await findGroups();

    // Busca mensagens perdidas durante offline (janela ajustada ao downtime real)
    await catchUpMissedMessages(lastActive);

    // Inicia health check periódico
    startHealthCheck();

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
    isConnected = false;
    stopAlerts();
    stopHealthCheck();
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n  Encerrando...');
    updateLastActive(); // Registra momento do shutdown para o próximo startup calcular downtime
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
// CATCH-UP DE MENSAGENS PERDIDAS
// ============================================

async function catchUpMissedMessages(lastActiveTime = null) {
  let hours = CONFIG.catchupHours;

  if (lastActiveTime) {
    const downtimeMs = Date.now() - lastActiveTime;
    const downtimeMin = Math.round(downtimeMs / 60000);

    if (downtimeMin >= 5) {
      const downtimeHours = downtimeMs / (1000 * 60 * 60);
      const downtimeStr = downtimeMin < 60
        ? `${downtimeMin} min`
        : `${downtimeHours.toFixed(1)}h`;
      const lastStr = new Date(lastActiveTime).toLocaleString('pt-BR');

      console.log(`  [Catch-up] Bot estava offline desde ${lastStr} (${downtimeStr})`);

      // Janela = downtime + 30min de margem, entre mínimo padrão e máximo configurado
      hours = Math.max(
        CONFIG.catchupHours,
        Math.min(downtimeHours + 0.5, CONFIG.maxCatchupHours)
      );

      await addAlert('info', `⏰ Retomada após ${downtimeStr} offline (desde ${lastStr}). Buscando últimas ${hours.toFixed(1)}h...`);
    }
  }

  const cutoff = Date.now() - (hours * 60 * 60 * 1000);
  const fetchLimit = Math.min(Math.max(50, Math.ceil(hours * 50)), 500);
  let totalProcessed = 0;

  console.log(`  [Catch-up] Buscando mensagens das últimas ${hours.toFixed(1)}h...`);

  for (const [groupId, groupName] of monitoredGroups) {
    try {
      const chat = await client.getChatById(groupId);
      const messages = await chat.fetchMessages({ limit: fetchLimit });

      // Filtra mensagens dentro da janela de catch-up
      const missed = messages.filter(msg => {
        const msgTime = msg.timestamp * 1000;
        return msgTime >= cutoff;
      });

      if (missed.length === 0) continue;

      console.log(`  [Catch-up] ${groupName}: ${missed.length} mensagem(ns) na última hora`);

      for (const msg of missed) {
        try {
          await handleMessage(msg);
          totalProcessed++;
        } catch (err) {
          console.error(`  [Catch-up] Erro ao processar mensagem em ${groupName}:`, err.message);
        }
      }
    } catch (err) {
      console.error(`  [Catch-up] Erro ao buscar mensagens de ${groupName}:`, err.message);
    }
  }

  if (totalProcessed > 0) {
    console.log(`  [Catch-up] ${totalProcessed} mensagem(ns) processada(s)`);
    await addAlert('info', `Catch-up: ${totalProcessed} mensagem(ns) da última hora processada(s)`);
  } else {
    console.log('  [Catch-up] Nenhuma mensagem perdida encontrada');
  }
}

// ============================================
// HEALTH CHECK
// ============================================

function startHealthCheck() {
  stopHealthCheck();
  healthCheckInterval = setInterval(async () => {
    try {
      const state = await client.getState();
      if (state === 'CONNECTED') {
        if (!isConnected) {
          console.log(`  [Health Check] Reconectado!`);
        }
        isConnected = true;
        consecutiveFailures = 0;
        updateLastActive(); // Mantém registro de última atividade confirmada
      } else {
        consecutiveFailures++;
        isConnected = false;
        console.log(`  [Health Check] Estado: ${state} (falha ${consecutiveFailures}/${MAX_FAILURES})`);
        await addAlert('health_check', `Conexão WhatsApp em estado "${state}" — falha ${consecutiveFailures}/${MAX_FAILURES}`);

        if (consecutiveFailures >= MAX_FAILURES) {
          await autoRecover();
        }
      }
    } catch (err) {
      consecutiveFailures++;
      isConnected = false;
      console.log(`  [Health Check] Erro ao verificar estado: ${err.message} (falha ${consecutiveFailures}/${MAX_FAILURES})`);

      if (consecutiveFailures >= MAX_FAILURES) {
        await autoRecover();
      }
    }
  }, HEALTH_CHECK_INTERVAL_MS);
  console.log(`  [Health Check] Ativo — verificando a cada ${HEALTH_CHECK_INTERVAL_MS / 60000} min`);
}

function stopHealthCheck() {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
}

async function autoRecover() {
  console.log('  [Health Check] Muitas falhas consecutivas — limpando sessão e reiniciando...');
  await addAlert('auto_recover', `Bot desconectado após ${MAX_FAILURES} falhas. Limpando sessão e reiniciando (vai precisar escanear QR code).`);

  stopHealthCheck();
  await flushAllBuffers();
  stopAlerts();

  try {
    await client.destroy();
  } catch (e) {
    // ignora erro ao destruir
  }

  // Limpa sessão corrompida
  try {
    fs.rmSync(CONFIG.sessionDir, { recursive: true, force: true });
    console.log('  [Health Check] Sessão limpa.');
  } catch (e) {
    console.error('  [Health Check] Erro ao limpar sessão:', e.message);
  }

  // Reinicia o processo (PM2 vai restartar)
  console.log('  [Health Check] Reiniciando processo...');
  process.exit(1);
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

  // Deduplicação: ignora mensagens já processadas (evita duplo salvamento no catch-up)
  const msgId = msg.id?._serialized;
  if (msgId && processedIds.has(msgId)) return;

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

  // Marca como processada após sucesso
  markAsProcessed(msgId);
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
    const bufferKey = `${chatId}:${msg.author || author}`;
    const pending = pendingBuffer.get(bufferKey);

    if (pending && pending.items.length > 0) {
      // Mídias já no buffer → associa protocolo e reinicia timer
      if (pending.timer) clearTimeout(pending.timer);
      pending.protocolos.add(protocolo);
      updateTempMeta(bufferKey, pending); // Persiste protocolo no disco
      console.log(`  [${groupName}] ${author}: protocolo ${protocolo} adicionado ao bloco (${pending.items.length} mídia(s))`);
      pending.timer = setTimeout(() => flushBuffer(bufferKey), CONFIG.bufferTimeoutMs);
      return;
    }

    if (!pending) {
      // Texto chegou primeiro → abre buffer aguardando mídias
      const newPending = {
        items: [],
        protocolos: new Set([protocolo]),
        timer: null,
        groupName,
        authorName: author,
      };
      pendingBuffer.set(bufferKey, newPending);
      newPending.timer = setTimeout(() => flushBuffer(bufferKey), CONFIG.bufferTimeoutMs);
      console.log(`  [${groupName}] ${author}: protocolo ${protocolo} (texto primeiro) → aguardando mídias (${CONFIG.bufferTimeoutMs / 1000}s)`);
      return;
    }

    if (pending && pending.items.length === 0) {
      // Já esperando mídia — adiciona mais um protocolo ao mesmo buffer
      if (pending.timer) clearTimeout(pending.timer);
      pending.protocolos.add(protocolo);
      pending.timer = setTimeout(() => flushBuffer(bufferKey), CONFIG.bufferTimeoutMs);
      console.log(`  [${groupName}] ${author}: protocolo ${protocolo} adicionado → ainda aguardando mídias`);
      return;
    }
  }

  console.log(`  [${groupName}] ${author}: ${text.slice(0, 80)}${text.length > 80 ? '...' : ''}`);
}

// ============================================
// MENSAGEM DE MÍDIA
// ============================================

async function handleMediaMessage(msg, groupName, author, chatId, timestamp) {
  const type = msg.type;

  // Avisa se foto/vídeo foi enviado como documento (comum no WhatsApp Web/desktop)
  if (type === 'document') {
    const mime = msg.mimetype || '';
    if (mime.startsWith('image/') || mime.startsWith('video/')) {
      await addAlert('info', `📎 ${author} enviou mídia como documento em ${groupName} (${mime}) — não arquivada automaticamente. Verifique manualmente.`);
    }
    return;
  }

  // Ignora áudio, sticker e outros tipos não relevantes
  if (CONFIG.ignoredTypes.includes(type)) {
    return;
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

  // Salva mídia em pasta temp imediatamente (crash recovery)
  const seqNumber = pending.items.length + 1;
  const tempFilePath = saveTempMedia(bufferKey, seqNumber, media.data, media.mimetype);

  pending.items.push({
    filePath: tempFilePath,
    mimetype: media.mimetype,
    caption,
    timestamp,
  });

  // Persiste metadata do buffer em disco
  updateTempMeta(bufferKey, pending);

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
  if (!pending) return;

  if (pending.timer) clearTimeout(pending.timer);
  pendingBuffer.delete(bufferKey);

  // Buffer aberto por texto primeiro mas nenhuma mídia chegou — nada a salvar
  if (pending.items.length === 0) return;

  const protocolos = [...pending.protocolos];
  console.log(`  [${pending.groupName}] ${pending.authorName}: processando bloco — ${pending.items.length} mídia(s), ${protocolos.length} protocolo(s)${protocolos.length > 0 ? ` (${protocolos.join(', ')})` : ''}`);

  await saveBufferedBlock(pending.groupName, pending.authorName, pending.items, protocolos, bufferKey);
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
