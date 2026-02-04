const fs = require('fs');
const path = require('path');
const config = require('../config');

/**
 * Formata data no padrao brasileiro: DD-MM-AAAA
 */
function formatDate(date) {
  const d = date.getDate().toString().padStart(2, '0');
  const m = (date.getMonth() + 1).toString().padStart(2, '0');
  const y = date.getFullYear();
  return `${d}-${m}-${y}`;
}

/**
 * Formata hora no padrao: HHhMM
 */
function formatTime(date) {
  const h = date.getHours().toString().padStart(2, '0');
  const min = date.getMinutes().toString().padStart(2, '0');
  return `${h}h${min}`;
}

/**
 * Sanitiza nome para uso em arquivos/pastas
 */
function sanitizeName(name) {
  if (!name) return 'Desconhecido';
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 50);
}

/**
 * Garante que o diretorio existe
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  return dirPath;
}

/**
 * Gera nome do arquivo no formato:
 * {seq}_{data}_{hora}_{colaborador}_{AS}.{ext}
 * ou sem AS se nao tiver
 */
function generateFileName(seq, collaboratorName, legend, extension) {
  const now = new Date();
  const date = formatDate(now);
  const time = formatTime(now);
  const name = sanitizeName(collaboratorName);
  const seqStr = seq.toString().padStart(3, '0');

  if (legend) {
    return `${seqStr}_${date}_${time}_${name}_${legend}.${extension}`;
  }
  return `${seqStr}_${date}_${time}_${name}.${extension}`;
}

/**
 * Determina o caminho da pasta destino
 * - Com AS: /PHOTOS_FOLDER/{AS}/
 * - Sem AS: /PHOTOS_FOLDER/SEM_AS/{colaborador}_{data}_{hora}/
 */
function getDestinationFolder(legend, collaboratorName) {
  const baseFolder = path.resolve(config.storage.photosFolder);

  if (legend) {
    return path.join(baseFolder, legend);
  }

  const now = new Date();
  const date = formatDate(now);
  const time = formatTime(now);
  const name = sanitizeName(collaboratorName);
  const folderName = `${name}_${date}_${time}`;

  return path.join(baseFolder, 'SEM_AS', folderName);
}

/**
 * Salva um arquivo de foto
 */
function savePhoto(buffer, seq, collaboratorName, legend, extension = 'jpg') {
  const folder = getDestinationFolder(legend, collaboratorName);
  ensureDir(folder);

  const fileName = generateFileName(seq, collaboratorName, legend, extension);
  const filePath = path.join(folder, fileName);

  fs.writeFileSync(filePath, buffer);

  return {
    success: true,
    path: filePath,
    fileName,
    folder
  };
}

/**
 * Salva um lote de fotos
 * @param {Array} photos - Array de {buffer, fileName}
 * @param {string} collaboratorName - Nome do colaborador
 * @param {string|null} legend - Codigo AS ou null
 */
function saveBatch(photos, collaboratorName, legend) {
  const results = [];

  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];
    const extension = photo.fileName.split('.').pop() || 'jpg';

    try {
      const result = savePhoto(
        photo.buffer,
        i + 1,
        collaboratorName,
        legend,
        extension
      );
      results.push(result);
    } catch (error) {
      console.error(`Erro ao salvar foto ${i + 1}:`, error.message);
      results.push({
        success: false,
        error: error.message
      });
    }
  }

  const folder = results.find(r => r.success)?.folder || null;

  return {
    total: photos.length,
    success: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    folder,
    details: results
  };
}

/**
 * Retorna caminho absoluto da pasta de fotos
 */
function getPhotosFolder() {
  return path.resolve(config.storage.photosFolder);
}

/**
 * Retorna caminho absoluto da pasta de relatorios
 */
function getReportsFolder() {
  return path.resolve(config.storage.reportsFolder);
}

module.exports = {
  savePhoto,
  saveBatch,
  getDestinationFolder,
  generateFileName,
  ensureDir,
  sanitizeName,
  formatDate,
  formatTime,
  getPhotosFolder,
  getReportsFolder
};
