const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const config = require('../config');

// Configuracao do transporter para Outlook
const transporter = nodemailer.createTransport({
  host: 'smtp-mail.outlook.com',
  port: 587,
  secure: false,
  auth: {
    user: config.email.user,
    pass: config.email.pass
  },
  tls: {
    ciphers: 'SSLv3'
  }
});

// Armazena estatisticas do dia
let dailyStats = {
  date: new Date().toISOString().split('T')[0],
  totalPhotos: 0,
  totalBatches: 0,
  successUploads: 0,
  failedUploads: 0,
  rejectedPhotos: 0,
  details: []
};

/**
 * Registra atividade para o relatorio
 */
function logActivity(activity) {
  const today = new Date().toISOString().split('T')[0];

  // Reseta se mudou o dia
  if (dailyStats.date !== today) {
    dailyStats = {
      date: today,
      totalPhotos: 0,
      totalBatches: 0,
      successUploads: 0,
      failedUploads: 0,
      rejectedPhotos: 0,
      details: []
    };
  }

  dailyStats.details.push({
    time: new Date().toLocaleTimeString('pt-BR'),
    ...activity
  });

  // Atualiza contadores
  if (activity.type === 'batch_complete') {
    dailyStats.totalBatches++;
    dailyStats.totalPhotos += activity.photoCount || 0;
    dailyStats.successUploads += activity.success || 0;
    dailyStats.failedUploads += activity.failed || 0;
  } else if (activity.type === 'rejected') {
    dailyStats.rejectedPhotos++;
  }

  // Salva em arquivo para persistencia
  saveStatsToFile();
}

/**
 * Salva estatisticas em arquivo
 */
function saveStatsToFile() {
  const reportsDir = path.join(__dirname, '../../reports');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const fileName = `relatorio_${dailyStats.date}.json`;
  fs.writeFileSync(
    path.join(reportsDir, fileName),
    JSON.stringify(dailyStats, null, 2)
  );
}

/**
 * Gera HTML do relatorio
 */
function generateReportHtml() {
  return `
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; padding: 20px; }
        h1 { color: #25D366; }
        .stats { background: #f5f5f5; padding: 15px; border-radius: 8px; margin: 20px 0; }
        .stat-item { margin: 10px 0; }
        .success { color: #28a745; }
        .failed { color: #dc3545; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { padding: 10px; border: 1px solid #ddd; text-align: left; }
        th { background: #25D366; color: white; }
      </style>
    </head>
    <body>
      <h1>Relatorio Diario - Bot WhatsApp</h1>
      <p>Data: ${dailyStats.date}</p>

      <div class="stats">
        <div class="stat-item"><strong>Total de Lotes:</strong> ${dailyStats.totalBatches}</div>
        <div class="stat-item"><strong>Total de Fotos:</strong> ${dailyStats.totalPhotos}</div>
        <div class="stat-item success"><strong>Uploads com Sucesso:</strong> ${dailyStats.successUploads}</div>
        <div class="stat-item failed"><strong>Uploads Falhos:</strong> ${dailyStats.failedUploads}</div>
        <div class="stat-item failed"><strong>Fotos Rejeitadas:</strong> ${dailyStats.rejectedPhotos}</div>
      </div>

      <h2>Detalhes</h2>
      <table>
        <tr>
          <th>Hora</th>
          <th>Tipo</th>
          <th>Detalhes</th>
        </tr>
        ${dailyStats.details.map(d => `
          <tr>
            <td>${d.time}</td>
            <td>${d.type}</td>
            <td>${d.message || '-'}</td>
          </tr>
        `).join('')}
      </table>
    </body>
    </html>
  `;
}

/**
 * Envia relatorio diario por email
 */
async function sendDailyReport() {
  try {
    const html = generateReportHtml();

    const info = await transporter.sendMail({
      from: config.email.user,
      to: config.email.to,
      subject: `Relatorio Bot WhatsApp - ${dailyStats.date}`,
      html: html
    });

    console.log('Relatorio enviado:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('Erro ao enviar relatorio:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Retorna estatisticas atuais
 */
function getStats() {
  return { ...dailyStats };
}

/**
 * Carrega estatisticas do arquivo (para quando reiniciar)
 */
function loadStatsFromFile() {
  const today = new Date().toISOString().split('T')[0];
  const reportsDir = path.join(__dirname, '../../reports');
  const fileName = `relatorio_${today}.json`;
  const filePath = path.join(reportsDir, fileName);

  if (fs.existsSync(filePath)) {
    try {
      dailyStats = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      console.log('Iniciando novo relatorio do dia');
    }
  }
}

// Carrega stats ao iniciar
loadStatsFromFile();

module.exports = {
  logActivity,
  sendDailyReport,
  getStats
};
