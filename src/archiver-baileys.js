/**
 * archiver-baileys.js — Drop-in replacement de archiver.js usando Baileys
 *
 * Para usar: em src/index.js troque o import de './archiver.js' para './archiver-baileys.js'
 * Para voltar ao Puppeteer: desfaça a troca.
 *
 * Diferenças principais:
 *  - Sem Chromium — conexão WebSocket direta com servidores WhatsApp
 *  - RAM ~5-8x menor
 *  - Catch-up via mensagens do tipo 'append' no evento messages.upsert
 *  - Sessão salva em CONFIG.sessionDir (mesma pasta, formato diferente)
 */

import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';
import { CONFIG } from './config.js';
import { initAlerts, stopAlerts, addAlert } from './alerts.js';
import { logEvent } from './eventlog.js';
import {
  saveTextMessage,
  saveBufferedBlock,
  extractProtocolo,
  extractAllProtocolos,
  saveTempMedia,
  saveTempMeta,
  loadPersistentBuffers,
} from './storage.js';
import { tryReadBarcode } from './barcode.js';
import { updateExcelRecord } from './excel.js';

// ============================================
// ESTADO DO MÓDULO
// ============================================

const monitoredGroups = new Map(); // jid -> groupName
const pendingBuffer = new Map();   // bufferKey -> { items[], protocolos, timer, groupName, authorName }
const processedIds = new Set();    // IDs de mensagens já processadas (deduplicação)

let sock = null;
let isConnected = false;
let consecutiveFailures = 0;
let healthCheckInterval = null;
let catchupCutoff = 0;     // Timestamp mínimo para mensagens de catch-up
let catchupActive = false; // Ativo durante janela de startup
let shutdownRegistered = false;
let pendingDriveWarning = null; // Aviso de drive indisponível no startup
let lastDisconnectTime = 0;    // Para evitar spam de CONECTADO no eventlog

const MAX_FAILURES = 3;
const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000;

// Retorna o timeout de buffer para um grupo (pode ser sobrescrito por grupo no .env)
function getBufferTimeout(groupName) {
  return CONFIG.groupBufferMs[groupName?.trim()] ?? CONFIG.bufferTimeoutMs;
}

// Logger silencioso para Baileys (evita spam no console)
const noopLogger = {
  level: 'silent',
  trace: () => {}, debug: () => {}, info: () => {},
  warn: () => {}, error: () => {}, fatal: () => {},
  child: () => noopLogger,
};

// ============================================
// DEDUPLICAÇÃO DE MENSAGENS
// ============================================

const PROCESSED_RETENTION_DAYS = 30;

function loadProcessedIds() {
  const logsDir = path.join(CONFIG.archiveDir, 'logs');
  if (!fs.existsSync(logsDir)) return;
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
  if (count > 0) console.log(`  [Dedup] ${count} ID(s) já processados carregados`);

  // Limpa _processed.txt com mais de PROCESSED_RETENTION_DAYS dias
  try {
    const cutoff = Date.now() - PROCESSED_RETENTION_DAYS * 86400000;
    const files = fs.readdirSync(logsDir).filter(f => f.endsWith('_processed.txt'));
    let deleted = 0;
    for (const file of files) {
      const dateStr = file.replace('_processed.txt', '');
      const fileDate = new Date(dateStr).getTime();
      if (!isNaN(fileDate) && fileDate < cutoff) {
        fs.unlinkSync(path.join(logsDir, file));
        deleted++;
      }
    }
    if (deleted > 0) console.log(`  [Dedup] ${deleted} arquivo(s) antigo(s) removidos`);
  } catch { /* best-effort */ }
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
// HELPER: persiste meta do buffer em disco
// ============================================

function updateTempMeta(bufferKey, pending) {
  if (pending.items.length === 0) return;
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
        barcode: i.barcode || null,
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
        barcode: i.barcode || null,
      })),
      protocolos: new Set(protocolos || []),
      timer: null,
      groupName,
      authorName,
    };

    pendingBuffer.set(bufferKey, pending);
    pending.timer = setTimeout(() => flushBuffer(bufferKey), getBufferTimeout(groupName));

    const protoInfo = protocolos?.length > 0 ? `, protocolo(s): ${protocolos.join(', ')}` : '';
    console.log(`  [Buffer] Restaurado: ${authorName} (${groupName}) — ${validItems.length} mídia(s)${protoInfo}`);
    restored++;
  }

  if (restored > 0) {
    await addAlert('info', `🔄 ${restored} buffer(s) de mídia recuperado(s) após reinício.`);
  }
}

