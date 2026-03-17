import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

export const CONFIG = {
  // Grupos para monitorar
  groups: (process.env.GROUPS || '')
    .split(',')
    .map(g => g.trim())
    .filter(Boolean),

  // Diretórios
  archiveDir: path.resolve(ROOT_DIR, process.env.ARCHIVE_DIR || './archive'),
  archiveFallbackDir: process.env.ARCHIVE_FALLBACK_DIR
    ? path.resolve(ROOT_DIR, process.env.ARCHIVE_FALLBACK_DIR)
    : null,
  // Diretório de arquivo por grupo — sobrescreve archiveDir para grupos específicos
  // Formato no .env: "NomeGrupo=Z:\caminho;OutroGrupo=X:\outro"
  groupArchiveDirs: Object.fromEntries(
    (process.env.GROUP_ARCHIVE_DIRS || '')
      .split(';')
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => {
        const idx = s.indexOf('=');
        if (idx === -1) return null;
        return [s.slice(0, idx).trim(), s.slice(idx + 1).trim()];
      })
      .filter(Boolean)
  ),
  sessionDir: path.resolve(ROOT_DIR, './session'),
  logsDir: path.resolve(ROOT_DIR, 'logs'),

  // Buffer de agrupamento
  bufferTimeoutMs: parseInt(process.env.BUFFER_TIMEOUT_MS || '120000', 10),
  // Gap entre mídias do mesmo autor para separar em lotes distintos
  // Se a nova mídia chegou mais de X ms depois da anterior, considera novo lote
  // 0 = desativado  |  padrão: 30s
  intraBufGapMs: parseInt(process.env.INTRA_BUFFER_GAP_MS || '30000', 10),

  // Timeout de buffer por grupo (sobrescreve bufferTimeoutMs para grupos específicos)
  // Formato: "NomeGrupo1:ms,NomeGrupo2:ms"  ex: "AGUA_TESTE_FEVEREIRO:10000"
  groupBufferMs: Object.fromEntries(
    (process.env.GROUP_BUFFER_MS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => {
        const idx = s.lastIndexOf(':');
        return [s.slice(0, idx).trim(), parseInt(s.slice(idx + 1), 10)];
      })
      .filter(([name, ms]) => name && !isNaN(ms))
  ),

  // Catch-up: horas para buscar mensagens perdidas no startup
  catchupHours: parseFloat(process.env.CATCHUP_HOURS || '1'),

  // Alertas
  alertNumber: process.env.ALERT_NUMBER || '',
  alertGroup: process.env.ALERT_GROUP || '',
  diskWarnGb: parseInt(process.env.DISK_WARN_GB || '5', 10),

  // Catch-up inteligente
  maxCatchupHours: parseFloat(process.env.MAX_CATCHUP_HOURS || '12'),

  // Buffer temp em disco (crash recovery) — configurável via BUFFER_TEMP_DIR no .env
  bufferTempDir: process.env.BUFFER_TEMP_DIR
    ? path.resolve(process.env.BUFFER_TEMP_DIR, '.buffer_temp')
    : path.resolve(ROOT_DIR, 'archive/.buffer_temp'),
  lastActiveFile: process.env.BUFFER_TEMP_DIR
    ? path.resolve(process.env.BUFFER_TEMP_DIR, '.last_active')
    : path.resolve(ROOT_DIR, 'archive/.last_active'),

  // Regex
  regex: {
    // Qualquer sequência de 10 dígitos (protocolo genérico)
    protocolo: /\b(\d{10})\b/,
    // Protocolo válido: 2025 ou 2026 + 6 dígitos
    protocoloValido: /^(202[56]\d{6})$/,
  },

  // Excel Online (Microsoft Graph API)
  excelFileId: process.env.EXCEL_FILE_ID || '',
  excelSheetName: process.env.EXCEL_SHEET_NAME || 'ASs entregues',
  excelStatusCol: process.env.EXCEL_STATUS_COL || 'J',

  // Extensões aceitas
  mediaTypes: ['image', 'video'],
  ignoredTypes: ['audio', 'document', 'ptt', 'sticker'],
};

// Retorna o diretório de arquivo para um grupo, com fallback para archiveDir
export function getArchiveDirForGroup(groupName) {
  const specific = groupName && CONFIG.groupArchiveDirs[groupName.trim()];
  return specific || CONFIG.archiveDir;
}
