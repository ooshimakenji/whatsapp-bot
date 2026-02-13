import { CONFIG } from './config.js';
import { startArchiver } from './archiver.js';
import fs from 'fs';

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
  console.log('  ║       WhatsApp Group Archiver        ║');
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
  process.exit(1);
});
