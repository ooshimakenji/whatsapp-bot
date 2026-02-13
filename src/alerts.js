import fs from 'fs';
import path from 'path';
import os from 'os';
import { CONFIG } from './config.js';

// Alertas acumulados no dia
let alertasDoDia = [];
let client = null;
let alertNumberJid = null;
let diskCheckInterval = null;
let dailyReportTimeout = null;

const ICONS = {
  protocolo_revisar: '🔢',
  multiplas_legendas: '📂',
  grupo_nao_encontrado: '❌',
  disco_cheio: '💾',
  erro: '⚠️',
  info: '📋',
  buffer_timeout: '⏱️',
};

export function initAlerts(whatsappClient) {
  client = whatsappClient;

  // Detecta número para DM
  const alertNum = CONFIG.alertNumber || client.info?.wid?.user;
  if (alertNum) {
    alertNumberJid = `${alertNum}@c.us`;
  }

  // Verifica disco a cada 30 minutos
  diskCheckInterval = setInterval(checkDiskSpace, 30 * 60 * 1000);
  checkDiskSpace();

  // Agenda relatório diário às 23:59
  scheduleDailyReport();
}

export function stopAlerts() {
  if (diskCheckInterval) clearInterval(diskCheckInterval);
  if (dailyReportTimeout) clearTimeout(dailyReportTimeout);
}

export async function addAlert(tipo, mensagem) {
  const icon = ICONS[tipo] || '•';
  const timestamp = new Date().toLocaleString('pt-BR');
  const alertText = `${icon} [${timestamp}] ${mensagem}`;

  // Console
  console.log(`  ALERTA: ${alertText}`);

  // Acumula para relatório
  alertasDoDia.push(alertText);

  // WhatsApp DM
  if (client && alertNumberJid) {
    try {
      await client.sendMessage(alertNumberJid, `[Archiver] ${alertText}`);
    } catch (err) {
      console.error('  Erro ao enviar alerta DM:', err.message);
    }
  }
}

function checkDiskSpace() {
  try {
    const freeMb = os.freemem() / (1024 * 1024);
    // No Windows, os.freemem() retorna RAM livre, não disco.
    // Usamos uma abordagem via fs.statfs (Node 18.15+)
    const archivePath = CONFIG.archiveDir;
    if (!fs.existsSync(archivePath)) {
      fs.mkdirSync(archivePath, { recursive: true });
    }

    // Node 18.15+ tem fs.statfsSync
    if (fs.statfsSync) {
      const stats = fs.statfsSync(archivePath);
      const freeGb = (stats.bavail * stats.bsize) / (1024 * 1024 * 1024);
      if (freeGb < CONFIG.diskWarnGb) {
        addAlert('disco_cheio', `Espaço em disco baixo: ${freeGb.toFixed(1)} GB restantes (limite: ${CONFIG.diskWarnGb} GB)`);
      }
    }
  } catch {
    // Silently ignore - disk check is best-effort
  }
}

function scheduleDailyReport() {
  const now = new Date();
  const target = new Date(now);
  target.setHours(23, 59, 0, 0);

  if (target <= now) {
    target.setDate(target.getDate() + 1);
  }

  const delay = target - now;
  dailyReportTimeout = setTimeout(async () => {
    await generateDailyReport();
    scheduleDailyReport(); // Re-agenda para próximo dia
  }, delay);
}

async function generateDailyReport() {
  const hoje = new Date().toISOString().slice(0, 10);
  const logsDir = path.join(CONFIG.archiveDir, 'logs');

  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  const content = `
==========================================
RELATÓRIO DIÁRIO - WhatsApp Archiver
==========================================
Data: ${hoje}
Gerado em: ${new Date().toLocaleString('pt-BR')}

==========================================
ALERTAS DO DIA (${alertasDoDia.length})
==========================================
${alertasDoDia.length > 0 ? alertasDoDia.join('\n') : 'Nenhum alerta.'}

==========================================
`.trim();

  const logPath = path.join(logsDir, `${hoje}_relatorio.txt`);
  fs.writeFileSync(logPath, content);
  console.log(`\n  Relatório diário salvo: ${logPath}`);

  // Envia resumo por DM
  if (client && alertNumberJid && alertasDoDia.length > 0) {
    try {
      await client.sendMessage(
        alertNumberJid,
        `[Archiver] Relatório ${hoje}: ${alertasDoDia.length} alerta(s). Salvo em ${logPath}`
      );
    } catch {
      // best-effort
    }
  }

  // Reseta alertas para próximo dia
  alertasDoDia = [];
}
