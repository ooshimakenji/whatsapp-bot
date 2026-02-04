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
      reason: 'Legenda vazia ou invalida'
    };
  }

  const trimmed = legend.trim();

  // Verifica formato com regex
  if (!config.legendPattern.test(trimmed)) {
    return {
      valid: false,
      reason: 'Formato invalido. Use: 202XXXXXXX (10 digitos)',
      received: trimmed
    };
  }

  return {
    valid: true,
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
