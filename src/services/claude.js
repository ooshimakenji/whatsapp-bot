const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');

let anthropic = null;

// Inicializa cliente apenas se tiver API key
if (config.claude.apiKey) {
  anthropic = new Anthropic({
    apiKey: config.claude.apiKey
  });
}

/**
 * Gera resposta inteligente para situacoes especiais
 * Usado apenas quando templates nao cobrem o caso
 */
async function generateResponse(context, userMessage) {
  if (!anthropic) {
    return null;
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 150,
      system: `Voce e um assistente de bot WhatsApp para coleta de fotos.
Responda de forma profissional, curta e direta (max 2 linhas).
Sem emojis. Sem formalidades excessivas.
Contexto: ${context}`,
      messages: [
        {
          role: 'user',
          content: userMessage
        }
      ]
    });

    return response.content[0].text.trim();
  } catch (error) {
    console.error('Erro Claude:', error.message);
    return null;
  }
}

/**
 * Explica um erro de forma amigavel
 */
async function explainError(errorType, details) {
  if (!anthropic) {
    return getDefaultErrorMessage(errorType, details);
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      system: `Explique o erro de forma simples e direta (1-2 linhas).
Sem emojis. Tom profissional.`,
      messages: [
        {
          role: 'user',
          content: `Erro: ${errorType}. Detalhes: ${JSON.stringify(details)}`
        }
      ]
    });

    return response.content[0].text.trim();
  } catch (error) {
    console.error('Erro Claude:', error.message);
    return getDefaultErrorMessage(errorType, details);
  }
}

/**
 * Mensagens de erro padrao quando Claude nao esta disponivel
 */
function getDefaultErrorMessage(errorType, details) {
  const messages = {
    'invalid_legend': `AS invalida. Use formato 202XXXXXXX (10 digitos).`,
    'min_photos': `Minimo ${details?.min || 3} fotos por lote.`,
    'save_error': `Erro ao salvar. Tente novamente.`,
    'unknown': `Erro inesperado. Tente novamente.`
  };

  return messages[errorType] || messages['unknown'];
}

/**
 * Verifica se Claude esta configurado
 */
function isConfigured() {
  return anthropic !== null;
}

module.exports = {
  generateResponse,
  explainError,
  isConfigured
};
