/**
 * Bot WhatsApp - Ponto de entrada
 *
 * Funcionalidades:
 * - Recebe fotos com legendas (AS no formato 202XXXXXXX)
 * - Valida formato da AS localmente
 * - Minimo 3 fotos por lote
 * - Salva em pasta local configuravel
 * - Relatorio diario por email + arquivo local
 */

const config = require('./config');
const { initialize } = require('./bot/whatsapp');
const { sendDailyReport } = require('./services/email');
const { ensureDir, getPhotosFolder, getReportsFolder } = require('./services/storage');

// Verifica configuracoes
function checkConfig() {
  const warnings = [];

  if (!config.claude.apiKey) {
    warnings.push('CLAUDE_API_KEY nao configurada (respostas inteligentes desativadas)');
  }

  if (!config.email.user || !config.email.pass) {
    warnings.push('Email nao configurado (relatorios apenas locais)');
  }

  if (warnings.length > 0) {
    console.log('\nAvisos:');
    warnings.forEach(w => console.log(`- ${w}`));
    console.log('');
  }

  return warnings.length === 0;
}

// Agenda relatorio diario (23:59)
function scheduleDailyReport() {
  const now = new Date();
  const target = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    23, 59, 0
  );

  if (now >= target) {
    target.setDate(target.getDate() + 1);
  }

  const delay = target - now;
  console.log(`Relatorio agendado: ${target.toLocaleString('pt-BR')}`);

  setTimeout(async () => {
    console.log('Enviando relatorio...');
    await sendDailyReport();
    scheduleDailyReport();
  }, delay);
}

// Inicializacao
async function main() {
  console.log('\n========================================');
  console.log('       BOT WHATSAPP - INICIANDO');
  console.log('========================================\n');

  // Cria pastas necessarias
  ensureDir(getPhotosFolder());
  ensureDir(getReportsFolder());

  // Verifica configs
  checkConfig();

  // Mostra configuracoes
  console.log('Configuracoes:');
  console.log(`- Pasta fotos: ${getPhotosFolder()}`);
  console.log(`- Pasta relatorios: ${getReportsFolder()}`);
  console.log(`- Min fotos/lote: ${config.minPhotosPerBatch}`);
  console.log(`- Numeros autorizados: ${config.allowedNumbers.length === 0 ? 'TODOS' : config.allowedNumbers.length}`);
  console.log('');

  // Inicia bot
  initialize();

  // Agenda relatorio
  scheduleDailyReport();

  // Comandos
  console.log('Comandos WhatsApp:');
  console.log('- FOTOS: iniciar lote');
  console.log('- ENVIAR: salvar lote');
  console.log('- PROXIMO: novo lote');
  console.log('- CANCELAR: descartar');
  console.log('- STATUS: ver lote atual');
  console.log('- AJUDA: comandos');
  console.log('');
}

// Erros globais
process.on('uncaughtException', (error) => {
  console.error('Erro:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('Promise rejeitada:', reason);
});

// Flag para evitar envio duplicado
let isShuttingDown = false;

// Encerramento gracioso (Ctrl+C ou kill)
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n\nRecebido ${signal}. Encerrando...`);

  try {
    console.log('Enviando relatorio antes de encerrar...');
    await sendDailyReport();
    console.log('Relatorio enviado!');
  } catch (error) {
    console.error('Erro ao enviar relatorio:', error.message);
  }

  console.log('Bot encerrado.');
  process.exit(0);
}

// Captura sinais de encerramento
process.on('SIGINT', () => gracefulShutdown('SIGINT'));   // Ctrl+C
process.on('SIGTERM', () => gracefulShutdown('SIGTERM')); // kill

// Windows: captura evento de fechar janela
if (process.platform === 'win32') {
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

main();
