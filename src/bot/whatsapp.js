const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { validateLegend, isNumberAllowed, getCollaboratorName } = require('../services/validator');
const { uploadBatch, saveToTemp, clearTemp, isConfigured: isOnedriveConfigured } = require('../services/onedrive');
const { logActivity } = require('../services/email');

// Armazena lotes pendentes por usuario
// Formato: { 'numero': { active: bool, legend: string|null, photos: [], waitingLegend: bool, lastUpdate: Date } }
const pendingBatches = new Map();

// Delay para respostas mais naturais (1-3 segundos)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const naturalDelay = () => delay(1000 + Math.random() * 2000);

// Timeout para limpar lotes incompletos (30 minutos)
const BATCH_TIMEOUT = 30 * 60 * 1000;

// Cria cliente WhatsApp
const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: './session'
  }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

/**
 * Inicializa o bot
 */
function initialize() {
  // Evento: QR Code para conectar
  client.on('qr', (qr) => {
    console.log('\n========================================');
    console.log('Escaneie o QR Code abaixo com seu WhatsApp:');
    console.log('========================================\n');
    qrcode.generate(qr, { small: true });
  });

  // Evento: Conectado
  client.on('ready', () => {
    console.log('\n========================================');
    console.log('Bot WhatsApp conectado e pronto!');
    console.log('========================================\n');
  });

  // Evento: Autenticado
  client.on('authenticated', () => {
    console.log('Autenticacao bem sucedida!');
  });

  // Evento: Falha na autenticacao
  client.on('auth_failure', (msg) => {
    console.error('Falha na autenticacao:', msg);
  });

  // Evento: Desconectado
  client.on('disconnected', (reason) => {
    console.log('Bot desconectado:', reason);
  });

  // Evento: Mensagem recebida
  client.on('message', handleMessage);

  // Inicia o cliente
  client.initialize();

  // Limpa lotes antigos periodicamente
  setInterval(cleanOldBatches, 60000);

  return client;
}

/**
 * Processa mensagem recebida
 */
async function handleMessage(message) {
  try {
    const contact = await message.getContact();
    const number = contact.number;
    const chat = await message.getChat();

    // Verifica se numero esta autorizado
    if (!isNumberAllowed(number)) {
      console.log(`Numero nao autorizado: ${number}`);
      logActivity({
        type: 'rejected',
        message: `Numero nao autorizado: ${number}`
      });
      return;
    }

    // Se for foto
    if (message.hasMedia) {
      await handlePhoto(message, number, chat);
    }
    // Se for texto (comandos ou legenda)
    else if (message.body) {
      await handleText(message, number, chat);
    }
  } catch (error) {
    console.error('Erro ao processar mensagem:', error);
  }
}

/**
 * Processa foto recebida
 */
async function handlePhoto(message, number, chat) {
  const batch = pendingBatches.get(number);

  // Verifica se tem lote ativo
  if (!batch || !batch.active) {
    await naturalDelay();
    await chat.sendMessage(
      'Para enviar fotos, primeiro digite *FOTOS* para iniciar.'
    );
    return;
  }

  const caption = message.body || '';

  // Se tem legenda, valida
  if (caption.trim()) {
    const validation = await validateLegend(caption);

    if (validation.valid) {
      // Verifica se ja tem legenda diferente no lote
      if (batch.legend && batch.legend !== validation.code) {
        await naturalDelay();
        await chat.sendMessage(
          `Erro: Legenda diferente detectada!\n` +
          `Lote atual: ${batch.legend}\n` +
          `Legenda enviada: ${validation.code}\n\n` +
          `Use apenas uma legenda por lote.`
        );
        return;
      }
      batch.legend = validation.code;
    }
  }

  // Baixa a midia
  const media = await message.downloadMedia();
  if (!media) {
    await naturalDelay();
    await chat.sendMessage('Erro ao baixar a foto. Tente novamente.');
    return;
  }

  // Cria buffer da foto
  const buffer = Buffer.from(media.data, 'base64');
  const extension = media.mimetype.split('/')[1] || 'jpg';
  const fileName = `foto_${Date.now()}.${extension}`;

  batch.photos.push({ buffer, fileName });
  batch.lastUpdate = new Date();

  // Salva localmente como backup
  const tempName = batch.legend ? `${batch.legend}_${fileName}` : `temp_${number}_${fileName}`;
  saveToTemp(buffer, tempName);

  const remaining = config.minPhotosPerBatch - batch.photos.length;
  const legendaStatus = batch.legend ? `AS: ${batch.legend}` : 'AS: pendente';

  await naturalDelay();
  if (remaining > 0) {
    await chat.sendMessage(
      `Foto ${batch.photos.length} recebida (${legendaStatus})\n` +
      `Envie mais ${remaining} foto(s) para completar o minimo de ${config.minPhotosPerBatch}.`
    );
  } else {
    await chat.sendMessage(
      `Foto ${batch.photos.length} recebida (${legendaStatus})\n` +
      `Lote com ${batch.photos.length} fotos!\n\n` +
      `Digite *ENVIAR* para fazer upload.`
    );
  }
}

