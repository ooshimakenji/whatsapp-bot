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

// Contagem diária por autor: { "autor|grupo": { protocolos: Map<proto, qtdMidias>, erros: number } }
const contagemDiaria = new Map();

const ICONS = {
  protocolo_revisar: '🔢',
  multiplas_legendas: '📂',
  grupo_nao_encontrado: '❌',
  disco_cheio: '💾',
  erro: '⚠️',
  erro_salvar: '❌',
  salvo_sucesso: '✅',
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
      await client.sendMessage(alertNumberJid, `[Bila] ${alertText}`);
    } catch (err) {
      console.error('  Erro ao enviar alerta DM:', err.message);
    }
  }
}

// Registra contagem de mídias/protocolos por autor
export function registrarContagem(author, groupName, protocolos, qtdMidias, erro = false) {
  const key = `${author}|${groupName}`;
  let entry = contagemDiaria.get(key);
  if (!entry) {
    entry = { protocolos: new Map(), erros: 0 };
    contagemDiaria.set(key, entry);
  }
  if (erro) {
    entry.erros += qtdMidias;
  } else {
    for (const p of protocolos) {
      entry.protocolos.set(p, (entry.protocolos.get(p) || 0) + qtdMidias);
    }
    // Sem protocolo — conta como "sem_legenda"
    if (protocolos.length === 0) {
      entry.protocolos.set('sem_legenda', (entry.protocolos.get('sem_legenda') || 0) + qtdMidias);
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

  // Monta resumo de contagem por autor
  let contagemTexto = '';
  let contagemDM = '';
  let poucasFotosTexto = '';
  let totalMidias = 0;
  let totalProtocolos = new Set();
  let totalErros = 0;
  const poucasFotos = []; // AS com menos de 3 mídias

  if (contagemDiaria.size > 0) {
    const linhas = [];
    for (const [key, entry] of contagemDiaria) {
      const [autor, grupo] = key.split('|');
      let midiasAutor = 0;
      let asCount = 0;

      for (const [proto, qtd] of entry.protocolos) {
        midiasAutor += qtd;
        if (proto !== 'sem_legenda') {
          asCount++;
          totalProtocolos.add(proto);
          if (qtd < 3) {
            poucasFotos.push({ proto, autor, grupo, qtd });
          }
        }
      }

      totalMidias += midiasAutor;
      totalErros += entry.erros;
      linhas.push(`  - ${autor} (${grupo}): ${midiasAutor} mídia(s), ${asCount} AS(s)${entry.erros > 0 ? `, ${entry.erros} erro(s)` : ''}`);
    }
    contagemTexto = linhas.join('\n');
    contagemDM = linhas.join('\n');
  } else {
    contagemTexto = '  Nenhuma mídia processada.';
    contagemDM = 'Nenhuma mídia processada.';
  }

  if (poucasFotos.length > 0) {
    poucasFotosTexto = poucasFotos
      .map(p => `  - AS ${p.proto}: ${p.qtd} mídia(s) - ${p.autor} (${p.grupo})`)
      .join('\n');
  } else {
    poucasFotosTexto = '  Nenhuma.';
  }

  const content = `
==========================================
RELATÓRIO DIÁRIO - WhatsApp Bila Organizer
==========================================
Data: ${hoje}
Gerado em: ${new Date().toLocaleString('pt-BR')}

==========================================
RESUMO
==========================================
Total de mídias salvas: ${totalMidias}
Total de AS (protocolos): ${totalProtocolos.size}
Total de erros: ${totalErros}

==========================================
CONTAGEM POR ENCANADOR
==========================================
${contagemTexto}

==========================================
AS COM MENOS DE 3 FOTOS/VÍDEOS (${poucasFotos.length})
==========================================
${poucasFotosTexto}

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
  if (client && alertNumberJid) {
    try {
      const poucasFotosDM = poucasFotos.length > 0
        ? `\n\n⚠️ *AS com menos de 3 fotos/vídeos (${poucasFotos.length}):*\n${poucasFotos.map(p => `  - AS ${p.proto}: ${p.qtd} mídia(s) - ${p.autor}`).join('\n')}`
        : '';
      const dmText = `📊 *Relatório ${hoje}*\n\n` +
        `*Resumo:* ${totalMidias} mídia(s), ${totalProtocolos.size} AS(s)${totalErros > 0 ? `, ${totalErros} erro(s)` : ''}\n\n` +
        `*Por encanador:*\n${contagemDM}` +
        poucasFotosDM +
        `\n\n${alertasDoDia.length > 0 ? `*Alertas:* ${alertasDoDia.length}` : 'Sem alertas.'}`;
      await client.sendMessage(alertNumberJid, dmText);
    } catch {
      // best-effort
    }
  }

  // Reseta alertas e contagem para próximo dia
  alertasDoDia = [];
  contagemDiaria.clear();
}
