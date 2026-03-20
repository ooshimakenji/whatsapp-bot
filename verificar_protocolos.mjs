#!/usr/bin/env node

/**
 * @file verificar_protocolos.mjs
 * @description Verifica quais protocolos de uma planilha XLSX já possuem fotos arquivadas
 *   em um ou mais diretórios de arquivo (drives de rede, pastas locais, etc.).
 *
 * COMO FUNCIONA
 * -------------
 * 1. Lê todos os valores de 10 dígitos da planilha XLSX (protocolo AS).
 * 2. Protocolos com status OK em cache são pulados (resultado imediato).
 * 3. Os demais são verificados em paralelo (20 simultâneos) contra o sistema de arquivos.
 * 4. Para cada protocolo, busca em 4 lugares dentro de cada diretório base:
 *      a) {base}/{protocolo}/                       → PROTOCOLO
 *      b) {base}/protocolo_revisar/{protocolo}/     → PROTOCOLO_REVISAR
 *      c) {base}/sem_legenda/** (recursivo)         → SEM_LEGENDA
 *      d) {base}/{grupo}/{protocolo}/ e variantes   → idem acima, por grupo
 * 5. Gera dois arquivos de saída:
 *      - relatorio_verificacao.csv  (resultado completo, abre no Excel)
 *      - protocolos_para_organizer.txt  (lista dos que precisam de ação manual)
 * 6. Atualiza o cache com os novos resultados OK.
 *
 * STATUS POSSÍVEIS NO CSV
 * -----------------------
 *   OK                 → >= minImages imagens encontradas na pasta correta
 *   INCOMPLETO         → encontrado, mas com menos imagens que o mínimo
 *   SEM_IMAGEM         → pasta existe mas está vazia (0 imagens)
 *   NAO_ENCONTRADO     → nenhuma pasta encontrada para esse protocolo
 *
 * CACHE
 * -----
 *   Protocolos com status OK são salvos em verificar_cache.json.
 *   Na próxima execução, eles são pulados e marcados como CACHE=Sim no CSV.
 *   Protocolos INCOMPLETO, SEM_IMAGEM e NAO_ENCONTRADO são sempre re-verificados.
 *   Use --no-cache para ignorar o cache e re-verificar tudo (o cache é regravado ao final).
 *
 * DIRETÓRIOS DE BUSCA
 * -------------------
 *   Lidos automaticamente do .env:
 *     ARCHIVE_DIR           → diretório principal
 *     ARCHIVE_FALLBACK_DIR  → diretório reserva
 *     GROUP_ARCHIVE_DIRS    → formato "Grupo=X:\caminho;Outro=Z:\outro"
 *   Adicionais via CLI:
 *     --dirs "X:\Agua;Z:\Outro"
 *
 * USO
 * ---
 *   node verificar_protocolos.mjs <input.xlsx>
 *   node verificar_protocolos.mjs <input.xlsx> --dirs "X:\Agua;Z:\Outro"
 *   node verificar_protocolos.mjs <input.xlsx> --min 3
 *   node verificar_protocolos.mjs <input.xlsx> --no-cache
 *   node verificar_protocolos.mjs --help
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ExcelJS from 'exceljs';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

// ─────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────

/** Extensões de imagem reconhecidas na contagem de mídia. */
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/** Extensões de vídeo reconhecidas na contagem de mídia. */
const VIDEO_EXTS = new Set(['.mp4', '.3gp', '.mov']);

/** Protocolo AS válido: exatamente 10 dígitos numéricos. */
const PROTOCOLO_REGEX = /^\d{10}$/;

/** BOM UTF-8 — garante que o CSV abre corretamente no Excel brasileiro. */
const BOM = '\uFEFF';

/** Separador de colunas do CSV (ponto-e-vírgula, padrão Excel pt-BR). */
const CSV_SEP = ';';

/** Cabeçalho do CSV de saída. */
const CSV_HEADER = [
  'PROTOCOLO', 'ENCONTRADO', 'CAMINHO', 'LOCAL',
  'TOTAL_IMAGENS', 'TOTAL_VIDEOS', 'STATUS', 'ACAO_SUGERIDA', 'CACHE',
].join(CSV_SEP);

/**
 * Pastas que devem ser ignoradas ao listar subdiretórios de grupo.
 * Evita buscar dentro das próprias pastas especiais do bot.
 */