/**
 * Processa texto/comandos
 */
async function handleText(message, number, chat) {
  const text = message.body.trim().toUpperCase();
  const batch = pendingBatches.get(number);

  // Comando FOTOS - inicia novo lote
  if (text === 'FOTOS') {
    await startBatch(number, chat);
    return;
  }

  // Comando ENVIAR - finaliza e faz upload
  if (text === 'ENVIAR' || text === 'UPLOAD') {
    await processBatchUpload(number, chat);
    return;
  }

  // Comando PROXIMO - inicia proximo lote apos envio
  if (text === 'PROXIMO' || text === 'PRÓXIMO') {
    await startBatch(number, chat);
    return;
  }

  // Comando STATUS (oculto)
  if (text === 'STATUS') {
    await sendStatus(number, chat);
    return;
  }

  // Comando CANCELAR (oculto)
  if (text === 'CANCELAR') {
    await cancelBatch(number, chat);
    return;
  }

  // Comando AJUDA
  if (text === 'AJUDA' || text === 'HELP') {
    await sendHelp(chat);
    return;
  }

  // Se tem lote ativo aguardando legenda, verifica se e uma legenda
  if (batch && batch.active && batch.waitingLegend) {
    const validation = await validateLegend(message.body);
    if (validation.valid) {
      // Verifica se ja tem legenda diferente
      if (batch.legend && batch.legend !== validation.code) {
        await naturalDelay();
        await chat.sendMessage(
          `Erro: Legenda diferente!\n` +
          `Lote atual: ${batch.legend}\n` +
          `Use apenas uma legenda por lote.`
        );
        return;
      }
      batch.legend = validation.code;
      batch.waitingLegend = false;
      batch.lastUpdate = new Date();

      await naturalDelay();
      await chat.sendMessage(
        `AS ${validation.code} registrada!\n\n` +
        `Digite *ENVIAR* para fazer upload.`
      );
      return;
    }
  }

  // Se tem lote ativo sem legenda, pode ser uma legenda sendo enviada
  if (batch && batch.active && !batch.legend) {
    const validation = await validateLegend(message.body);
    if (validation.valid) {
      batch.legend = validation.code;
      batch.lastUpdate = new Date();

      await naturalDelay();
      await chat.sendMessage(
        `AS ${validation.code} registrada para o lote!`
      );
      return;
    }
  }
}

/**
 * Inicia novo lote
 */
async function startBatch(number, chat) {
  // Se ja tem lote ativo, cancela
  if (pendingBatches.has(number)) {
    const oldBatch = pendingBatches.get(number);
    if (oldBatch.active && oldBatch.photos.length > 0) {
      console.log(`Lote anterior cancelado para ${number}: ${oldBatch.photos.length} fotos`);
    }
  }

  // Cria novo lote
  pendingBatches.set(number, {
    active: true,
    legend: null,
    photos: [],
    waitingLegend: false,
    lastUpdate: new Date()
  });

  await naturalDelay();
  await chat.sendMessage(
    `Favor envie tres fotos e o numero da AS`
  );
}

/**
 * Processa upload do lote
 */
async function processBatchUpload(number, chat) {
  if (!pendingBatches.has(number) || !pendingBatches.get(number).active) {
    await naturalDelay();
    await chat.sendMessage('Nenhum lote ativo. Digite *FOTOS* para iniciar.');
    return;
  }

  const batch = pendingBatches.get(number);

  // Verifica minimo de fotos
  if (batch.photos.length < config.minPhotosPerBatch) {
    const remaining = config.minPhotosPerBatch - batch.photos.length;
    await naturalDelay();
    await chat.sendMessage(
      `Lote incompleto! Voce tem ${batch.photos.length} foto(s).\n` +
      `Envie mais ${remaining} para atingir o minimo de ${config.minPhotosPerBatch}.`
    );
    return;
  }

  // Se nao tem legenda
  if (!batch.legend) {
    // Se ja pediu a legenda e usuario mandou ENVIAR de novo, salva sem legenda
    if (batch.waitingLegend) {
      await saveBatchWithoutLegend(number, chat, batch);
      return;
    }

    // Primeira vez sem legenda - pede
    batch.waitingLegend = true;
    await naturalDelay();
    await chat.sendMessage(
      `Falta o numero da AS!\n` +
      `Envie a AS no formato 202XXXXXXX ou digite *ENVIAR* novamente para salvar sem AS.`
    );
    return;
  }

  // Faz upload
  await doUpload(number, chat, batch);
}

/**
 * Executa o upload do lote
 */
