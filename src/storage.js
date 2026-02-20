import fs from 'fs';
import path from 'path';
import { CONFIG } from './config.js';
import { addAlert, registrarContagem } from './alerts.js';

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

// ============================================
// BUFFER TEMPORÁRIO EM DISCO (crash recovery)
// ============================================

function sanitizeBufferKey(bufferKey) {
  return bufferKey.replace(/[^a-zA-Z0-9]/g, '_');
}

export function saveTempMedia(bufferKey, seqNumber, mediaData, mimetype) {
  const ext = mimeToExt(mimetype);
  const tempDir = path.join(CONFIG.bufferTempDir, sanitizeBufferKey(bufferKey));
  ensureDir(tempDir);
  const filePath = path.join(tempDir, `${String(seqNumber).padStart(3, '0')}.${ext}`);
  fs.writeFileSync(filePath, Buffer.from(mediaData, 'base64'));
  return filePath;
}

export function saveTempMeta(bufferKey, meta) {
  const tempDir = path.join(CONFIG.bufferTempDir, sanitizeBufferKey(bufferKey));
  ensureDir(tempDir);
  fs.writeFileSync(path.join(tempDir, 'meta.json'), JSON.stringify(meta));
}

export function loadPersistentBuffers() {
  if (!fs.existsSync(CONFIG.bufferTempDir)) return [];
  const results = [];
  let folders;
  try { folders = fs.readdirSync(CONFIG.bufferTempDir); } catch { return []; }
  for (const folder of folders) {
    const folderPath = path.join(CONFIG.bufferTempDir, folder);
    const metaPath = path.join(folderPath, 'meta.json');
    if (!fs.existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (meta.bufferKey && meta.groupName && meta.authorName && Array.isArray(meta.items)) {
        results.push({ folderPath, meta });
      }
    } catch { /* pula corrompidos */ }
  }
  return results;
}

function cleanTempDir(bufferKey) {
  if (!bufferKey) return;
  const tempDir = path.join(CONFIG.bufferTempDir, sanitizeBufferKey(bufferKey));
  try {
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  } catch { /* best effort */ }
}

// ============================================
// SALVAR MÍDIA
// ============================================

// Processa bloco inteiro do autor (todas as mídias acumuladas no buffer)
// Lógica igual ao organizer offline: analisa todos os protocolos do bloco
export async function saveBufferedBlock(groupName, author, bufferedItems, protocolos, bufferKey = null) {
  const groupDir = sanitizarNomeGrupo(groupName);
  const autorSanitizado = sanitizarNomeAutor(author);

  // Filtra protocolos válidos e inválidos
  const protocolosValidos = protocolos.filter(p => isProtocoloValido(p));
  const protocolosInvalidos = protocolos.filter(p => !isProtocoloValido(p));

  let pastaDestino;
  let alertType = null;
  let alertMsg = null;

  if (protocolosValidos.length === 1) {
    // Um protocolo válido — caso ideal, tudo vai junto
    pastaDestino = path.join(CONFIG.archiveDir, groupDir, protocolosValidos[0]);
  } else if (protocolosValidos.length > 1) {
    // Múltiplos protocolos válidos — sem_legenda/{autor}/{proto1_proto2}/
    const nomePasta = protocolosValidos.join('_');
    pastaDestino = path.join(CONFIG.archiveDir, groupDir, 'sem_legenda', autorSanitizado, nomePasta);

    // Cria subpastas para cada protocolo
    for (const proto of protocolosValidos) {
      ensureDir(path.join(pastaDestino, proto));
    }

    alertType = 'multiplas_legendas';
    alertMsg = `Múltiplas legendas (${protocolosValidos.join(', ')}) - ${author} em ${groupName}`;
  } else if (protocolosInvalidos.length > 0) {
    // Só protocolos inválidos
    const nomePasta = protocolosInvalidos.join('_');
    pastaDestino = path.join(CONFIG.archiveDir, groupDir, 'protocolo_revisar', nomePasta);
    alertType = 'protocolo_revisar';
    alertMsg = `Protocolo(s) "${protocolosInvalidos.join(', ')}" fora do padrão 2025/2026 - ${author} em ${groupName}`;
  } else {
    // Sem protocolo nenhum
    pastaDestino = path.join(CONFIG.archiveDir, groupDir, 'sem_legenda', autorSanitizado);
    alertType = 'buffer_timeout';
    alertMsg = `${bufferedItems.length} mídia(s) sem legenda de ${author} em ${groupName} → sem_legenda/`;
  }

  ensureDir(pastaDestino);

  let salvos = 0;
  let erros = 0;

  for (const item of bufferedItems) {
    const ts = formatarTimestamp(item.timestamp);
    const ext = mimeToExt(item.mimetype);
    const seq = getNextSeq(pastaDestino);
    const fileName = `${ts}_${autorSanitizado}_${seq}.${ext}`;
    const filePath = path.join(pastaDestino, fileName);

    try {
      if (item.filePath && fs.existsSync(item.filePath)) {
        fs.copyFileSync(item.filePath, filePath);
      } else if (item.mediaData) {
        fs.writeFileSync(filePath, Buffer.from(item.mediaData, 'base64'));
      } else {
        const motivo = item.filePath
          ? `arquivo temp não encontrado: ${item.filePath}`
          : 'sem dados de mídia (download pode ter falhado)';
        throw new Error(motivo);
      }
      salvos++;

      // Loga no JSONL do dia
      saveTextMessage(groupName, author, `[mídia: ${fileName}]${item.caption ? ' ' + item.caption : ''}`, item.timestamp);
    } catch (err) {
      erros++;
      await addAlert('erro_salvar', `Erro ao salvar ${fileName} de ${author} em ${groupName}: ${err.message}`);
    }
  }

  // Alerta de sucesso — formato: [Nome][count → protocolo] Grupo
  if (salvos > 0) {
    const protoStr = protocolosValidos.length > 0 ? ` → ${protocolosValidos.join(', ')}` : '';
    await addAlert('salvo_sucesso', `[${author}][${salvos}${protoStr}] ${groupName}`);
  }

  // Registra contagem diária
  registrarContagem(author, groupName, protocolos, salvos, false);
  if (erros > 0) {
    registrarContagem(author, groupName, [], erros, true);
  }

  if (alertType) {
    await addAlert(alertType, alertMsg);
  }

  // Limpa pasta temp após mover os arquivos
  cleanTempDir(bufferKey);

  return { protocolosValidos, salvos };
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
