const msal = require('@azure/msal-node');
const { Client } = require('@microsoft/microsoft-graph-client');
const fs = require('fs');
const path = require('path');
const config = require('../config');

let graphClient = null;
let tokenCache = null;
let cca = null;

// Verifica se credenciais estao configuradas
const hasCredentials = config.microsoft.clientId &&
                       config.microsoft.clientSecret &&
                       config.microsoft.tenantId;

// Inicializa MSAL apenas se tiver credenciais
if (hasCredentials) {
  const msalConfig = {
    auth: {
      clientId: config.microsoft.clientId,
      clientSecret: config.microsoft.clientSecret,
      authority: `https://login.microsoftonline.com/${config.microsoft.tenantId}`
    }
  };
  cca = new msal.ConfidentialClientApplication(msalConfig);
} else {
  console.log('OneDrive: Credenciais nao configuradas - modo offline ativado');
}

/**
 * Obtem token de acesso
 */
async function getAccessToken() {
  if (!cca) {
    throw new Error('OneDrive nao configurado');
  }
  try {
    const result = await cca.acquireTokenByClientCredential({
      scopes: ['https://graph.microsoft.com/.default']
    });
    return result.accessToken;
  } catch (error) {
    console.error('Erro ao obter token:', error.message);
    throw error;
  }
}

/**
 * Inicializa cliente do Graph
 */
async function getGraphClient() {
  if (graphClient) return graphClient;

  const accessToken = await getAccessToken();

  graphClient = Client.init({
    authProvider: (done) => {
      done(null, accessToken);
    }
  });

  return graphClient;
}

/**
 * Faz upload de arquivo para OneDrive
 * @param {Buffer} fileBuffer - Conteudo do arquivo
 * @param {string} fileName - Nome do arquivo
 * @param {string} legend - Codigo da legenda (usado como subpasta)
 */
async function uploadFile(fileBuffer, fileName, legend) {
  // Modo offline - salva apenas localmente
  if (!hasCredentials) {
    const localPath = saveToTemp(fileBuffer, `${legend}_${fileName}`);
    console.log(`[OFFLINE] Arquivo salvo localmente: ${localPath}`);
    return {
      success: true,
      offline: true,
      path: localPath,
      webUrl: null
    };
  }

  try {
    const client = await getGraphClient();

    // Cria caminho: PastaBase/Codigo/arquivo.jpg
    const folderPath = `${config.onedrive.folder}/${legend}`;
    const filePath = `${folderPath}/${fileName}`;

    // Upload usando put (para arquivos pequenos < 4MB)
    const result = await client
      .api(`/me/drive/root:/${filePath}:/content`)
      .put(fileBuffer);

    console.log(`Arquivo enviado: ${filePath}`);

    return {
      success: true,
      path: filePath,
      webUrl: result.webUrl
    };
  } catch (error) {
    console.error('Erro no upload OneDrive:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Faz upload de multiplos arquivos
 * @param {Array} files - Array de {buffer, fileName}
 * @param {string} legend - Codigo da legenda
 */
async function uploadBatch(files, legend) {
  const results = [];

  for (const file of files) {
    const result = await uploadFile(file.buffer, file.fileName, legend);
    results.push(result);
  }

  return {
    total: files.length,
    success: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    details: results
  };
}

/**
 * Salva arquivo localmente na pasta temp
 */
function saveToTemp(buffer, fileName) {
  const tempDir = path.join(__dirname, '../../temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const filePath = path.join(tempDir, fileName);
  fs.writeFileSync(filePath, buffer);

  return filePath;
}

/**
 * Limpa pasta temp
 */
function clearTemp() {
  const tempDir = path.join(__dirname, '../../temp');
  if (fs.existsSync(tempDir)) {
    const files = fs.readdirSync(tempDir);
    files.forEach(file => {
      fs.unlinkSync(path.join(tempDir, file));
    });
  }
}

module.exports = {
  uploadFile,
  uploadBatch,
  saveToTemp,
  clearTemp,
  getAccessToken,
  isConfigured: hasCredentials
};