async function doUpload(number, chat, batch) {
  const destino = isOnedriveConfigured ? 'OneDrive' : 'pasta local';
  await naturalDelay();
  await chat.sendMessage(
    `Enviando ${batch.photos.length} fotos para ${destino}...\n` +
    `AS: ${batch.legend || 'sem legenda'}`
  );

  // Faz upload
  const result = await uploadBatch(batch.photos, batch.legend);

  await naturalDelay();
  if (result.success === result.total) {
    await chat.sendMessage(
      `Upload concluido com sucesso!\n` +
      `${result.success} fotos salvas.\n\n` +
      `Digite *PROXIMO* para enviar outro lote.`
    );
  } else {
    await chat.sendMessage(
      `Upload parcial:\n` +
      `- Sucesso: ${result.success}\n` +
      `- Falhas: ${result.failed}\n\n` +
      `Verifique a conexao.`
    );
  }

  // Registra no relatorio
  const collaboratorName = getCollaboratorName(number);
  logActivity({
    type: 'batch_complete',
    message: `Lote ${batch.legend || 'SEM_AS'} de ${collaboratorName || number}`,
    photoCount: batch.photos.length,
    success: result.success,
    failed: result.failed
  });

  // Limpa lote
  pendingBatches.delete(number);
  clearTemp();
}

/**
 * Salva lote sem legenda
 */
async function saveBatchWithoutLegend(number, chat, batch) {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, 'h').slice(0, 5);
  const collaboratorName = getCollaboratorName(number);

  // Pasta: SEM_LEGENDA/2024-01-15_14h30_5511999999999/
  const folderName = `${dateStr}_${timeStr}_${number}`;

  const destino = isOnedriveConfigured ? 'OneDrive' : 'pasta local';
  await naturalDelay();
  await chat.sendMessage(
    `Salvando ${batch.photos.length} fotos SEM AS em ${destino}...\n` +
    `Pasta: SEM_LEGENDA/${folderName}`
  );

  // Faz upload para pasta SEM_LEGENDA
  const result = await uploadBatch(batch.photos, `SEM_LEGENDA/${folderName}`);

  await naturalDelay();
  if (result.success === result.total) {
    await chat.sendMessage(
      `Fotos salvas com sucesso!\n` +
      `${result.success} fotos em SEM_LEGENDA/${folderName}\n\n` +
      `Digite *PROXIMO* para enviar outro lote.`
    );
  } else {
    await chat.sendMessage(
      `Upload parcial:\n` +
      `- Sucesso: ${result.success}\n` +
      `- Falhas: ${result.failed}`
    );
  }

  // Registra no relatorio como sem legenda
  logActivity({
    type: 'batch_no_legend',
    message: `Lote SEM AS de ${collaboratorName || number}`,
    photoCount: batch.photos.length,
    folder: folderName,
    success: result.success,
    failed: result.failed
  });

  // Limpa lote
  pendingBatches.delete(number);
  clearTemp();
}

/**
 * Envia status do lote atual
 */
async function sendStatus(number, chat) {
  await naturalDelay();
  if (!pendingBatches.has(number) || !pendingBatches.get(number).active) {
    await chat.sendMessage('Nenhum lote ativo.');
    return;
  }

  const batch = pendingBatches.get(number);
  const remaining = Math.max(0, config.minPhotosPerBatch - batch.photos.length);

  await chat.sendMessage(
    `Status do Lote:\n` +
    `- AS: ${batch.legend || 'nao informada'}\n` +
    `- Fotos: ${batch.photos.length}\n` +
    `- Faltam: ${remaining > 0 ? remaining : 'Lote completo!'}`
  );
}

/**
 * Cancela lote atual
 */
async function cancelBatch(number, chat) {
  await naturalDelay();
  if (pendingBatches.has(number) && pendingBatches.get(number).active) {
    const batch = pendingBatches.get(number);
    pendingBatches.delete(number);
    await chat.sendMessage(
      `Lote com ${batch.photos.length} foto(s) cancelado.`
    );
  } else {
    await chat.sendMessage('Nenhum lote para cancelar.');
  }
}

/**
 * Envia mensagem de ajuda
 */
async function sendHelp(chat) {
  await naturalDelay();
  await chat.sendMessage(
    `*Bot WhatsApp - Ajuda*\n\n` +
    `*Como usar:*\n` +
    `1. Digite *FOTOS* para iniciar\n` +
    `2. Envie as fotos (minimo ${config.minPhotosPerBatch})\n` +
    `3. Inclua a AS em uma das fotos ou envie separado\n` +
    `4. Digite *ENVIAR* para finalizar\n` +
    `5. Digite *PROXIMO* para outro lote\n\n` +
    `*Formato da AS:* 202XXXXXXX (10 digitos)`
  );
}

/**
 * Limpa lotes antigos
 */
function cleanOldBatches() {
  const now = new Date();

  for (const [number, batch] of pendingBatches.entries()) {
    const elapsed = now - batch.lastUpdate;
    if (elapsed > BATCH_TIMEOUT) {
      console.log(`Lote expirado removido: ${number} (${batch.photos.length} fotos)`);
      pendingBatches.delete(number);
    }
  }
}

/**
 * Retorna cliente para uso externo
 */
function getClient() {
  return client;
}

module.exports = {
  initialize,
  getClient
};
