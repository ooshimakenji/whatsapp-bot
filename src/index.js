import { CONFIG } from './config.js';
import { startArchiver } from './archiver-baileys.js';
import fs from 'fs';
import path from 'path';

// Conta restarts consecutivos via arquivo temporário
const RESTART_FILE = path.resolve(CONFIG.sessionDir, '..', '.restart_count');
const MAX_RESTARTS_BEFORE_CLEAR = 3;

function checkConfig() {
  if (CONFIG.groups.length === 0) {
    console.error('  Nenhum grupo configurado! Defina GROUPS no .env');
    console.error('  Exemplo: GROUPS=Grupo 1, Grupo 2');
    process.exit(1);
  }

  // Garante que diretório de archive existe
  if (!fs.existsSync(CONFIG.archiveDir)) {
    fs.mkdirSync(CONFIG.archiveDir, { recursive: true });
  }
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
  console.log(`  Buffer: ${CONFIG.bufferTimeoutMs / 1000}s`);
  console.log('');

  checkConfig();
  await startArchiver();
}

main().catch((err) => {
  console.error('  Erro fatal:', err);

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
