import fs from 'fs';
import path from 'path';
import os from 'os';
import { CONFIG } from './config.js';

// Alertas acumulados no dia
let alertasDoDia = [];
let client = null;
let alertChatJid = null;
let diskCheckInterval = null;
let dailyReportTimeout = null;

// Contagem diária por autor: { "autor|grupo": { protocolos: Map<proto, qtdMidias>, erros: number } }
const contagemDiaria = new Map();

// Tipos que ficam só no console — não enviam mensagem no WhatsApp (reduz ruído no LOGS_BOT)
const CONSOLE_ONLY_TYPES = new Set([]);

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
  barcode: '🔍',
};

export async function initAlerts(whatsappClient) {
  client = whatsappClient;

  // Busca grupo de alertas por nome (ALERT_GROUP), ou cai no DM próprio como fallback
  try {
    const chats = await client.getChats();
    if (CONFIG.alertGroup) {
      const groupChat = chats.find(c => c.isGroup && c.name === CONFIG.alertGroup);
      if (groupChat) {
        alertChatJid = groupChat.id._serialized;
        console.log(`  Alertas configurados para o grupo: ${CONFIG.alertGroup}`);
      } else {
        console.warn(`  Grupo de alertas "${CONFIG.alertGroup}" não encontrado — alertas desativados.`);
      }
    } else {
      // Fallback: DM para si mesmo
      const myNumber = CONFIG.alertNumber || client.info?.wid?.user;
      if (myNumber) {
        const myJid = `${myNumber}@c.us`;
        const selfChat = chats.find(c => c.id._serialized === myJid || c.id.user === myNumber);
        if (selfChat) {
          alertChatJid = selfChat.id._serialized;
        } else {
          const numberId = await client.getNumberId(myNumber);
          alertChatJid = numberId?._serialized || myJid;
        }
        console.log(`  Alertas DM configurados para: ${alertChatJid}`);
      }
    }
  } catch (err) {
    console.error('  Erro ao configurar alertas:', err.message);
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

  // salvo_sucesso: conteúdo vem primeiro (aparece na miniatura do WhatsApp)
  // demais: formato padrão com timestamp no início
  const alertText = tipo === 'salvo_sucesso'
    ? `${icon} ${mensagem} [${timestamp}]`
    : `${icon} [${timestamp}] ${mensagem}`;

  const whatsappText = tipo === 'salvo_sucesso'
    ? `${mensagem} ${icon} [B.]`
    : `${alertText} [B.]`;

  // Console
  console.log(`  ALERTA: ${alertText}`);

  // Acumula para relatório
  alertasDoDia.push(alertText);

  // WhatsApp grupo/DM — exceto tipos console-only
  if (client && alertChatJid && !CONSOLE_ONLY_TYPES.has(tipo)) {
    try {
      await client.sendMessage(alertChatJid, whatsappText);
    } catch (err) {
      console.error('  Erro ao enviar alerta:', err.message);
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
  const logsDir = CONFIG.logsDir;

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
  if (client && alertChatJid) {
    try {
      const poucasFotosDM = poucasFotos.length > 0
        ? `\n\n⚠️ *AS com menos de 3 fotos/vídeos (${poucasFotos.length}):*\n${poucasFotos.map(p => `  - AS ${p.proto}: ${p.qtd} mídia(s) - ${p.autor}`).join('\n')}`
        : '';
      const dmText = `📊 *Relatório ${hoje}*\n\n` +
        `*Resumo:* ${totalMidias} mídia(s), ${totalProtocolos.size} AS(s)${totalErros > 0 ? `, ${totalErros} erro(s)` : ''}\n\n` +
        `*Por encanador:*\n${contagemDM}` +
        poucasFotosDM +
        `\n\n${alertasDoDia.length > 0 ? `*Alertas:* ${alertasDoDia.length}` : 'Sem alertas.'}`;
      await client.sendMessage(alertChatJid, dmText);
    } catch {
      // best-effort
    }
  }

  // Reseta alertas e contagem para próximo dia
  alertasDoDia = [];
  contagemDiaria.clear();
}
