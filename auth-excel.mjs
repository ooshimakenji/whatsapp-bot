/**
 * auth-excel.mjs — Autenticação one-time via Device Code Flow
 *
 * Execute uma vez: node auth-excel.mjs
 * Abre o navegador, você faz login com sua conta Microsoft.
 * O token é salvo em archive/.excel_token.json (não precisa fazer login de novo).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLIENT_ID = '14d82eec-204b-4c2f-b7e8-296a70dab67e'; // Microsoft Graph Command Line Tools (public client, sem segredo)
const TENANT = 'ambientalsc.onmicrosoft.com'; // Tenant corporativo (extraído da URL SharePoint)
const SCOPES = 'Files.ReadWrite offline_access';
const TOKEN_FILE = path.join(__dirname, 'archive', '.excel_token.json');

async function main() {
  console.log('=== Autenticação Excel Online ===\n');

  // 1. Solicita device code
  const deviceResp = await fetch(
    `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/devicecode`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPES }).toString(),
    }
  );

  if (!deviceResp.ok) {
    const err = await deviceResp.text();
    console.error('Erro ao iniciar autenticação:', err);
    process.exit(1);
  }

  const device = await deviceResp.json();

  // Exibe a mensagem (contém URL e código)
  console.log(device.message);
  console.log('\nAguardando você fazer o login...\n');

  // 2. Faz polling até o usuário autenticar ou expirar
  const pollInterval = (device.interval || 5) * 1000;
  const expiresAt = Date.now() + (device.expires_in || 900) * 1000;

  while (Date.now() < expiresAt) {
    await new Promise(r => setTimeout(r, pollInterval));

    const tokenResp = await fetch(
      `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: device.device_code,
        }).toString(),
      }
    );

    const data = await tokenResp.json();

    if (data.access_token) {
      const tokenData = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + data.expires_in * 1000,
      };
      fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
      fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));
      console.log('\n✓ Autenticado com sucesso!');
      console.log(`  Token salvo em: ${TOKEN_FILE}`);
      console.log('\nO bot agora pode atualizar a planilha automaticamente.');
      process.exit(0);
    }

    if (data.error === 'authorization_pending') {
      process.stdout.write('.');
      continue;
    }

    if (data.error === 'slow_down') {
      await new Promise(r => setTimeout(r, pollInterval));
      continue;
    }

    console.error('\nErro na autenticação:', data.error, data.error_description);
    process.exit(1);
  }

  console.error('\nTempo esgotado. Execute o script novamente.');
  process.exit(1);
}

main().catch(err => {
  console.error('Erro:', err.message);
  process.exit(1);
});