// ============================================
// PONTO DE ENTRADA
// ============================================

export async function startArchiver(driveWarning = null) {
  pendingDriveWarning = driveWarning;
  // Registra handlers de shutdown apenas uma vez
  if (!shutdownRegistered) {
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    shutdownRegistered = true;
  }

  console.log('  Iniciando WhatsApp Bila Organizer (Baileys)...\n');
  await connect();
}

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(CONFIG.sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    auth: state,
    version,
    logger: noopLogger,
    // Identifica como Chrome para o servidor WhatsApp
    browser: ['WhatsApp Bila Organizer', 'Chrome', '120.0.0'],
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    // Necessário para retry de mensagens
    getMessage: async () => undefined,
  });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', handleConnectionUpdate);
  sock.ev.on('messages.upsert', handleMessagesUpsert);
}

// ============================================
// GERENCIAMENTO DE CONEXÃO
// ============================================

async function handleConnectionUpdate({ connection, qr, lastDisconnect }) {
  if (qr) {
    console.log('\n  Escaneie o QR Code abaixo com seu WhatsApp:\n');
    qrcode.generate(qr, { small: true });
  }

  if (connection === 'open') {
    await onReady();
  }

  if (connection === 'close') {
    isConnected = false;
    lastDisconnectTime = Date.now();
    stopHealthCheck();

    const code = lastDisconnect?.error?.output?.statusCode;
    const reason = lastDisconnect?.error?.message || 'desconhecido';
    console.log(`  Conexão encerrada — código: ${code}, motivo: ${reason}`);
    logEvent('DESCONECTADO', `Conexão encerrada (código ${code})`, reason);

    if (code === DisconnectReason.loggedOut) {
      console.log('  Sessão expirada — limpe a pasta session/ e reinicie.');
      await addAlert('erro', 'Sessão WhatsApp expirada. Limpe a pasta session/ e reinicie o bot.');
      stopAlerts();
      process.exit(1);
    }

    // restartRequired (515) é normal — reconecta silenciosamente
    if (code !== DisconnectReason.restartRequired) {
      consecutiveFailures++;
      console.log(`  Reconectando (falha ${consecutiveFailures}/${MAX_FAILURES})...`);

      if (consecutiveFailures >= MAX_FAILURES) {
        await autoRecover();
        return;
      }
    }

    // Conflict (440): outra sessão ativa — espera mais para o WhatsApp liberar
    const delay = code === 440 ? 15000 : 3000;
    await new Promise(r => setTimeout(r, delay));
    await connect();
  }
}

async function onReady() {
  console.log('  Bot conectado e pronto!\n');
  isConnected = true;
  consecutiveFailures = 0;
  // Só loga CONECTADO se ficou desconectado por mais de 10s (evita spam durante reconexões rápidas)
  if (Date.now() - lastDisconnectTime > 10000) {
    logEvent('CONECTADO', 'WhatsApp conectado com sucesso', `Arquivo: ${CONFIG.archiveDir}`);
  }

  // Reseta contador de crashes
  const restartFile = path.join(path.dirname(CONFIG.sessionDir), '.restart_count');
  try { fs.unlinkSync(restartFile); } catch { /* ignora */ }

  loadProcessedIds();

  const lastActive = getLastActiveTime();
  updateLastActive();

  // Cria adapter compatível com alerts.js (mesma interface do whatsapp-web.js)
  const clientAdapter = makeAlertsAdapter();
  await initAlerts(clientAdapter);
  await addAlert('info', 'Bot iniciado com sucesso! (Baileys)');

  if (pendingDriveWarning) {
    await addAlert('erro', `Drive indisponivel no startup — ${pendingDriveWarning}`);
    pendingDriveWarning = null;
  }

  await loadAndRestorePersistentBuffers();
  await findGroups();
  await setupCatchup(lastActive);
  startHealthCheck();

  console.log('\n  Monitorando mensagens... (Ctrl+C para parar)\n');
}

