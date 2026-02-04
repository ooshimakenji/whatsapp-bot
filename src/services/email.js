const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { ensureDir, getPhotosFolder } = require('./storage');

// Configuracao do transporter
let transporter = null;

if (config.email.user && config.email.pass) {
  transporter = nodemailer.createTransport({
    host: config.email.host,
    port: config.email.port,
    secure: false,
    auth: {
      user: config.email.user,
      pass: config.email.pass
    },
    tls: {
      ciphers: 'SSLv3'
    }
  });
}

// Armazena estatisticas do dia
let dailyStats = {
  date: new Date().toISOString().split('T')[0],
  totalPhotos: 0,
  totalBatches: 0,
  batchesWithAS: 0,
  batchesWithoutAS: 0,
  totalDuplicates: 0,
  batchesWithDuplicates: [],
  pendingAS: [],
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
      batchesWithAS: 0,
      batchesWithoutAS: 0,
      totalDuplicates: 0,
      batchesWithDuplicates: [],
      pendingAS: [],
      details: []
    };
  }

  dailyStats.details.push({
    time: new Date().toLocaleTimeString('pt-BR'),
    ...activity
  });

  // Atualiza contadores baseado no tipo
  if (activity.type === 'batch_complete') {
    dailyStats.totalBatches++;
    dailyStats.totalPhotos += activity.photoCount || 0;
    dailyStats.batchesWithAS++;

    // Registra duplicatas
    if (activity.duplicates && activity.duplicates > 0) {
      dailyStats.totalDuplicates += activity.duplicates;
      dailyStats.batchesWithDuplicates.push({
        time: new Date().toLocaleTimeString('pt-BR'),
        collaborator: activity.collaborator,
        as: activity.message.split(' - ')[0].replace('AS ', ''),
        duplicates: activity.duplicates,
        photoCount: activity.photoCount
      });
    }
  } else if (activity.type === 'batch_no_as') {
    dailyStats.totalBatches++;
    dailyStats.totalPhotos += activity.photoCount || 0;
    dailyStats.batchesWithoutAS++;

    // Adiciona a lista de pendentes para cobranca
    dailyStats.pendingAS.push({
      time: new Date().toLocaleTimeString('pt-BR'),
      collaborator: activity.collaborator,
      folder: activity.folder,
      photoCount: activity.photoCount
    });
  } else if (activity.type === 'rejected') {
    // Numero nao autorizado
  }

  // Salva em arquivo
  saveStatsToFile();
}

/**
 * Salva estatisticas em arquivo JSON
 */
