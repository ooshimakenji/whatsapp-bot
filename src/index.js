import { CONFIG } from './config.js';
import { startArchiver } from './archiver-baileys.js';
import { logEvent } from './eventlog.js';
import fs from 'fs';
import path from 'path';

// Conta restarts consecutivos via arquivo temporário
const RESTART_FILE = path.resolve(CONFIG.sessionDir, '..', '.restart_count');
const MAX_RESTARTS_BEFORE_CLEAR = 3;

const DRIVE_MAX_RETRIES = 3;
const DRIVE_RETRY_MS = 30_000; // 30s entre tentativas

async function checkConfig() {
  if (CONFIG.groups.length === 0) {
    console.error('  Nenhum grupo configurado! Defina GROUPS no .env');
    console.error('  Exemplo: GROUPS=Grupo 1, Grupo 2');
    process.exit(1);
  }

  // Tenta criar o diretório de archive com retry se o drive não estiver disponível
  for (let attempt = 1; attempt <= DRIVE_MAX_RETRIES + 1; attempt++) {
    try {
      if (!fs.existsSync(CONFIG.archiveDir)) {
        fs.mkdirSync(CONFIG.archiveDir, { recursive: true });
      }
      if (attempt > 1) {
        console.log('  Drive disponível — continuando...');
        return `Drive estava indisponível no startup (disponível após ${attempt - 1} tentativa(s))`;
      }
      return null; // Sem aviso — drive estava ok desde o início
    } catch (err) {
      const isDriveError = ['ENOENT', 'ENOTCONN', 'ENODEV', 'ENOMEDIUM', 'EIO'].includes(err.code);
      if (isDriveError && attempt <= DRIVE_MAX_RETRIES) {
        console.warn(`\n  [AVISO] Drive indisponivel: ${CONFIG.archiveDir} (${err.code})`);
        console.warn(`  Tentando novamente em ${DRIVE_RETRY_MS / 1000}s... (${attempt}/${DRIVE_MAX_RETRIES})\n`);
        logEvent('DRIVE_RETRY', `Drive indisponivel, tentativa ${attempt}/${DRIVE_MAX_RETRIES}`, `${CONFIG.archiveDir} (${err.code})`);
        await new Promise(r => setTimeout(r, DRIVE_RETRY_MS));
      } else if (isDriveError) {
        console.warn(`\n  [AVISO] Drive ainda indisponivel apos ${DRIVE_MAX_RETRIES} tentativas.`);
        const driveOriginal = CONFIG.archiveDir;
        if (CONFIG.archiveFallbackDir) {
          console.warn(`  Usando caminho reserva: ${CONFIG.archiveFallbackDir}\n`);
          CONFIG.archiveDir = CONFIG.archiveFallbackDir;
          fs.mkdirSync(CONFIG.archiveDir, { recursive: true });
          logEvent('DRIVE_FALLBACK', 'Drive indisponivel — usando caminho reserva', `${driveOriginal} → ${CONFIG.archiveFallbackDir}`);
          return `Drive indisponivel (${driveOriginal}) — arquivos salvos no caminho reserva: ${CONFIG.archiveFallbackDir}`;
        }
        logEvent('DRIVE_ERRO', 'Drive indisponivel sem caminho reserva configurado', `${driveOriginal} (${err.code})`);
        console.warn('  Bot iniciara sem acesso ao drive — alerta sera enviado via WhatsApp.\n');
        return `Drive indisponivel no startup: ${driveOriginal} (${err.code})`;
      } else {
        throw err; // Outros erros ainda crasham normalmente
      }
    }
  }
  return null;
}

async function main() {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║           WhatsApp Bila Organizer              ║');
  console.log('  ║         Modo: 100% Passivo           ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
  console.log(`  Grupos: ${CONFIG.groups.join(', ')}`);
  console.log(`  Arquivo: ${CONFIG.archiveDir}`);
  if (CONFIG.archiveFallbackDir) {
    console.log(`  Reserva: ${CONFIG.archiveFallbackDir}`);
  }
  console.log(`  Buffer: ${CONFIG.bufferTimeoutMs / 1000}s`);
  console.log('');

  logEvent('STARTUP', 'Bot iniciando', `Arquivo: ${CONFIG.archiveDir} | Grupos: ${CONFIG.groups.join(', ')}`);
  const driveWarning = await checkConfig();
  await startArchiver(driveWarning);
}

main().catch((err) => {
  console.error('  Erro fatal:', err);
  logEvent('CRASH', err.message || 'Erro fatal desconhecido', err.code || '');

  // Conta restarts — se crashar muitas vezes seguidas, limpa sessão
  let restartCount = 0;
  try {
    if (fs.existsSync(RESTART_FILE)) {
      restartCount = parseInt(fs.readFileSync(RESTART_FILE, 'utf8'), 10) || 0;
    }
  } catch (e) { /* ignora */ }

  restartCount++;
  console.log(`  Crash #${restartCount}/${MAX_RESTARTS_BEFORE_CLEAR}`);

  if (restartCount >= MAX_RESTARTS_BEFORE_CLEAR) {
    console.log('  Muitos crashes seguidos — limpando sessão para forçar novo QR code...');
    try {
      fs.rmSync(CONFIG.sessionDir, { recursive: true, force: true });
      console.log('  Sessão limpa com sucesso.');
    } catch (e) {
      console.error('  Erro ao limpar sessão:', e.message);
    }
    // Reseta contador
    try { fs.unlinkSync(RESTART_FILE); } catch (e) { /* ignora */ }
  } else {
    try { fs.writeFileSync(RESTART_FILE, String(restartCount)); } catch (e) { /* ignora */ }
  }

  process.exit(1);
});
