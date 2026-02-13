import fs from 'fs';
import path from 'path';
import { CONFIG } from './config.js';
import { addAlert } from './alerts.js';

// Contador sequencial por pasta (para naming)
const seqCounters = new Map();

// ============================================
// FUNÇÕES UTILITÁRIAS (baseadas no whatsapp-organizer.js)
// ============================================

export function sanitizarNomeAutor(autor) {
  if (!autor) return 'desconhecido';

  if (autor.startsWith('+')) {
    return autor.replace(/[+\s]/g, '').replace(/-/g, '-');
  }

  return autor.replace(/[<>:"/\\|?*]/g, '').trim();
}

export function sanitizarNomeGrupo(nome) {
  if (!nome) return 'grupo-desconhecido';
  return nome.replace(/[<>:"/\\|?*]/g, '').trim();
}

export function formatarTimestamp(date) {
  if (!date) date = new Date();
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return 'sem-data';

  const ano = d.getFullYear();
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  const hora = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');

  return `${ano}-${mes}-${dia}_${hora}-${min}`;
}

function getDateStr(date) {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  return d.toISOString().slice(0, 10);
}

function getNextSeq(pastaDestino) {
  const current = seqCounters.get(pastaDestino) || 0;
  const next = current + 1;
  seqCounters.set(pastaDestino, next);
  return String(next).padStart(3, '0');
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// ============================================
// CLASSIFICAÇÃO DE PROTOCOLO
// ============================================

export function extractProtocolo(text) {
  if (!text) return null;
  const match = text.trim().match(CONFIG.regex.protocolo);
  return match ? match[1] : null;
}

export function extractAllProtocolos(text) {
  if (!text) return [];
  const matches = text.match(/\b\d{10}\b/g);
  return matches ? [...new Set(matches)] : [];
}

export function isProtocoloValido(numero) {
  if (!numero) return false;
  return CONFIG.regex.protocoloValido.test(numero);
}

// ============================================
// SALVAR MENSAGEM DE TEXTO
// ============================================

export function saveTextMessage(groupName, author, text, timestamp) {
  const groupDir = sanitizarNomeGrupo(groupName);
  const dateStr = getDateStr(timestamp);
  const msgDir = path.join(CONFIG.archiveDir, groupDir, dateStr);
  ensureDir(msgDir);

  const entry = {
    timestamp: (timestamp instanceof Date ? timestamp : new Date(timestamp)).toISOString(),
    author: author || 'desconhecido',
    text,
    type: 'text',
  };

  const filePath = path.join(msgDir, 'mensagens.jsonl');
  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
}

// ============================================
// SALVAR MÍDIA
// ============================================

export async function saveMedia(groupName, author, mediaData, mimetype, caption, timestamp) {
  const protocolos = extractAllProtocolos(caption);
  const groupDir = sanitizarNomeGrupo(groupName);
  const autorSanitizado = sanitizarNomeAutor(author);
  const ts = formatarTimestamp(timestamp);
  const ext = mimeToExt(mimetype);

  let pastaDestino;
  let alertType = null;
  let alertMsg = null;

  if (protocolos.length === 1) {
    const proto = protocolos[0];
    if (isProtocoloValido(proto)) {
      // Protocolo válido 2025/2026
      pastaDestino = path.join(CONFIG.archiveDir, groupDir, proto);
    } else {
      // Protocolo fora do padrão
      pastaDestino = path.join(CONFIG.archiveDir, groupDir, 'protocolo_revisar', proto);
      alertType = 'protocolo_revisar';
      alertMsg = `Protocolo "${proto}" fora do padrão 2025/2026 - ${author} em ${groupName}`;
    }
  } else if (protocolos.length > 1) {
    // Múltiplas legendas
    const nomePasta = protocolos.join('_');
    pastaDestino = path.join(CONFIG.archiveDir, groupDir, 'sem_legenda', autorSanitizado, nomePasta);

    // Cria subpastas para cada protocolo
    for (const proto of protocolos) {
      ensureDir(path.join(pastaDestino, proto));
    }

    alertType = 'multiplas_legendas';
    alertMsg = `Múltiplas legendas (${protocolos.join(', ')}) - ${author} em ${groupName}`;
  } else {
    // Sem legenda
    pastaDestino = path.join(CONFIG.archiveDir, groupDir, 'sem_legenda', autorSanitizado);
  }

  ensureDir(pastaDestino);
  const seq = getNextSeq(pastaDestino);
  const fileName = `${ts}_${autorSanitizado}_${seq}.${ext}`;
  const filePath = path.join(pastaDestino, fileName);

  // Salva arquivo
  const buffer = Buffer.from(mediaData, 'base64');
  fs.writeFileSync(filePath, buffer);

  // Também loga a mídia no JSONL do dia
  saveTextMessage(groupName, author, `[mídia: ${fileName}]${caption ? ' ' + caption : ''}`, timestamp);

  if (alertType) {
    await addAlert(alertType, alertMsg);
  }

  return { filePath, pastaDestino, protocolos };
}

// Salva mídia pendente do buffer quando chega o protocolo
export async function saveBufferedMedia(groupName, author, bufferedItems, protocolo, timestamp) {
  const groupDir = sanitizarNomeGrupo(groupName);
  const autorSanitizado = sanitizarNomeAutor(author);

  let pastaDestino;
  let alertType = null;
  let alertMsg = null;

  if (isProtocoloValido(protocolo)) {
    pastaDestino = path.join(CONFIG.archiveDir, groupDir, protocolo);
  } else {
    pastaDestino = path.join(CONFIG.archiveDir, groupDir, 'protocolo_revisar', protocolo);
    alertType = 'protocolo_revisar';
    alertMsg = `Protocolo "${protocolo}" fora do padrão 2025/2026 - ${author} em ${groupName}`;
  }

  ensureDir(pastaDestino);

  for (const item of bufferedItems) {
    const ts = formatarTimestamp(item.timestamp);
    const ext = mimeToExt(item.mimetype);
    const seq = getNextSeq(pastaDestino);
    const fileName = `${ts}_${autorSanitizado}_${seq}.${ext}`;
    const filePath = path.join(pastaDestino, fileName);

    const buffer = Buffer.from(item.mediaData, 'base64');
    fs.writeFileSync(filePath, buffer);
  }

  if (alertType) {
    await addAlert(alertType, alertMsg);
  }
}

// Salva mídia do buffer quando dá timeout (sem legenda)
export async function saveBufferedMediaNoLabel(groupName, author, bufferedItems) {
  const groupDir = sanitizarNomeGrupo(groupName);
  const autorSanitizado = sanitizarNomeAutor(author);
  const pastaDestino = path.join(CONFIG.archiveDir, groupDir, 'sem_legenda', autorSanitizado);

  ensureDir(pastaDestino);

  for (const item of bufferedItems) {
    const ts = formatarTimestamp(item.timestamp);
    const ext = mimeToExt(item.mimetype);
    const seq = getNextSeq(pastaDestino);
    const fileName = `${ts}_${autorSanitizado}_${seq}.${ext}`;
    const filePath = path.join(pastaDestino, fileName);

    const buffer = Buffer.from(item.mediaData, 'base64');
    fs.writeFileSync(filePath, buffer);
  }

  await addAlert('buffer_timeout', `${bufferedItems.length} mídia(s) sem legenda de ${author} em ${groupName} → sem_legenda/`);
}

// ============================================
// UTILS
// ============================================

function mimeToExt(mimetype) {
  if (!mimetype) return 'bin';
  const map = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/3gpp': '3gp',
    'video/quicktime': 'mov',
  };
  return map[mimetype] || mimetype.split('/')[1] || 'bin';
}
