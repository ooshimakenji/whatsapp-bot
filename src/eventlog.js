/**
 * eventlog.js — Log centralizado de eventos críticos em CSV
 *
 * Salvo em logs/eventos.csv (local ao projeto, não depende do drive X:).
 * Abre diretamente no Excel com colunas: Data, Hora, Tipo, Mensagem, Detalhes
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const LOG_DIR = path.join(ROOT_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'eventos.csv');
const HEADER = 'Data,Hora,Tipo,Mensagem,Detalhes\n';

function ensureLog() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, HEADER, 'utf8');
}

function escape(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

export function logEvent(tipo, mensagem, detalhes = '') {
  try {
    const now = new Date();
    const data = now.toLocaleDateString('pt-BR');
    const hora = now.toLocaleTimeString('pt-BR');
    const line = [data, hora, tipo, mensagem, detalhes].map(escape).join(',') + '\n';
    ensureLog();
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch { /* best-effort — nunca impede o bot de rodar */ }
}
