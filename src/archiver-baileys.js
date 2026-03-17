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
  Browsers,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { CONFIG } from './config.js';
import { initAlerts, stopAlerts, addAlert } from './alerts.js';
import { logEvent } from './eventlog.js';
import {
  saveTextMessage,
  saveBufferedBlock,
  extractProtocolo,
  extractAllProtocolos,
  isProtocoloValido,
  saveTempMedia,
  saveTempMeta,
  loadPersistentBuffers,
  moveToProtocol,
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
let diskCheckInterval = null;
let catchupCutoff = 0;      // Timestamp mínimo para mensagens de catch-up
let catchupActive = false;  // Ativo durante janela de startup
let catchupCount = 0;       // Mensagens recuperadas no catch-up
let shutdownRegistered = false;
let pendingDriveWarning = null; // Aviso de drive indisponível no startup
let lastDisconnectTime = 0;    // Para evitar spam de CONECTADO no eventlog
let lastDisconnectCode = 0;    // Último código de desconexão (para backoff pós-440)

const MAX_FAILURES = 3;
const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000;

// Loop de 440 detector
const conflict440Timestamps = []; // timestamps de desconexões 440 recentes
const MAX_440_IN_WINDOW = 5;
const WINDOW_440_MS = 30 * 60 * 1000; // 30 min

// Drives já alertados por pouco espaço (evita spam por sessão)
const alertedDrives = new Set();

// Lotes flushados por gap aguardando associação retroativa (mesmo autor)
// bufferKey → { savedPath, groupName, authorName, expiresAt }
const recentlyFlushed = new Map();

// Mapa msgId → pasta salva (persistido em disco, TTL 7 dias)
// Permite que qualquer pessoa responda uma foto com o protocolo
const msgIdSavedMap = new Map();

// Retorna o timeout de buffer para um grupo (pode ser sobrescrito por grupo no .env)
function getBufferTimeout(groupName) {
  return CONFIG.groupBufferMs[groupName?.trim()] ?? CONFIG.bufferTimeoutMs;
}

// Formata o timestamp do primeiro item como nome de lote: lote_YYYY-MM-DD_HH-MM-SS
function formatLoteName(date) {
  const d = new Date(date);
  const pad = n => String(n).padStart(2, '0');
  return `lote_${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

// ============================================
// MSG-ID → PASTA SALVA (persistência em disco)
// ============================================

const MSG_ID_MAP_FILE = () => path.join(CONFIG.logsDir, 'msg_saved_map.json');
const MSG_ID_MAP_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

function loadMsgIdMap() {
  try {
    const file = MSG_ID_MAP_FILE();
    if (!fs.existsSync(file)) return;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [id, entry] of Object.entries(raw)) {
      msgIdSavedMap.set(id, entry);
    }
    console.log(`  [MsgMap] ${msgIdSavedMap.size} entradas carregadas.`);
  } catch { /* best effort */ }
}

function cleanupMsgIdMap() {
  const cutoff = Date.now() - MSG_ID_MAP_TTL_MS;
  let removed = 0;
  for (const [id, entry] of msgIdSavedMap) {
    if (entry.savedAt < cutoff) { msgIdSavedMap.delete(id); removed++; }
  }
  if (removed > 0) console.log(`  [MsgMap] ${removed} entradas antigas removidas.`);
}

function persistMsgIdMap() {
  try {
    fs.mkdirSync(CONFIG.logsDir, { recursive: true });
    const obj = Object.fromEntries(msgIdSavedMap);
    fs.writeFileSync(MSG_ID_MAP_FILE(), JSON.stringify(obj), 'utf8');
  } catch { /* best effort */ }
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
  const logsDir = CONFIG.logsDir;
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
    const files = fs.readdirSync(CONFIG.logsDir).filter(f => f.endsWith('_processed.txt'));
    let deleted = 0;
    for (const file of files) {
      const dateStr = file.replace('_processed.txt', '');
      const fileDate = new Date(dateStr).getTime();
      if (!isNaN(fileDate) && fileDate < cutoff) {
        fs.unlinkSync(path.join(CONFIG.logsDir, file));
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
    fs.mkdirSync(CONFIG.logsDir, { recursive: true });
    fs.appendFileSync(path.join(CONFIG.logsDir, `${today}_processed.txt`), msgId + '\n');
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
        msgId: i.msgId || null,
      })),
    });
  } catch { /* best effort */ }
}

// ============================================
// RESTAURAR BUFFERS DO DISCO (crash recovery)
// ============================================

async function loadAndRestorePersistentBuffers() {
  loadMsgIdMap();
  cleanupMsgIdMap();

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
  // Remove listeners do socket anterior para evitar que eventos antigos
  // disparem handleConnectionUpdate e criem novos sockets em loop
  if (sock) {
    try { sock.ev.removeAllListeners(); } catch { /* ignora */ }
    try { sock.ws?.close(); } catch { /* ignora */ }
  }

  const { state, saveCreds } = await useMultiFileAuthState(CONFIG.sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    auth: state,
    version,
    logger: noopLogger,
    // Identifica como Desktop (não conflita com WhatsApp Web no navegador)
    browser: Browsers.macOS('Desktop'),
    syncFullHistory: true,
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
    lastDisconnectCode = code || 0;
    console.log(`  Conexão encerrada — código: ${code}, motivo: ${reason}`);
    logEvent('DESCONECTADO', `Conexão encerrada (código ${code})`, reason);

    if (code === DisconnectReason.loggedOut) {
      console.log('  Sessão expirada — limpe a pasta session/ e reinicie.');
      writeSessionExpiredNotice('Sessão encerrada pelo WhatsApp (loggedOut)');
      await addAlert('erro', 'Sessão WhatsApp expirada. Limpe a pasta session/ e reinicie o bot.');
      stopAlerts();
      process.exit(1);
    }

    // Conflict (440): rastreia para detectar loop
    if (code === 440) {
      conflict440Timestamps.push(Date.now());
      // Remove entradas mais antigas que a janela
      const cutoff = Date.now() - WINDOW_440_MS;
      while (conflict440Timestamps.length > 0 && conflict440Timestamps[0] < cutoff) {
        conflict440Timestamps.shift();
      }
      console.log(`  [440] ${conflict440Timestamps.length}/${MAX_440_IN_WINDOW} conflitos na janela de 30min`);
      if (conflict440Timestamps.length >= MAX_440_IN_WINDOW) {
        await autoRecoverConflict();
        return;
      }
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
    // Jitter evita que múltiplos restarts batam exatamente no mesmo segundo
    const baseDelay = code === 440 ? 30000 : 3000;
    const jitter = Math.floor(Math.random() * 5000);
    console.log(`  Aguardando ${(baseDelay + jitter) / 1000}s antes de reconectar...`);
    await new Promise(r => setTimeout(r, baseDelay + jitter));
    await connect();
  }
}

async function onReady() {
  console.log('  Bot conectado e pronto!\n');
  isConnected = true;
  consecutiveFailures = 0;
  conflict440Timestamps.length = 0; // Reseta o contador de 440 ao conectar com sucesso
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

  // Backoff pós-440: aguarda 30s antes de buscar grupos para evitar rate-overlimit
  if (lastDisconnectCode === 440) {
    console.log('  [440] Aguardando 30s após conflito antes de buscar grupos...');
    await new Promise(r => setTimeout(r, 30000));
  }

  // Busca grupos uma vez só — reutilizado em initAlerts e findGroups
  let allGroupsCache = null;
  const fetchGroupsCached = async () => {
    if (!allGroupsCache) {
      allGroupsCache = await sock.groupFetchAllParticipating();
    }
    return allGroupsCache;
  };

  // Cria adapter compatível com alerts.js (mesma interface do whatsapp-web.js)
  const clientAdapter = makeAlertsAdapter(fetchGroupsCached);
  try {
    await initAlerts(clientAdapter);
  } catch (err) {
    if (err.message && err.message.toLowerCase().includes('rate')) {
      console.warn('  initAlerts: rate limit detectado — aguardando 2min e tentando novamente...');
      await new Promise(r => setTimeout(r, 2 * 60 * 1000));
      await initAlerts(clientAdapter);
    } else {
      throw err;
    }
  }
  await addAlert('info', 'Bot iniciado com sucesso! (Baileys)');

  if (pendingDriveWarning) {
    await addAlert('erro', `Drive indisponivel no startup — ${pendingDriveWarning}`);
    pendingDriveWarning = null;
  }

  await loadAndRestorePersistentBuffers();
  await findGroups(fetchGroupsCached);
  await setupCatchup(lastActive);
  startHealthCheck();
  startDiskCheck();

  console.log('\n  Monitorando mensagens... (Ctrl+C para parar)\n');
}

/**
 * Adapter que expõe a interface usada por alerts.js
 * usando as APIs do Baileys por baixo
 */
function makeAlertsAdapter(fetchGroupsCached) {
  return {
    getChats: async () => {
      const groups = await fetchGroupsCached();
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

  catchupCount = 0;

  // Desativa catch-up após 5min — syncFullHistory pode demorar mais para chegar
  setTimeout(() => {
    catchupActive = false;
    console.log(`  [Catch-up] Janela encerrada. ${catchupCount} mensagem(ns) recuperada(s).`);
    if (catchupCount === 0) {
      addAlert('info', '⚠️ Catch-up encerrado sem mensagens recuperadas — WhatsApp não enviou histórico. Verifique manualmente.');
    }
  }, 5 * 60 * 1000);
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
  stopDiskCheck();
}

function stopDiskCheck() {
  if (diskCheckInterval) {
    clearInterval(diskCheckInterval);
    diskCheckInterval = null;
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

async function autoRecoverConflict() {
  console.log(`  [440] Loop de conflito detectado (${MAX_440_IN_WINDOW}x em 30min) — limpando sessão...`);
  logEvent('SESSAO_LIMPA', 'Loop de 440 detectado — sessão limpa automaticamente', `${MAX_440_IN_WINDOW} conflitos em 30min`);
  try {
    await addAlert('erro', `🔄 Loop de conflito (440) detectado ${MAX_440_IN_WINDOW}x em 30min — limpando sessão. Precisará escanear QR code.`);
  } catch { /* best-effort */ }

  stopHealthCheck();
  await flushAllBuffers();
  stopAlerts();

  try { sock?.end(); } catch { /* ignora */ }

  try {
    fs.rmSync(CONFIG.sessionDir, { recursive: true, force: true });
    console.log('  [440] Sessão limpa.');
  } catch (e) {
    console.error('  [440] Erro ao limpar sessão:', e.message);
  }

  writeSessionExpiredNotice(`Loop de conflito (440) ${MAX_440_IN_WINDOW}x em 30min — sessão limpa automaticamente`);
  process.exit(1);
}

function writeSessionExpiredNotice(reason) {
  try {
    const logsDir = path.resolve(path.dirname(CONFIG.sessionDir), 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const noticePath = path.join(logsDir, 'SESSAO_EXPIRADA.txt');
    const now = new Date().toLocaleString('pt-BR');
    const content = `[${now}] SESSÃO WHATSAPP EXPIRADA
Motivo: ${reason}
Ação necessária: escaneie o QR code para reconectar.
  1. pm2 kill
  2. Apague a pasta session/
  3. pm2 start ecosystem.config.cjs
  4. pm2 logs whatsapp-bila-organizer --raw
`;
    fs.writeFileSync(noticePath, content, 'utf8');
    console.log(`  [Sessão] Aviso escrito em: ${noticePath}`);
  } catch (e) {
    console.error('  [Sessão] Erro ao escrever aviso de sessão expirada:', e.message);
  }
}

async function checkDiskSpace() {
  try {
    const dirs = [CONFIG.archiveDir];
    if (CONFIG.archiveFallbackDir) dirs.push(CONFIG.archiveFallbackDir);

    // Extrai raízes únicas (letra de drive no Windows, ex: "Z:\")
    const drives = new Set();
    for (const dir of dirs) {
      const match = dir.match(/^([A-Za-z]:\\)/);
      if (match) {
        drives.add(match[1]);
      } else if (dir.startsWith('/')) {
        drives.add('/');
      }
    }

    for (const drive of drives) {
      if (alertedDrives.has(drive)) continue;
      let freeBytes = null;

      // Tenta fs.statfsSync primeiro (Node 19+)
      if (fs.statfsSync) {
        try {
          const stats = fs.statfsSync(drive);
          freeBytes = stats.bavail * stats.bsize;
        } catch { /* cai para wmic */ }
      }

      // Fallback: wmic (Windows)
      if (freeBytes === null) {
        try {
          const driveId = drive.replace('\\', '').replace('/', '');
          const output = execSync(
            `wmic logicaldisk where "DeviceID='${driveId}'" get FreeSpace /value`,
            { timeout: 5000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
          );
          const match = output.match(/FreeSpace=(\d+)/);
          if (match) freeBytes = parseInt(match[1], 10);
        } catch { /* melhor esforço */ }
      }

      if (freeBytes !== null) {
        const freeGb = freeBytes / (1024 * 1024 * 1024);
        if (freeGb < CONFIG.diskWarnGb) {
          alertedDrives.add(drive);
          await addAlert('erro', `💾 Disco ${drive} com pouco espaço: ${freeGb.toFixed(1)}GB livres (limite: ${CONFIG.diskWarnGb}GB)`);
        }
      }
    }
  } catch (e) {
    console.error('  [Disco] Erro ao verificar espaço em disco:', e.message);
  }
}

function startDiskCheck() {
  stopDiskCheck();
  checkDiskSpace(); // Verifica imediatamente ao conectar
  diskCheckInterval = setInterval(checkDiskSpace, 60 * 60 * 1000); // A cada 60 min
  console.log('  [Disco] Verificação periódica de espaço ativa (60 min)');
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

async function findGroups(fetchGroupsCached) {
  console.log('  Procurando grupos configurados...');
  const configuredNames = CONFIG.groups.map(g => g.trim().toLowerCase());

  let allGroups;
  try {
    allGroups = fetchGroupsCached
      ? await fetchGroupsCached()
      : await sock.groupFetchAllParticipating();
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
          catchupCount++;
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
  if (!chatId) return;

  const isGroup = chatId.endsWith('@g.us');
  const isPrivate = chatId.endsWith('@s.whatsapp.net') || chatId.endsWith('@c.us');

  if (isGroup && !monitoredGroups.has(chatId)) return;
  if (!isGroup && !isPrivate) return;

  // Deduplicação
  const msgId = msg.key.id;
  if (msgId && processedIds.has(msgId)) return;

  const groupName = isGroup ? monitoredGroups.get(chatId) : '_privado';
  const authorId = isGroup ? (msg.key.participant || chatId) : chatId;
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
    const quotedMsgId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId || null;
    await handleTextMessage(textRaw, groupName, author, authorId, chatId, timestamp, quotedMsgId);
  }

  markAsProcessed(msgId);
}

// ============================================
// MENSAGEM DE TEXTO
// ============================================

async function handleTextMessage(text, groupName, author, authorId, chatId, timestamp, quotedMsgId = null) {
  saveTextMessage(groupName, author, text, timestamp);

  const protocolo = extractProtocolo(text);
  if (protocolo) {
    const bufferKey = `${chatId}:${authorId}`;

    // ── 1. REPLY: qualquer pessoa respondeu uma foto com protocolo ──────────
    if (quotedMsgId && isProtocoloValido(protocolo)) {
      const saved = msgIdSavedMap.get(quotedMsgId);
      if (saved && saved.folderPath && saved.folderPath.includes('sem_legenda')) {
        const { moved, destPath } = await moveToProtocol(saved.folderPath, protocolo, saved.groupName);
        if (moved > 0) {
          console.log(`  [Reply] ${author}: ${moved} mídia(s) de ${saved.authorName} movidas → ${protocolo}`);
          await addAlert('salvo_sucesso', `[${saved.authorName}][${moved} → ${protocolo}] ${saved.groupName} (via resposta de ${author})`);
          // Atualiza entradas do mapa para apontar para o novo destino
          for (const [id, entry] of msgIdSavedMap) {
            if (entry.folderPath === saved.folderPath) {
              entry.folderPath = destPath;
            }
          }
          persistMsgIdMap();
          const isManutenção = saved.groupName?.trim().toLowerCase().startsWith('manutenção');
          if (CONFIG.excelFileId && isManutenção) await updateExcelRecord(protocolo, moved);
          return;
        }
      }
    }

    // ── 2. RETROATIVO: mesmo autor enviou protocolo logo após gap-flush ─────
    if (isProtocoloValido(protocolo)) {
      const recent = recentlyFlushed.get(bufferKey);
      if (recent && recent.expiresAt > Date.now()) {
        const { moved, destPath } = await moveToProtocol(recent.savedPath, protocolo, recent.groupName);
        if (moved > 0) {
          recentlyFlushed.delete(bufferKey);
          console.log(`  [Retroativo] ${author}: ${moved} mídia(s) movidas → ${protocolo}`);
          await addAlert('salvo_sucesso', `[${author}][${moved} → ${protocolo}] ${groupName} (lote retroativo)`);
          // Atualiza mapa de msgIds para apontar pro novo destino
          for (const [id, entry] of msgIdSavedMap) {
            if (entry.folderPath === recent.savedPath) entry.folderPath = destPath;
          }
          persistMsgIdMap();
          const isManutenção = groupName?.trim().toLowerCase().startsWith('manutenção');
          if (CONFIG.excelFileId && isManutenção) await updateExcelRecord(protocolo, moved);
          // Não retorna: protocolo também vai pro buffer ativo se houver
        }
      }
    }

    // ── 3. NORMAL: associa protocolo ao buffer ativo ─────────────────────────
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
    buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: noopLogger, reuploadRequest: sock.updateMediaMessage });
  } catch (firstErr) {
    // reuploadRequest interno só cobre ausência de conteúdo, não falhas HTTP.
    // Para encaminhamentos com URL expirada, pede nova URL explicitamente e tenta de novo.
    try {
      const updatedMsg = await sock.updateMediaMessage(msg);
      buffer = await downloadMediaMessage(updatedMsg, 'buffer', {}, { logger: noopLogger });
    } catch (retryErr) {
      console.error(`  [${groupName}] Erro ao baixar mídia de ${author}:`, firstErr.message);
      await addAlert('erro', `📵 Mídia de ${author} em ${groupName} não pôde ser baixada (URL expirada/indisponível). Peça para reenviar.`);
      return;
    }
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

  // Detecção de novo lote: se a última mídia foi enviada há mais de intraBufGapMs,
  // flush imediato do buffer atual e começa lote novo — equivale à "linha vazia" do organizer
  if (pending && pending.items.length > 0 && CONFIG.intraBufGapMs > 0) {
    const lastTimestamp = pending.items[pending.items.length - 1].timestamp;
    const gapMs = timestamp - lastTimestamp;
    if (gapMs > CONFIG.intraBufGapMs) {
      const gapSec = Math.round(gapMs / 1000);
      console.log(`  [${groupName}] ${author}: gap de ${gapSec}s detectado → flush do lote anterior (${pending.items.length} item(s)) e novo lote`);
      await flushBuffer(bufferKey, true);
      pending = null;
    }
  }

  if (!pending) {
    pending = { items: [], protocolos: new Set(), timer: null, groupName, authorName: author };
    pendingBuffer.set(bufferKey, pending);
  }

  if (pending.timer) clearTimeout(pending.timer);
  for (const proto of protocolosCaption) pending.protocolos.add(proto);

  const seqNumber = pending.items.length + 1;
  const base64 = buffer.toString('base64');
  const tempFilePath = saveTempMedia(bufferKey, seqNumber, base64, mimetype);

  const msgId = msg.key.id || null;
  pending.items.push({ filePath: tempFilePath, mimetype, caption, timestamp, barcode, msgId });
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

async function flushBuffer(bufferKey, isGapFlush = false) {
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

  // Gap-flush sem protocolo: salva em subpasta datada para revisão manual
  const loteFolder = (isGapFlush && protocolos.length === 0)
    ? formatLoteName(pending.items[0].timestamp)
    : undefined;

  console.log(`  [${pending.groupName}] ${pending.authorName}: processando bloco — ${pending.items.length} mídia(s), ${protocolos.length} protocolo(s)${protocolos.length > 0 ? ` (${protocolos.join(', ')})` : ''}${loteFolder ? ` [gap → ${loteFolder}]` : ''}`);

  const { protocolosValidos, salvos, pastaDestino } = await saveBufferedBlock(
    pending.groupName, pending.authorName, pending.items, protocolos, bufferKey,
    loteFolder ? { loteFolder } : {}
  );

  // Registra msgIds no mapa para associação retroativa via reply
  let mapUpdated = false;
  for (const item of pending.items) {
    if (item.msgId && pastaDestino) {
      msgIdSavedMap.set(item.msgId, {
        folderPath: pastaDestino,
        groupName: pending.groupName,
        authorName: pending.authorName,
        savedAt: Date.now(),
      });
      mapUpdated = true;
    }
  }
  if (mapUpdated) persistMsgIdMap();

  // Gap-flush sem protocolo: registra em recentlyFlushed para associação pelo mesmo autor
  if (loteFolder && pastaDestino) {
    const timeoutMs = getBufferTimeout(pending.groupName);
    recentlyFlushed.set(bufferKey, {
      savedPath: pastaDestino,
      groupName: pending.groupName,
      authorName: pending.authorName,
      expiresAt: Date.now() + timeoutMs,
    });
    setTimeout(() => recentlyFlushed.delete(bufferKey), timeoutMs + 1000);
  }

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