/**
 * Adapter que expõe a interface usada por alerts.js
 * usando as APIs do Baileys por baixo
 */
function makeAlertsAdapter() {
  return {
    getChats: async () => {
      const groups = await sock.groupFetchAllParticipating();
      return Object.entries(groups).map(([jid, meta]) => ({
        id: { _serialized: jid, user: jid.split('@')[0] },
        name: meta.subject,
        isGroup: true,
      }));
    },
    sendMessage: async (jid, text) => {
      await sock.sendMessage(jid, { text });
    },
    getNumberId: async (number) => ({ _serialized: `${number}@s.whatsapp.net` }),
    info: { wid: { user: null } },
  };
}

// ============================================
// CATCH-UP DE MENSAGENS PERDIDAS
// ============================================

async function setupCatchup(lastActiveTime) {
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
      hours = Math.max(CONFIG.catchupHours, Math.min(downtimeHours + 0.5, CONFIG.maxCatchupHours));
      await addAlert('info', `⏰ Retomada após ${downtimeStr} offline. Buscando últimas ${hours.toFixed(1)}h...`);
    }
  }

  catchupCutoff = Date.now() - hours * 60 * 60 * 1000;
  catchupActive = true;

  console.log(`  [Catch-up] Processando mensagens das últimas ${hours.toFixed(1)}h (via sync Baileys)...`);

  // Desativa catch-up após 60s — WhatsApp envia histórico no início da sessão
  setTimeout(() => {
    catchupActive = false;
    console.log('  [Catch-up] Janela encerrada. Monitorando apenas mensagens novas.');
  }, 60 * 1000);
}

// ============================================
// HEALTH CHECK
// ============================================

