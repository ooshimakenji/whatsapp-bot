/**
 * Bot WhatsApp - Ponto de entrada
 *
 * Funcionalidades:
 * - Recebe fotos com legendas numericas (202XXXXXXXXX)
 * - Valida legendas com Claude API
 * - Minimo 3 fotos por lote
 * - Upload automatico para OneDrive
 * - Relatorio diario por email
 */

const config = require('./config');
const { initialize } = require('./bot/whatsapp');
const { sendDailyReport, getStats } = require('./services/email');

// Verifica configuracoes essenciais
function checkConfig() {
  const missing = [];

  if (!config.claude.apiKey) missing.push('CLAUDE_API_KEY');
  if (!config.microsoft.clientId) missing.push('MICROSOFT_CLIENT_ID');
  if (!config.microsoft.clientSecret) missing.push('MICROSOFT_CLIENT_SECRET');
  if (!config.microsoft.tenantId) missing.push('MICROSOFT_TENANT_ID');

  if (missing.length > 0) {
    console.log('\n========================================');
    console.log('ATENCAO: Configuracoes faltando no .env');
    console.log('========================================');
    missing.forEach(m => console.log(`- ${m}`));
    console.log('\nEdite o arquivo .env e preencha os valores.');
    console.log('O bot vai iniciar, mas algumas funcoes nao vao funcionar.\n');
  }

  return missing.length === 0;
}

// Agenda envio do relatorio diario (23:59)
function scheduleDailyReport() {
  const now = new Date();
  const targetHour = 23;
  const targetMinute = 59;

  let target = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    targetHour,
    targetMinute,
    0
  );

  // Se ja passou do horario hoje, agenda para amanha
  if (now >= target) {
    target.setDate(target.getDate() + 1);
  }

  const delay = target - now;

  console.log(`Relatorio diario agendado para: ${target.toLocaleString('pt-BR')}`);

  setTimeout(async () => {
    console.log('Enviando relatorio diario...');
    await sendDailyReport();

    // Reagenda para o proximo dia
    scheduleDailyReport();
  }, delay);
}

// Funcao principal
async function main() {
  console.log('\n========================================');
  console.log('       BOT WHATSAPP - INICIANDO');
  console.log('========================================\n');

  // Verifica configuracoes
  checkConfig();

  // Mostra configuracoes atuais
  console.log('Configuracoes:');
  console.log(`- Pasta OneDrive: ${config.onedrive.folder}`);
  console.log(`- Minimo fotos/lote: ${config.minPhotosPerBatch}`);
  console.log(`- Numeros autorizados: ${config.allowedNumbers.length === 0 ? 'TODOS' : config.allowedNumbers.join(', ')}`);
  console.log('');

  // Inicia o bot WhatsApp
  initialize();

  // Agenda relatorio diario
  if (config.email.user && config.email.to) {
    scheduleDailyReport();
  } else {
    console.log('Email nao configurado - relatorio diario desativado');
  }

  // Mostra comandos disponiveis
  console.log('\nComandos no WhatsApp:');
  console.log('- FOTOS: inicia envio de fotos');
  console.log('- ENVIAR: faz upload do lote');
  console.log('- PROXIMO: inicia proximo lote');
  console.log('- AJUDA: mostra ajuda');
  console.log('');
}

// Trata erros nao capturados
process.on('uncaughtException', (error) => {
  console.error('Erro nao tratado:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Promise rejeitada:', reason);
});

// Inicia
main();