function saveStatsToFile() {
  const reportsDir = getPhotosFolder();
  ensureDir(reportsDir);

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
  // Garante que arrays existam
  const pendingAS = dailyStats.pendingAS || [];
  const batchesWithDuplicates = dailyStats.batchesWithDuplicates || [];
  const details = dailyStats.details || [];
  const totalDuplicates = dailyStats.totalDuplicates || 0;

  const pendingSection = pendingAS.length > 0 ? `
    <h2 style="color: #dc3545;">AS Pendentes para Cobranca</h2>
    <table>
      <tr>
        <th>Hora</th>
        <th>Colaborador</th>
        <th>Pasta</th>
        <th>Fotos</th>
      </tr>
      ${pendingAS.map(p => `
        <tr style="background: #fff3cd;">
          <td>${p.time}</td>
          <td><strong>${p.collaborator}</strong></td>
          <td>${p.folder}</td>
          <td>${p.photoCount}</td>
        </tr>
      `).join('')}
    </table>
  ` : '';

  const duplicatesSection = batchesWithDuplicates.length > 0 ? `
    <h2 style="color: #ff9800;">Fotos Duplicadas Detectadas</h2>
    <p>Total: <strong>${totalDuplicates}</strong> foto(s) duplicada(s) em ${batchesWithDuplicates.length} lote(s)</p>
    <table>
      <tr>
        <th>Hora</th>
        <th>Colaborador</th>
        <th>AS</th>
        <th>Duplicadas</th>
        <th>Total Fotos</th>
      </tr>
      ${batchesWithDuplicates.map(d => `
        <tr style="background: #fff3e0;">
          <td>${d.time}</td>
          <td><strong>${d.collaborator}</strong></td>
          <td>${d.as}</td>
          <td style="color: #ff9800; font-weight: bold;">${d.duplicates}</td>
          <td>${d.photoCount}</td>
        </tr>
      `).join('')}
    </table>
  ` : '';

  return `
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; padding: 20px; }
        h1 { color: #25D366; }
        h2 { margin-top: 30px; }
        .stats { background: #f5f5f5; padding: 15px; border-radius: 8px; margin: 20px 0; }
        .stat-item { margin: 10px 0; }
        .success { color: #28a745; }
        .warning { color: #ffc107; }
        .failed { color: #dc3545; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { padding: 10px; border: 1px solid #ddd; text-align: left; }
        th { background: #25D366; color: white; }
        .summary { font-size: 18px; margin: 20px 0; padding: 15px; background: #e8f5e9; border-radius: 8px; }
      </style>
    </head>
    <body>
      <h1>Relatorio Diario - Bot WhatsApp</h1>
      <p>Data: ${dailyStats.date}</p>

      <div class="summary">
        <strong>Resumo:</strong> ${dailyStats.totalBatches} lotes | ${dailyStats.totalPhotos} fotos |
        <span class="success">${dailyStats.batchesWithAS} com AS</span> |
        <span class="failed">${dailyStats.batchesWithoutAS} sem AS</span>
        ${totalDuplicates > 0 ? `| <span class="warning">${totalDuplicates} duplicadas</span>` : ''}
      </div>

      <div class="stats">
        <div class="stat-item"><strong>Total de Lotes:</strong> ${dailyStats.totalBatches}</div>
        <div class="stat-item"><strong>Total de Fotos:</strong> ${dailyStats.totalPhotos}</div>
        <div class="stat-item success"><strong>Lotes com AS:</strong> ${dailyStats.batchesWithAS}</div>
        <div class="stat-item failed"><strong>Lotes sem AS:</strong> ${dailyStats.batchesWithoutAS}</div>
      </div>

      ${pendingSection}

      ${duplicatesSection}

      <h2>Historico Completo</h2>
      <table>
        <tr>
          <th>Hora</th>
          <th>Tipo</th>
          <th>Detalhes</th>
        </tr>
        ${details.map(d => `
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
  // Salva arquivo local independente do email
  saveStatsToFile();

  if (!transporter) {
    console.log('Email nao configurado - relatorio salvo apenas localmente');
    return { success: true, local: true };
  }

  try {
    const html = generateReportHtml();

    const pendingAS = dailyStats.pendingAS || [];
    const subject = pendingAS.length > 0
      ? `[ATENCAO] ${pendingAS.length} AS Pendentes - Relatorio ${dailyStats.date}`
      : `Relatorio Bot WhatsApp - ${dailyStats.date}`;

    const info = await transporter.sendMail({
      from: config.email.user,
      to: config.email.to,
      subject: subject,
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
 * Retorna lista de AS pendentes
 */
function getPendingAS() {
  return [...(dailyStats.pendingAS || [])];
}

/**
 * Carrega estatisticas do arquivo
 */
function loadStatsFromFile() {
  const today = new Date().toISOString().split('T')[0];
  const photosDir = getPhotosFolder();
  const fileName = `relatorio_${today}.json`;
  const filePath = path.join(photosDir, fileName);

  if (fs.existsSync(filePath)) {
    try {
      const loaded = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      // Garante que campos novos existam (compatibilidade)
      dailyStats = {
        ...dailyStats,
        ...loaded,
        totalDuplicates: loaded.totalDuplicates || 0,
        batchesWithDuplicates: loaded.batchesWithDuplicates || [],
        pendingAS: loaded.pendingAS || [],
        details: loaded.details || []
      };
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
  getStats,
  getPendingAS
};
