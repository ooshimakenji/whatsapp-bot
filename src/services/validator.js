const Anthropic = require('@anthropic-ai/sdk');
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

const anthropic = new Anthropic({
  apiKey: config.claude.apiKey
});

/**
 * Valida a legenda usando Claude API
 * Formato esperado: 202XXXXXXXXX (202 + 9 digitos)
 */
async function validateLegend(legend) {
  // Validacao local primeiro (mais rapido)
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
      reason: 'Formato invalido. Use: 202XXXXXXX (202 + 7 digitos = 10 caracteres)'
    };
  }

  // Usa Claude para validacao adicional se necessario
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: `Valide se este codigo "${trimmed}" esta no formato correto: deve comecar com 202 seguido de exatamente 7 digitos numericos (total 10 caracteres). Responda apenas "VALIDO" ou "INVALIDO: motivo".`
        }
      ]
    });

    const result = response.content[0].text.trim();

    // Normaliza removendo acentos para comparacao
    const normalized = result.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();

    if (normalized.startsWith('VALIDO')) {
      return { valid: true, code: trimmed };
    } else {
      return {
        valid: false,
        reason: result.replace(/INV[ÁA]LIDO:/gi, '').trim()
      };
    }
  } catch (error) {
    // Se Claude falhar, usa apenas validacao local
    console.error('Erro na validacao Claude:', error.message);
    return { valid: true, code: trimmed };
  }
}

/**
 * Verifica se numero esta autorizado
 */
function isNumberAllowed(number) {
  // Remove caracteres nao numericos
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