function startHealthCheck() {
  stopHealthCheck();
  healthCheckInterval = setInterval(async () => {
    if (!isConnected) {
      consecutiveFailures++;
      console.log(`  [Health Check] Desconectado (falha ${consecutiveFailures}/${MAX_FAILURES})`);
      if (consecutiveFailures >= MAX_FAILURES) await autoRecover();
    } else {
      consecutiveFailures = 0;
      updateLastActive();
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
  console.log('  [Health Check] Muitas falhas — limpando sessão e reiniciando...');
  logEvent('SESSAO_LIMPA', `Health check falhou ${MAX_FAILURES}x — sessão limpa automaticamente`);
  await addAlert('erro', `Bot desconectado após ${MAX_FAILURES} falhas. Limpando sessão (vai precisar escanear QR code).`);

  stopHealthCheck();
  await flushAllBuffers();
  stopAlerts();

  try { sock?.end(); } catch { /* ignora */ }

  try {
    fs.rmSync(CONFIG.sessionDir, { recursive: true, force: true });
    console.log('  [Health Check] Sessão limpa.');
  } catch (e) {
    console.error('  [Health Check] Erro ao limpar sessão:', e.message);
  }

  process.exit(1);
}

// ============================================
// GRACEFUL SHUTDOWN
// ============================================

const shutdown = async () => {
  console.log('\n  Encerrando...');
  logEvent('SHUTDOWN', 'Bot encerrado normalmente');
  updateLastActive();
  await flushAllBuffers();
  stopAlerts();
  stopHealthCheck();
  try { sock?.end(); } catch { /* ignora */ }
  process.exit(0);
};

// ============================================
// ENCONTRAR GRUPOS
// ============================================

async function findGroups() {
  console.log('  Procurando grupos configurados...');
  const configuredNames = CONFIG.groups.map(g => g.trim().toLowerCase());

  let allGroups;
  try {
    allGroups = await sock.groupFetchAllParticipating();
  } catch (err) {
    console.error('  Erro ao buscar grupos:', err.message);
    return;
  }

  for (const [jid, meta] of Object.entries(allGroups)) {
    const nameLC = meta.subject.trim().toLowerCase();
    if (configuredNames.includes(nameLC)) {
      monitoredGroups.set(jid, meta.subject);
      console.log(`    + "${meta.subject}" encontrado`);
    }
  }

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
// LISTENER DE MENSAGENS
// ============================================

async function handleMessagesUpsert({ messages, type }) {
  for (const msg of messages) {
    try {
      if (type === 'notify') {
        // Mensagem em tempo real
        await handleMessage(msg);
      } else if (type === 'append' && catchupActive) {
        // Histórico enviado pelo WhatsApp durante o sync inicial
        const msgTime = Number(msg.messageTimestamp) * 1000;
        if (msgTime >= catchupCutoff) {
          await handleMessage(msg);
        }
      }
    } catch (err) {
      console.error('  Erro ao processar mensagem:', err.message);
    }
  }
}

async function handleMessage(msg) {
  // Ignora mensagens próprias e status
  if (msg.key.fromMe) return;
  const chatId = msg.key.remoteJid;
  if (!chatId || !chatId.endsWith('@g.us')) return;
  if (!monitoredGroups.has(chatId)) return;

  // Deduplicação
  const msgId = msg.key.id;
  if (msgId && processedIds.has(msgId)) return;

  const groupName = monitoredGroups.get(chatId);
  const authorId = msg.key.participant || chatId;
  const author = msg.pushName || authorId.split('@')[0] || 'desconhecido';
  const timestamp = new Date(Number(msg.messageTimestamp) * 1000);

  // Desempacota mensagens efêmeras / view-once
  const m = msg.message;
  if (!m) return;
  const content = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m;

  const imageMsg = content.imageMessage;
  const videoMsg = content.videoMessage;
  const docMsg = content.documentMessage;
  const textRaw = content.conversation || content.extendedTextMessage?.text;

  if (imageMsg || videoMsg) {
    await handleMediaMessage(msg, content, groupName, author, authorId, chatId, timestamp);
  } else if (docMsg) {
    const mime = docMsg.mimetype || '';
    if (mime.startsWith('image/') || mime.startsWith('video/')) {
      await addAlert('info', `📎 ${author} enviou mídia como documento em ${groupName} (${mime}) — não arquivada automaticamente. Verifique manualmente.`);
    }
  } else if (textRaw) {
    await handleTextMessage(textRaw, groupName, author, authorId, chatId, timestamp);
  }

  markAsProcessed(msgId);
}

// ============================================
// MENSAGEM DE TEXTO
// ============================================

async function handleTextMessage(text, groupName, author, authorId, chatId, timestamp) {
  saveTextMessage(groupName, author, text, timestamp);

  const protocolo = extractProtocolo(text);
  if (protocolo) {
    const bufferKey = `${chatId}:${authorId}`;
    const pending = pendingBuffer.get(bufferKey);

    if (pending && pending.items.length > 0) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.protocolos.add(protocolo);
      updateTempMeta(bufferKey, pending);
      console.log(`  [${groupName}] ${author}: protocolo ${protocolo} adicionado ao bloco (${pending.items.length} mídia(s))`);
      pending.timer = setTimeout(() => flushBuffer(bufferKey), getBufferTimeout(groupName));
      return;
    }

    if (!pending) {
      const newPending = { items: [], protocolos: new Set([protocolo]), timer: null, groupName, authorName: author };
      pendingBuffer.set(bufferKey, newPending);
      newPending.timer = setTimeout(() => flushBuffer(bufferKey), getBufferTimeout(groupName));
      console.log(`  [${groupName}] ${author}: protocolo ${protocolo} (texto primeiro) → aguardando mídias (${getBufferTimeout(groupName) / 1000}s)`);
      return;
    }

    if (pending.items.length === 0) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.protocolos.add(protocolo);
      pending.timer = setTimeout(() => flushBuffer(bufferKey), getBufferTimeout(groupName));
      console.log(`  [${groupName}] ${author}: protocolo ${protocolo} adicionado → ainda aguardando mídias`);
      return;
    }
  }

  console.log(`  [${groupName}] ${author}: ${text.slice(0, 80)}${text.length > 80 ? '...' : ''}`);
}

// ============================================
// MENSAGEM DE MÍDIA
// ============================================

async function handleMediaMessage(msg, content, groupName, author, authorId, chatId, timestamp) {
  const mediaMsg = content.imageMessage || content.videoMessage;
  const mimetype = mediaMsg.mimetype || 'image/jpeg';
  const mediaType = mimetype.split('/')[0]; // 'image' ou 'video'

  if (!CONFIG.mediaTypes.includes(mediaType)) return;

  let buffer;
  try {
    buffer = await downloadMediaMessage(
      msg,
      'buffer',
      {},
      { logger: noopLogger, reuploadRequest: sock.updateMediaMessage }
    );
  } catch (err) {
    console.error(`  [${groupName}] Erro ao baixar mídia de ${author}:`, err.message);
    return;
  }

  if (!buffer || buffer.length === 0) {
    console.log(`  [${groupName}] Mídia indisponível de ${author}`);
    return;
  }

  const caption = mediaMsg.caption || '';
  const protocolosCaption = extractAllProtocolos(caption);

  // Lê barcode da imagem como failsafe (best-effort, ~200ms)
  const barcode = await tryReadBarcode(buffer);
  if (barcode) {
    console.log(`  [${groupName}] ${author}: barcode detectado → ${barcode}`);
  }

  const bufferKey = `${chatId}:${authorId}`;

  let pending = pendingBuffer.get(bufferKey);
  if (!pending) {
    pending = { items: [], protocolos: new Set(), timer: null, groupName, authorName: author };
    pendingBuffer.set(bufferKey, pending);
  }

  if (pending.timer) clearTimeout(pending.timer);
  for (const proto of protocolosCaption) pending.protocolos.add(proto);

  const seqNumber = pending.items.length + 1;
  const base64 = buffer.toString('base64');
  const tempFilePath = saveTempMedia(bufferKey, seqNumber, base64, mimetype);

  pending.items.push({ filePath: tempFilePath, mimetype, caption, timestamp, barcode });
  updateTempMeta(bufferKey, pending);

  const protoInfo = protocolosCaption.length > 0
    ? `com protocolo ${protocolosCaption.join(', ')}`
    : 'sem legenda';
  console.log(`  [${groupName}] ${author}: mídia ${protoInfo} → buffer (${pending.items.length} item(s), aguardando ${getBufferTimeout(groupName) / 1000}s)`);

  pending.timer = setTimeout(() => flushBuffer(bufferKey), getBufferTimeout(groupName));
}

// ============================================
// FLUSH BUFFER
// ============================================

async function flushBuffer(bufferKey) {
  const pending = pendingBuffer.get(bufferKey);
  if (!pending) return;

  if (pending.timer) clearTimeout(pending.timer);
  pendingBuffer.delete(bufferKey);

  if (pending.items.length === 0) return;

  let protocolos = [...pending.protocolos];

  // Coleta barcodes únicos lidos das imagens do bloco
  const barcodes = [...new Set(pending.items.map(i => i.barcode).filter(Boolean))];

  if (barcodes.length > 0) {
    if (protocolos.length === 0) {
      // Nenhum protocolo digitado — usa barcode como protocolo
      protocolos = barcodes;
      console.log(`  [${pending.groupName}] ${pending.authorName}: protocolo via barcode → ${barcodes.join(', ')}`);
      await addAlert('barcode', `📷 Protocolo detectado via barcode: ${barcodes.join(', ')} — ${pending.authorName} em ${pending.groupName}`);
    } else {
      // Protocolo digitado — verifica divergência
      const divergentes = barcodes.filter(b => !protocolos.includes(b));
      if (divergentes.length > 0) {
        await addAlert('barcode', `🔍 Barcode difere do protocolo digitado! Digitado: ${protocolos.join(', ')} | Barcode: ${divergentes.join(', ')} — ${pending.authorName} em ${pending.groupName}`);
      }
    }
  }

  console.log(`  [${pending.groupName}] ${pending.authorName}: processando bloco — ${pending.items.length} mídia(s), ${protocolos.length} protocolo(s)${protocolos.length > 0 ? ` (${protocolos.join(', ')})` : ''}`);

  const { protocolosValidos, salvos } = await saveBufferedBlock(pending.groupName, pending.authorName, pending.items, protocolos, bufferKey);

  // Atualiza planilha Excel apenas para o grupo Manutenção
  const isManutenção = pending.groupName?.trim().toLowerCase().startsWith('manutenção');
  if (CONFIG.excelFileId && protocolosValidos.length === 1 && salvos > 0 && isManutenção) {
    await updateExcelRecord(protocolosValidos[0], salvos);
  }
}

async function flushAllBuffers() {
  for (const key of pendingBuffer.keys()) {
    await flushBuffer(key);
  }
  pendingBuffer.clear();
}
