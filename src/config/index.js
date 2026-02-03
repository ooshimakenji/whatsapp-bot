require('dotenv').config();

module.exports = {
  // Claude API
  claude: {
    apiKey: process.env.CLAUDE_API_KEY
  },

  // Microsoft / OneDrive
  microsoft: {
    clientId: process.env.MICROSOFT_CLIENT_ID,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
    tenantId: process.env.MICROSOFT_TENANT_ID,
    redirectUri: 'http://localhost:3000/callback'
  },

  onedrive: {
    folder: process.env.ONEDRIVE_FOLDER || 'Fotos_WhatsApp'
  },

  // Email
  email: {
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
  legendPattern: /^202\d{7}$/
};