const SKIP_DIRS = new Set(['logs', '.buffer_temp', 'sem_legenda', 'protocolo_revisar']);

/** Número de protocolos verificados simultaneamente contra o drive de rede. */
const CONCURRENCY = 20;

/** Caminho do arquivo de cache local (mesmo diretório do script). */
const CACHE_FILE = path.join(__dirname, 'verificar_cache.json');

// ─────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────

/**
 * Parseia os argumentos da linha de comando.
 *
 * @returns {{ xlsxPath: string, extraDirs: string[], minImages: number, noCache: boolean }}
 */
function parseArgs() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
Uso: node verificar_protocolos.mjs <input.xlsx> [opcoes]

Opcoes:
  --dirs "X:\\path1;Z:\\path2"   Diretorios adicionais para busca (separados por ;)
  --min N                       Minimo de imagens para status OK (padrao: 3)
  --no-cache                    Ignora cache e re-verifica tudo (regrava cache ao final)
  --help                        Mostra esta ajuda

Exemplos:
  node verificar_protocolos.mjs ListaAS.xlsx
  node verificar_protocolos.mjs ListaAS.xlsx --dirs "X:\\Agua" --min 5
  node verificar_protocolos.mjs ListaAS.xlsx --no-cache
`);
    process.exit(0);
  }

  let xlsxPath = null;
  let extraDirs = [];
  let minImages = 3;
  let noCache = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dirs' && i + 1 < args.length) {
      extraDirs = args[i + 1].split(';').map(d => d.trim()).filter(Boolean);
      i++;
    } else if (args[i] === '--min' && i + 1 < args.length) {
      minImages = parseInt(args[i + 1], 10);
      if (isNaN(minImages) || minImages < 1) {
        console.error('Erro: --min deve ser um numero inteiro positivo.');
        process.exit(1);
      }
      i++;
    } else if (args[i] === '--no-cache') {
      noCache = true;
    } else if (!xlsxPath) {
      xlsxPath = args[i];
    }
  }

  if (!xlsxPath) {
    console.error('Erro: informe o caminho do arquivo XLSX. Use --help para ajuda.');
    process.exit(1);
  }

  xlsxPath = path.resolve(xlsxPath);

  if (!fs.existsSync(xlsxPath)) {
    console.error(`Erro: arquivo nao encontrado: ${xlsxPath}`);
    process.exit(1);
  }

  return { xlsxPath, extraDirs, minImages, noCache };
}

// ─────────────────────────────────────────────
// CACHE
// ─────────────────────────────────────────────

/**
 * Carrega o cache de protocolos OK do disco.
 * Retorna objeto vazio se o arquivo não existir ou estiver corrompido.
 *
 * Formato do cache:
 * ```json
 * {
 *   "2026012345": {
 *     "status": "OK",
 *     "local": "PROTOCOLO",
 *     "caminho": "X:\\...",
 *     "images": 5,
 *     "videos": 0,
 *     "cachedAt": "2026-03-20T10:00:00.000Z"
 *   }
 * }
 * ```
 *
 * @returns {Promise<Record<string, object>>}
 */
async function loadCache() {
  try {
    const raw = await fs.promises.readFile(CACHE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    // Arquivo inexistente ou JSON inválido — começa com cache vazio
    return {};
  }
}

/**
 * Salva o cache atualizado no disco.
 *
 * @param {Record<string, object>} cache
 * @returns {Promise<void>}
 */
async function saveCache(cache) {
  await fs.promises.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
}

// ─────────────────────────────────────────────
// DIRETÓRIOS DE BUSCA
// ─────────────────────────────────────────────

/**
 * Coleta e valida os diretórios de busca a partir do .env e dos argumentos CLI.
 *
 * Fontes (em ordem):
 *   1. ARCHIVE_DIR           → diretório principal do .env
 *   2. ARCHIVE_FALLBACK_DIR  → diretório reserva do .env
 *   3. GROUP_ARCHIVE_DIRS    → por grupo, formato "Grupo=X:\caminho;Outro=Z:\outro"
 *   4. extraDirs             → passados via --dirs na CLI
 *
 * Diretórios inacessíveis (drive desconectado, sem permissão) são descartados com aviso.
 *
 * @param {string[]} extraDirs - Diretórios adicionais da CLI
 * @returns {Promise<string[]>} Lista de diretórios acessíveis (sem duplicatas)
 */
async function collectSearchDirs(extraDirs) {
  const dirs = new Set();

  // 1. Diretório principal
  const archiveDir = process.env.ARCHIVE_DIR;
  if (archiveDir) dirs.add(path.resolve(__dirname, archiveDir));

  // 2. Diretório reserva (fallback de drive)
  const fallbackDir = process.env.ARCHIVE_FALLBACK_DIR;
  if (fallbackDir) dirs.add(path.resolve(__dirname, fallbackDir));

  // 3. Diretórios por grupo — extrai só o caminho (ignora o nome do grupo)
  const groupDirs = process.env.GROUP_ARCHIVE_DIRS || '';
  for (const entry of groupDirs.split(';').map(s => s.trim()).filter(Boolean)) {
    const idx = entry.indexOf('=');
    if (idx === -1) continue;
    const dirPath = entry.slice(idx + 1).trim();
    if (dirPath) dirs.add(dirPath);
  }

  // 4. Extras da CLI
  for (const d of extraDirs) dirs.add(path.resolve(d));

  // Verifica acessibilidade em paralelo
  const checks = await Promise.all([...dirs].map(async d => {
    try {
      await fs.promises.access(d, fs.constants.R_OK);
      return d;
    } catch {
      console.warn(`  [AVISO] Diretorio inacessivel (drive desconectado?): ${d}`);
      return null;
    }
  }));

  return checks.filter(Boolean);
}

// ─────────────────────────────────────────────
// LEITURA DO XLSX
// ─────────────────────────────────────────────

/**
 * Lê todos os protocolos (10 dígitos numéricos) de todas as abas do XLSX.
 *
 * Suporta células com valor numérico, string, fórmula (usa .result) e richText.
 * Protocolos duplicados são deduplicados automaticamente.
 *
 * @param {string} xlsxPath - Caminho absoluto do arquivo XLSX
 * @returns {Promise<string[]>} Array de protocolos únicos, ordenados
 */
async function readProtocolsFromXlsx(xlsxPath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(xlsxPath);

  const protocolos = new Set();

  for (const sheet of workbook.worksheets) {
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        let val = cell.value;

        // Normaliza tipos complexos do ExcelJS
        if (val && typeof val === 'object') {
          if (val.result !== undefined) val = val.result;           // fórmula
          else if (val.richText) val = val.richText.map(r => r.text).join('');
          else if (val.text) val = val.text;
          else return;
        }

        const str = String(val).trim();
        if (PROTOCOLO_REGEX.test(str)) {
          protocolos.add(str);
        }
      });
    });
  }

  return [...protocolos].sort();
}

// ─────────────────────────────────────────────
// CONTAGEM DE MÍDIA
// ─────────────────────────────────────────────

/**
 * Conta imagens e vídeos diretamente dentro de um diretório (não recursivo).
 * Ignora subpastas e arquivos com extensão não reconhecida.
 *
 * @param {string} dirPath - Caminho do diretório a contar
 * @returns {Promise<{ images: number, videos: number }>}
 */
async function countMedia(dirPath) {
  let images = 0;
  let videos = 0;

  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (IMAGE_EXTS.has(ext)) images++;
      else if (VIDEO_EXTS.has(ext)) videos++;
    }
  } catch {
    // Permissão negada ou diretório sumiu durante a varredura — retorna zeros
  }

  return { images, videos };
}

// ─────────────────────────────────────────────
// BUSCA EM sem_legenda
// ─────────────────────────────────────────────

/**
 * Busca recursivamente dentro de um diretório sem_legenda por subpastas
 * cujo nome contenha o protocolo informado.
 *
 * Exemplos de nomes que fazem match:
 *   "2026029748"                          → protocolo exato
 *   "2026029748_2026029725_2026029532"    → múltiplos protocolos na mesma pasta
 *   "lote_2026-03-19_2026029748"          → protocolo no nome do lote
 *
 * A busca desce até maxDepth níveis para cobrir estruturas como:
 *   sem_legenda/{autor}/{protocolo}/
 *   sem_legenda/{autor}/{lote com protocolo}/
 *
 * Todos os níveis de um mesmo nível são explorados em paralelo (Promise.all).
 *
 * @param {string} semLegendaDir - Caminho da pasta sem_legenda
 * @param {string} protocolo     - Protocolo de 10 dígitos a procurar
 * @param {number} [maxDepth=3]  - Profundidade máxima de recursão
 * @returns {Promise<string[]>} Caminhos completos das pastas que contêm o protocolo
 */
async function searchSemLegenda(semLegendaDir, protocolo, maxDepth = 3) {
  const results = [];

  async function walk(dir, depth) {
    if (depth > maxDepth) return;

    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // Diretório inacessível — pula silenciosamente
    }

    const subdirs = entries.filter(e => e.isDirectory());

    // Processa todos os subdiretórios deste nível em paralelo
    await Promise.all(subdirs.map(async entry => {
      const fullPath = path.join(dir, entry.name);
      if (entry.name.includes(protocolo)) {
        results.push(fullPath);
      }
      await walk(fullPath, depth + 1);
    }));
  }

  try {
    await fs.promises.access(semLegendaDir);
    await walk(semLegendaDir, 0);
  } catch {
    // sem_legenda não existe neste diretório — normal
  }

  return results;
}

// ─────────────────────────────────────────────
// BUSCA DE PROTOCOLO
// ─────────────────────────────────────────────

/**
 * Busca um protocolo em todos os diretórios base, verificando simultaneamente:
 *
 * Para cada baseDir:
 *   (a) {baseDir}/{protocolo}/
 *   (b) {baseDir}/protocolo_revisar/{protocolo}/
 *   (c) {baseDir}/sem_legenda/** (recursivo)
 *   (d) Para cada subpasta de grupo em baseDir (exceto SKIP_DIRS):
 *       - {baseDir}/{grupo}/{protocolo}/
 *       - {baseDir}/{grupo}/protocolo_revisar/{protocolo}/
 *       - {baseDir}/{grupo}/sem_legenda/** (recursivo)
 *
 * Todas as verificações dentro de um mesmo baseDir disparam em paralelo.
 * Os baseDirs também são verificados em paralelo entre si.
 *
 * @param {string} protocolo     - Protocolo de 10 dígitos
 * @param {string[]} searchDirs  - Lista de diretórios base para busca
 * @returns {Promise<Array<{ caminho: string, local: string, images: number, videos: number }>>}
 */
async function searchProtocolo(protocolo, searchDirs) {
  const perBase = await Promise.all(searchDirs.map(async baseDir => {
    const results = [];

    // Lista subdiretórios do baseDir para identificar grupos
    let topEntries;
    try {
      topEntries = await fs.promises.readdir(baseDir, { withFileTypes: true });
    } catch {
      return results; // Drive inacessível durante a busca
    }

    // Filtra apenas pastas de grupo (ignora pastas especiais do bot)
    const groupEntries = topEntries.filter(
      e => e.isDirectory() && !SKIP_DIRS.has(e.name)
    );

    // Monta todas as tarefas de verificação deste baseDir
    const tasks = [];

    // (a) Protocolo diretamente no baseDir — comum quando baseDir = pasta Água
    tasks.push(async () => {
      const p = path.join(baseDir, protocolo);
      try {
        if ((await fs.promises.stat(p)).isDirectory()) {
          const { images, videos } = await countMedia(p);
          results.push({ caminho: p, local: 'PROTOCOLO', images, videos });
        }
      } catch {}
    });

    // (b) protocolo_revisar diretamente no baseDir
    tasks.push(async () => {
      const p = path.join(baseDir, 'protocolo_revisar', protocolo);
      try {
        if ((await fs.promises.stat(p)).isDirectory()) {
          const { images, videos } = await countMedia(p);
          results.push({ caminho: p, local: 'PROTOCOLO_REVISAR', images, videos });
        }
      } catch {}
    });

    // (c) sem_legenda diretamente no baseDir
    tasks.push(async () => {
      const semPath = path.join(baseDir, 'sem_legenda');
      const matches = await searchSemLegenda(semPath, protocolo);
      await Promise.all(matches.map(async matchPath => {
        const { images, videos } = await countMedia(matchPath);
        results.push({ caminho: matchPath, local: 'SEM_LEGENDA', images, videos });
      }));
    });

    // (d) Dentro de cada subpasta de grupo
    for (const entry of groupEntries) {
      const groupDir = path.join(baseDir, entry.name);

      tasks.push(async () => {
        const p = path.join(groupDir, protocolo);
        try {
          if ((await fs.promises.stat(p)).isDirectory()) {
            const { images, videos } = await countMedia(p);
            results.push({ caminho: p, local: 'PROTOCOLO', images, videos });
          }
        } catch {}
      });

      tasks.push(async () => {
        const p = path.join(groupDir, 'protocolo_revisar', protocolo);
        try {
          if ((await fs.promises.stat(p)).isDirectory()) {
            const { images, videos } = await countMedia(p);
            results.push({ caminho: p, local: 'PROTOCOLO_REVISAR', images, videos });
          }
        } catch {}
      });

      tasks.push(async () => {
        const semPath = path.join(groupDir, 'sem_legenda');
        const matches = await searchSemLegenda(semPath, protocolo);
        await Promise.all(matches.map(async matchPath => {
          const { images, videos } = await countMedia(matchPath);
          results.push({ caminho: matchPath, local: 'SEM_LEGENDA', images, videos });
        }));
      });
    }

    // Dispara todas as verificações deste baseDir em paralelo
    await Promise.all(tasks.map(fn => fn()));
    return results;
  }));

  return perBase.flat();
}

// ─────────────────────────────────────────────
// POOL DE CONCORRÊNCIA
// ─────────────────────────────────────────────

/**
 * Executa uma função assíncrona sobre um array de itens com limite de concorrência.
 *
 * Diferente de Promise.all (que dispara tudo ao mesmo tempo), o pool garante que
 * no máximo `concurrency` itens sejam processados simultaneamente — importante para
 * não saturar o drive de rede com centenas de conexões paralelas.
 *
 * @template T, R
 * @param {T[]} items           - Itens a processar
 * @param {number} concurrency  - Máximo de itens simultâneos
 * @param {(item: T, index: number) => Promise<R>} fn - Função a executar por item
 * @returns {Promise<R[]>} Resultados na mesma ordem dos itens de entrada
 */
async function runWithPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;

  // Cada worker pega o próximo item disponível até esgotar a lista
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }

  // Cria exatamente `concurrency` workers (ou menos se houver poucos itens)
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker)
  );

  return results;
}

// ─────────────────────────────────────────────
// STATUS E AÇÃO SUGERIDA
// ─────────────────────────────────────────────

/**
 * Determina o status e a ação sugerida para um resultado de busca.
 *
 * Tabela de decisão:
 * | Encontrado | Images | Local             | Status        | Ação                      |
 * |------------|--------|-------------------|---------------|---------------------------|
 * | Não        | -      | -                 | NAO_ENCONTRADO| USAR_ORGANIZER            |
 * | Sim        | 0      | PROTOCOLO         | SEM_IMAGEM    | INCOMPLETO_USAR_ORGANIZER |
 * | Sim        | 0      | outro             | SEM_IMAGEM    | VERIFICAR_SEM_LEGENDA     |
 * | Sim        | < min  | PROTOCOLO         | INCOMPLETO    | INCOMPLETO_USAR_ORGANIZER |
 * | Sim        | < min  | outro             | INCOMPLETO    | VERIFICAR_SEM_LEGENDA     |
 * | Sim        | >= min | PROTOCOLO         | OK            | OK                        |
 * | Sim        | >= min | PROTOCOLO_REVISAR | OK            | VERIFICAR_SEM_LEGENDA     |
 * | Sim        | >= min | SEM_LEGENDA       | OK            | VERIFICAR_SEM_LEGENDA     |
 *
 * @param {boolean} encontrado   - Se foi encontrado algum resultado
 * @param {string}  local        - PROTOCOLO | PROTOCOLO_REVISAR | SEM_LEGENDA | NAO_ENCONTRADO
 * @param {number}  totalImagens - Total de imagens encontradas na pasta
 * @param {number}  minImages    - Mínimo de imagens para considerar OK
 * @returns {{ status: string, acao: string }}
 */
function getStatusAndAction(encontrado, local, totalImagens, minImages) {
  if (!encontrado) {
    return { status: 'NAO_ENCONTRADO', acao: 'USAR_ORGANIZER' };
  }

  if (totalImagens === 0) {
    return {
      status: 'SEM_IMAGEM',
      acao: local === 'PROTOCOLO' ? 'INCOMPLETO_USAR_ORGANIZER' : 'VERIFICAR_SEM_LEGENDA',
    };
  }

  if (totalImagens < minImages) {
    return {
      status: 'INCOMPLETO',
      acao: local === 'PROTOCOLO' ? 'INCOMPLETO_USAR_ORGANIZER' : 'VERIFICAR_SEM_LEGENDA',
    };
  }

  if (local === 'PROTOCOLO_REVISAR' || local === 'SEM_LEGENDA') {
    return { status: 'OK', acao: 'VERIFICAR_SEM_LEGENDA' };
  }

  return { status: 'OK', acao: 'OK' };
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────

async function main() {
  const { xlsxPath, extraDirs, minImages, noCache } = parseArgs();

  console.log(`\n=== Verificador de Protocolos ===\n`);
  console.log(`Arquivo XLSX  : ${xlsxPath}`);
  console.log(`Min. imagens  : ${minImages}`);
  console.log(`Concorrencia  : ${CONCURRENCY} protocolos simultaneos`);
  console.log(`Cache         : ${noCache ? 'DESATIVADO (--no-cache)' : 'ativado'}`);

  // Carrega cache e coleta diretórios em paralelo (independentes entre si)
  const [cache, searchDirs] = await Promise.all([
    loadCache(),
    (async () => {
      console.log(`\nColetando diretorios de busca...`);
      return collectSearchDirs(extraDirs);
    })(),
  ]);

  if (searchDirs.length === 0) {
    console.error('\nErro: nenhum diretorio de busca acessivel. Verifique o .env e os drives.');
    process.exit(1);
  }

  console.log(`Diretorios (${searchDirs.length}):`);
  for (const d of searchDirs) console.log(`  - ${d}`);

  // Lê protocolos da planilha
  console.log(`\nLendo protocolos do XLSX...`);
  const protocolos = await readProtocolsFromXlsx(xlsxPath);

  if (protocolos.length === 0) {
    console.error('\nNenhum protocolo (10 digitos) encontrado no arquivo XLSX.');
    process.exit(1);
  }

  console.log(`Protocolos na planilha: ${protocolos.length}`);

  // ── Separa cached (OK) × a verificar ────────────────────────────────────

  /** @type {Map<string, object>} Protocolos que vieram do cache (status OK) */
  const fromCache = new Map();

  /** @type {string[]} Protocolos que precisam ser verificados no drive */
  const toVerify = [];

  for (const protocolo of protocolos) {
    if (!noCache && cache[protocolo]?.status === 'OK') {
      fromCache.set(protocolo, cache[protocolo]);
    } else {
      toVerify.push(protocolo);
    }
  }

  console.log(`\nDo cache (OK): ${fromCache.size} | A verificar: ${toVerify.length}`);

  // ── Verifica no drive os que não estão em cache ──────────────────────────

  /** @type {Map<string, Array>} Resultados frescos por protocolo */
  const freshMap = new Map();
  let elapsed = '0.0';

  if (toVerify.length > 0) {
    console.log(`Verificando ${toVerify.length} protocolos em paralelo...`);
    const t0 = Date.now();

    const freshResults = await runWithPool(
      toVerify,
      CONCURRENCY,
      protocolo => searchProtocolo(protocolo, searchDirs)
    );

    elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`Verificacao concluida em ${elapsed}s`);

    for (let i = 0; i < toVerify.length; i++) {
      freshMap.set(toVerify[i], freshResults[i]);
    }
  }

  // ── Atualiza cache ───────────────────────────────────────────────────────

  const newCache = { ...cache };

  for (const [protocolo, results] of freshMap) {
    // Procura o primeiro resultado com status OK para cachear
    let okResult = null;
    for (const r of results) {
      const { status } = getStatusAndAction(true, r.local, r.images, minImages);
      if (status === 'OK') { okResult = r; break; }
    }

    if (okResult) {
      // Salva no cache com timestamp para auditoria
      newCache[protocolo] = {
        status: 'OK',
        local: okResult.local,
        caminho: okResult.caminho,
        images: okResult.images,
        videos: okResult.videos,
        cachedAt: new Date().toISOString(),
      };
    } else {
      // Protocolo estava em cache mas agora não é mais OK — remove entrada stale
      delete newCache[protocolo];
    }
  }

  await saveCache(newCache);

  // ── Monta CSV e contadores ───────────────────────────────────────────────

  const csvRows = [];
  const paraOrganizer = [];  // Protocolos que precisam de ação manual
  const warnings = [];       // Alertas de protocolo_revisar e sem_legenda

  let countOK = 0;
  let countIncompleto = 0;
  let countSemImagem = 0;
  let countNaoEncontrado = 0;
  let countRevisar = 0;
  let countSemLegenda = 0;
  let countFromCache = 0;

  for (const protocolo of protocolos) {

    // Protocolo veio do cache — gera linha com CACHE=Sim
    if (fromCache.has(protocolo)) {
      const c = fromCache.get(protocolo);
      csvRows.push([
        protocolo, 'Sim', c.caminho, c.local,
        c.images, c.videos, 'OK',
        c.local === 'PROTOCOLO' ? 'OK' : 'VERIFICAR_SEM_LEGENDA',
        'Sim',
      ].join(CSV_SEP));
      countOK++;
      countFromCache++;
      continue;
    }

    // Protocolo verificado agora — gera linha(s) com CACHE=Nao
    const results = freshMap.get(protocolo) ?? [];

    if (results.length === 0) {
      // Não encontrado em nenhum diretório
      const { status, acao } = getStatusAndAction(false, 'NAO_ENCONTRADO', 0, minImages);
      csvRows.push([protocolo, 'Nao', '', 'NAO_ENCONTRADO', 0, 0, status, acao, 'Nao'].join(CSV_SEP));
      paraOrganizer.push(protocolo);
      countNaoEncontrado++;
    } else {
      // Pode haver múltiplas ocorrências (ex: em sem_legenda E em protocolo/)
      for (const result of results) {
        const { status, acao } = getStatusAndAction(true, result.local, result.images, minImages);

        csvRows.push([
          protocolo, 'Sim', result.caminho, result.local,
          result.images, result.videos, status, acao, 'Nao',
        ].join(CSV_SEP));

        if (status === 'OK') countOK++;
        else if (status === 'INCOMPLETO') {
          countIncompleto++;
          paraOrganizer.push(protocolo); // Incompleto também vai para o organizer
        } else if (status === 'SEM_IMAGEM') countSemImagem++;

        if (result.local === 'PROTOCOLO_REVISAR') {
          countRevisar++;
          warnings.push(`  [!] Protocolo ${protocolo} em protocolo_revisar: ${result.caminho}`);
        }
        if (result.local === 'SEM_LEGENDA') {
          countSemLegenda++;
          warnings.push(`  [!] Protocolo ${protocolo} em sem_legenda: ${result.caminho}`);
        }
      }
    }
  }

  // Exibe alertas ao final para não poluir o progresso
  for (const w of warnings) console.warn(w);

  // ── Gera arquivos de saída ───────────────────────────────────────────────

  const outputDir = path.dirname(xlsxPath);

  // CSV com todos os protocolos e seus status
  const csvPath = path.join(outputDir, 'relatorio_verificacao.csv');
  await fs.promises.writeFile(
    csvPath,
    BOM + CSV_HEADER + '\n' + csvRows.join('\n') + '\n',
    'utf8'
  );
  console.log(`\nRelatorio CSV salvo: ${csvPath}`);

  // Lista simplificada para uso no organizer offline
  const paraOrganizerUnique = [...new Set(paraOrganizer)];
  const orgPath = path.join(outputDir, 'protocolos_para_organizer.txt');
  await fs.promises.writeFile(orgPath, paraOrganizerUnique.join('\n') + '\n', 'utf8');
  console.log(`Lista organizer: ${orgPath} (${paraOrganizerUnique.length} protocolos)`);

  // ── Resumo final ─────────────────────────────────────────────────────────

  console.log(`
=== RESUMO ===
Total na planilha              : ${protocolos.length}
  Do cache (nao re-verificados): ${countFromCache}
  Verificados agora            : ${toVerify.length}
OK (>= ${minImages} imagens)           : ${countOK}
Incompleto (< ${minImages} imagens)    : ${countIncompleto}
Sem imagem (pasta vazia)       : ${countSemImagem}
Nao encontrado                 : ${countNaoEncontrado}
Em protocolo_revisar           : ${countRevisar}
Em sem_legenda                 : ${countSemLegenda}
Tempo de verificacao           : ${elapsed}s
`);
}

main().catch(err => {
  console.error(`Erro fatal: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
