require('dotenv').config();
const path = require('path');

module.exports = {
  // Claude API (para respostas inteligentes)
  claude: {
    apiKey: process.env.CLAUDE_API_KEY
  },

  // Armazenamento local
  storage: {
    photosFolder: process.env.PHOTOS_FOLDER || './uploads',
    reportsFolder: process.env.REPORTS_FOLDER || './reports'
  },

  // Email
  email: {
    host: process.env.EMAIL_HOST || 'smtp.office365.com',
    port: parseInt(process.env.EMAIL_PORT) || 587,
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
    to: process.env.EMAIL_TO
  },

  // Numeros autorizados (vazio = todos)
  allowedNumbers: process.env.ALLOWED_NUMBERS
    ? process.env.ALLOWED_NUMBERS.split(',').map(n => n.trim())
    : [],

  // Validacao
  minPhotosPerBatch: parseInt(process.env.MIN_PHOTOS_PER_BATCH) || 3,

  // Formato da legenda: 202 + 7 digitos = 10 caracteres
  legendPattern: /^202\d{7}$/,

  // Grupo de supervisores para encaminhar fotos
  supervisorGroup: process.env.SUPERVISOR_GROUP || ''
};
