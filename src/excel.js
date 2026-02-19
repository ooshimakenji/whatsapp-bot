/**
 * excel.js — Atualiza planilha Excel Online via Microsoft Graph API
 *
 * Requer autenticação prévia: node auth-excel.mjs
 * Token salvo em archive/.excel_token.json (renovado automaticamente via refresh token).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CONFIG } from './config.js';
import { addAlert } from './alerts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TOKEN_FILE = path.join(__dirname, '..', 'archive', '.excel_token.json');
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const CLIENT_ID = '14d82eec-204b-4c2f-b7e8-296a70dab67e'; // Microsoft Graph Command Line Tools
const TENANT = 'ambientalsc.onmicrosoft.com';

// ============================================
// GERENCIAMENTO DE TOKEN
// ============================================

function readToken() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveToken(token) {
  try {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(token));
  } catch { /* best effort */ }
}

async function getAccessToken() {
  const stored = readToken();
  if (!stored) return null;

  // Ainda válido (margem de 5 min)
  if (stored.expires_at && Date.now() < stored.expires_at - 300_000) {
    return stored.access_token;
  }

  // Renova via refresh token
  if (!stored.refresh_token) return null;

  try {
    const resp = await fetch(
      `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: stored.refresh_token,
          scope: 'Files.ReadWrite offline_access',
        }).toString(),
      }
    );

    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data.access_token) return null;

    const newToken = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || stored.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
    };
    saveToken(newToken);
    return newToken.access_token;
  } catch {
    return null;
  }
}

// ============================================
// ATUALIZAR PLANILHA
// ============================================

/**
 * Encontra todas as linhas com o protocolo na coluna A e atualiza
 * a coluna de status (CONFIG.excelStatusCol) com o resultado.
 *
 * @param {string} protocolo  - 10 dígitos (protocolo AS válido)
 * @param {number} photoCount - Quantidade de fotos/vídeos salvos
 */
export async function updateExcelRecord(protocolo, photoCount) {
  if (!CONFIG.excelFileId || !protocolo) return;

  const token = await getAccessToken();
  if (!token) {
    console.log('  [Excel] Token não encontrado — execute: node auth-excel.mjs');
    return;
  }

  // Normaliza: mantém só dígitos (elimina espaços, caracteres invisíveis, etc.)
  const cleanProtocolo = String(protocolo).replace(/\D/g, '');
  if (!cleanProtocolo) return;

  const fileId = CONFIG.excelFileId;
  const sheet = encodeURIComponent(CONFIG.excelSheetName);
  const statusCol = CONFIG.excelStatusCol;
  const statusValue = photoCount >= 3 ? 'Sim' : `${photoCount} foto(s)`;

  try {
    // Passo 1: lê só coluna A no intervalo configurado
    const ROW_START = 2000;
    const ROW_END   = 6000;
    const colAResp = await fetch(
      `${GRAPH_BASE}/me/drive/items/${fileId}/workbook/worksheets('${sheet}')/range(address='A${ROW_START}:A${ROW_END}')`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!colAResp.ok) {
      const body = await colAResp.text();
      console.error(`  [Excel] Erro ao ler planilha (${colAResp.status}):`, body.slice(0, 300));
      return;
    }

    const { values: colAValues = [] } = await colAResp.json();

    // Encontra todas as linhas com o protocolo na coluna A
    // índice i → linha Excel = ROW_START + i
    const candidateRows = [];
    for (let i = 0; i < colAValues.length; i++) {
      if (String(colAValues[i][0] ?? '').replace(/\D/g, '') === cleanProtocolo) {
        candidateRows.push(ROW_START + i);
      }
    }

    if (candidateRows.length === 0) {
      console.log(`  [Excel] Protocolo ${cleanProtocolo} não encontrado na planilha`);
      await addAlert('excel_nao_encontrado', `⚠️ Protocolo ${cleanProtocolo} não encontrado na planilha (${photoCount} foto(s) salva(s)).`);
      return;
    }

    // Passo 2: para cada linha candidata, verifica coluna F individualmente
    // (evita ler range A:F inteiro que estoura o limite da API)
    const matchingRows = [];
    for (const row of candidateRows) {
      const fResp = await fetch(
        `${GRAPH_BASE}/me/drive/items/${fileId}/workbook/worksheets('${sheet}')/range(address='F${row}')`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (fResp.ok) {
        const { values: fVal } = await fResp.json();
        const colF = String(fVal?.[0]?.[0] ?? '').trim();
        if (colF === 'Batedor') continue; // ignora silenciosamente
      }
      matchingRows.push(row);
    }

    if (matchingRows.length === 0) {
      // Protocolo existe mas todas as linhas são Batedor — ignora sem alerta
      console.log(`  [Excel] ${cleanProtocolo} ignorado (todas as linhas com col F = Batedor)`);
      return;
    }

    // Atualiza coluna de status em cada linha encontrada
    for (const row of matchingRows) {
      const patchResp = await fetch(
        `${GRAPH_BASE}/me/drive/items/${fileId}/workbook/worksheets('${sheet}')/range(address='${statusCol}${row}')`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ values: [[statusValue]] }),
        }
      );

      if (!patchResp.ok) {
        const body = await patchResp.text();
        console.error(`  [Excel] Erro ao atualizar linha ${row} (${patchResp.status}):`, body.slice(0, 300));
      }
    }

    console.log(`  [Excel] ${cleanProtocolo}: "${statusValue}" → linha(s) ${matchingRows.join(', ')}`);
  } catch (err) {
    console.error('  [Excel] Erro inesperado:', err.message);
  }
}
