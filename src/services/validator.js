const fs = require('fs');
const path = require('path');
const config = require('../config');

// Carrega lista de colaboradores
let collaborators = {};
const collaboratorsFile = path.join(__dirname, '../config/collaborators.json');

function loadCollaborators() {
  try {
    if (fs.existsSync(collaboratorsFile)) {
      const data = fs.readFileSync(collaboratorsFile, 'utf8');
      collaborators = JSON.parse(data);
      console.log(`Colaboradores carregados: ${Object.keys(collaborators).length}`);
    }
  } catch (error) {
    console.log('Arquivo de colaboradores nao encontrado ou invalido');
  }
}

// Carrega ao iniciar
loadCollaborators();

/**
 * Valida a legenda usando regex local
 * Formato esperado: 202XXXXXXX (202 + 7 digitos = 10 caracteres)
 */
function validateLegend(legend) {
  if (!legend || typeof legend !== 'string') {
    return {
      valid: false,
      reason: 'VAZIO'
    };
  }

  const trimmed = legend.trim();

  // Ignora se nao parece ser um numero
  if (!/^\d+$/.test(trimmed)) {
    return {
      valid: false,
      reason: 'NAO_NUMERICO'
    };
  }

  // Verifica quantidade de digitos
  if (trimmed.length < 10) {
    const faltam = 10 - trimmed.length;
    return {
      valid: false,
      reason: 'FALTAM_DIGITOS',
      faltam: faltam,
      received: trimmed
    };
  }

  if (trimmed.length > 10) {
    return {
      valid: false,
      reason: 'MUITOS_DIGITOS',
      received: trimmed
    };
  }

  // Verifica se comeca com 202
  if (!trimmed.startsWith('202')) {
    return {
      valid: false,
      reason: 'NAO_COMECA_202',
      received: trimmed
    };
  }

  // Verifica se e 2025 ou 2026 (aceita direto)
  if (trimmed.startsWith('2025') || trimmed.startsWith('2026')) {
    return {
      valid: true,
      needsConfirmation: false,
      code: trimmed
    };
  }

  // Outros 202X (ex: 2024, 2027) - pede confirmacao
  return {
    valid: true,
    needsConfirmation: true,
    code: trimmed
  };
}

/**
 * Verifica se numero esta autorizado
 */
function isNumberAllowed(number) {
  const cleanNumber = number.replace(/\D/g, '');

  // Se tem lista de colaboradores, usa ela
  if (Object.keys(collaborators).length > 0) {
    return Object.keys(collaborators).some(allowed => {
      const cleanAllowed = allowed.replace(/\D/g, '');
      return cleanNumber.includes(cleanAllowed) || cleanAllowed.includes(cleanNumber);
    });
  }

  // Se tem lista no .env, usa ela
  if (config.allowedNumbers.length > 0) {
    return config.allowedNumbers.some(allowed => {
      const cleanAllowed = allowed.replace(/\D/g, '');
      return cleanNumber.includes(cleanAllowed) || cleanAllowed.includes(cleanNumber);
    });
  }

  // Se nenhuma lista configurada, aceita todos
  return true;
}

/**
 * Retorna nome do colaborador pelo numero
 */
function getCollaboratorName(number) {
  const cleanNumber = number.replace(/\D/g, '');

  for (const [phone, name] of Object.entries(collaborators)) {
    const cleanPhone = phone.replace(/\D/g, '');
    if (cleanNumber.includes(cleanPhone) || cleanPhone.includes(cleanNumber)) {
      return name;
    }
  }

  return null;
}

/**
 * Recarrega lista de colaboradores
 */
function reloadCollaborators() {
  loadCollaborators();
}

module.exports = {
  validateLegend,
  isNumberAllowed,
  getCollaboratorName,
  reloadCollaborators
};
