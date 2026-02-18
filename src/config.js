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
  sessionDir: path.resolve(ROOT_DIR, './session'),

  // Buffer de agrupamento
  bufferTimeoutMs: parseInt(process.env.BUFFER_TIMEOUT_MS || '120000', 10),

  // Catch-up: horas para buscar mensagens perdidas no startup
  catchupHours: parseFloat(process.env.CATCHUP_HOURS || '1'),

  // Alertas
  alertNumber: process.env.ALERT_NUMBER || '',
  alertGroup: process.env.ALERT_GROUP || '',
  diskWarnGb: parseInt(process.env.DISK_WARN_GB || '5', 10),

  // Catch-up inteligente
  maxCatchupHours: parseFloat(process.env.MAX_CATCHUP_HOURS || '12'),

  // Buffer temp em disco (crash recovery)
  bufferTempDir: path.resolve(ROOT_DIR, 'archive/.buffer_temp'),
  lastActiveFile: path.resolve(ROOT_DIR, 'archive/.last_active'),

  // Regex
  regex: {
    // Qualquer sequência de 10 dígitos (protocolo genérico)
    protocolo: /\b(\d{10})\b/,
    // Protocolo válido: 2025 ou 2026 + 6 dígitos
    protocoloValido: /^(202[56]\d{6})$/,
  },

  // Extensões aceitas
  mediaTypes: ['image', 'video'],
  ignoredTypes: ['audio', 'document', 'ptt', 'sticker'],
};
