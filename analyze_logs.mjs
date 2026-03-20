import fs from 'fs';
import path from 'path';

const LOG_DIR = 'C:/Users/vinicius.oshima/.pm2/logs';
const OUT_LOGS = [
  'whatsapp-bila-organizer-out__2026-02-28_00-00-02.log',
  'whatsapp-bila-organizer-out__2026-03-01_00-00-02.log',
  'whatsapp-bila-organizer-out__2026-03-02_07-24-21.log',
  'whatsapp-bila-organizer-out__2026-03-03_00-00-02.log',
  'whatsapp-bila-organizer-out.log',
];
const ERR_LOGS = [
  'whatsapp-bila-organizer-error__2026-02-28_00-00-02.log',
  'whatsapp-bila-organizer-error__2026-03-01_00-00-02.log',
  'whatsapp-bila-organizer-error__2026-03-02_07-24-22.log',
  'whatsapp-bila-organizer-error__2026-03-03_00-00-02.log',
  'whatsapp-bila-organizer-error.log',
];

let allOutLines = [];
let allErrLines = [];

for (const f of OUT_LOGS) {
  const fpath = path.join(LOG_DIR, f);
  if (!fs.existsSync(fpath)) { console.error('MISSING:', fpath); continue; }
  const lines = fs.readFileSync(fpath, 'utf8').split('\n');
  allOutLines = allOutLines.concat(lines);
}
for (const f of ERR_LOGS) {
  const fpath = path.join(LOG_DIR, f);
  if (!fs.existsSync(fpath)) { console.error('MISSING:', fpath); continue; }
  const lines = fs.readFileSync(fpath, 'utf8').split('\n');
  allErrLines = allErrLines.concat(lines);
}

console.error(`Out lines: ${allOutLines.length}, Err lines: ${allErrLines.length}`);

// ==============================================================
// REGEX PATTERNS
// ==============================================================

// --- SUCCESS SAVES (2 formats) ---
//
// FORMAT A (old, until ~19/02/2026):
//   ALERTA: ✅ [DD/MM/YYYY, HH:MM:SS] N mídia(s) de AUTHOR salva(s) em GROUP → PROTO1, PROTO2
//   (no protocol = sem_legenda flush)
//
// FORMAT B (new, from 19/02/2026):
//   ALERTA: ✅ [AUTHOR][N → PROTO1, PROTO2] GROUP [DD/MM/YYYY, HH:MM:SS]
//   ALERTA: ✅ [AUTHOR][N] GROUP [DD/MM/YYYY, HH:MM:SS]  <- sem_legenda
//
// Note: in BOTH formats, sem_legenda save fires ✅ WITHOUT protocol, PLUS a separate ⏱️ alert
// And multiplas fires ✅ WITH protocols, PLUS a separate 📂 alert

// FORMAT A: "N mídia(s) de AUTHOR salva(s) em GROUP → PROTOS"
const reA_proto   = /ALERTA:.*\]\s+(\d+) m.dia\(s\) de (.+?) salva\(s\) em (.+?) \u2192 ([\d,\s]+)/;
// FORMAT A: "N mídia(s) de AUTHOR salva(s) em GROUP" (no arrow = no protocol)
const reA_noproto = /ALERTA:.*\]\s+(\d+) m.dia\(s\) de (.+?) salva\(s\) em (.+?)$/;

// FORMAT B with protocol: "✅ [AUTHOR][N → PROTOS] GROUP [DATE]"
const reB_proto   = /ALERTA: \u2705 \[(.+?)\]\[(\d+) \u2192 ([\d,\s]+)\] (.+?) \[/;
// FORMAT B no protocol: "✅ [AUTHOR][N] GROUP [DATE]"
const reB_noproto = /ALERTA: \u2705 \[(.+?)\]\[(\d+)\] (.+?) \[/;

// --- SEM LEGENDA (⏱️) - only old-format alert, fires in both eras ---
// "N mídia(s) sem legenda de AUTHOR em GROUP → sem_legenda/"
const reSemLeg = /(\d+) m.dia\(s\) sem legenda de (.+?) em (.+?) \u2192/;

// --- PROTOCOLO REVISAR (🔢) ---
// "Protocolo(s) "X" fora do padrão 2025/2026 - AUTHOR em GROUP"
const reProtRev = /Protocolo\(s\) "(.+?)" fora do padr.o \d+\/\d+ - (.+?) em (.+?)$/;

// --- MULTIPLAS LEGENDAS (📂) ---
// "Múltiplas legendas (PROTO1, PROTO2) - AUTHOR em GROUP"
const reMult = /M.ltiplas legendas \((.+?)\) - (.+?) em (.+?)$/;

// --- ERRO AO SALVAR (❌) ---
// "Erro ao salvar FILENAME de AUTHOR em GROUP: REASON"
const reErro = /Erro ao salvar (.+?) de (.+?) em (.+?):\s+(.+?)$/;

// --- DATE for daily breakdown ---
// Format A date: "[DD/MM/YYYY,"   Format B date: at the end "[DD/MM/YYYY,"
const reDate = /\[(\d{2}\/\d{2}\/\d{4})/;

// ==============================================================
// ACCUMULATORS
// ==============================================================

// 1. Valid protocol saves
const salvoByAuthor  = {};
const salvoByGroup   = {};
let salvoTotal = 0;

// 2. Sem legenda (protocol-less flushes)
const semLegByAuthor = {};
const semLegByGroup  = {};
let semLegTotal  = 0;
let semLegEvents = 0;

// 3. Protocolo revisar
const protRevByAuthor = {};
const protRevByGroup  = {};
let protRevEvents = 0;
// Media files saved to protocolo_revisar (estimated from tick lines with invalid protocols)
const protRevFilesByAuthor = {};
let protRevFilesTotal = 0;

// 4. Multiplas legendas
const multByAuthor = {};
const multByGroup  = {};
let multEvents = 0;

// 5. Errors
const errByAuthor = {};
const errByGroup  = {};
let errTotal = 0;

// 6. Daily breakdown
const daily = {};

function addDaily(date, key, n) {
  if (!date) return;
  if (!daily[date]) daily[date] = { salvo:0, semLeg:0, protRev:0, mult:0, erros:0 };
  daily[date][key] = (daily[date][key] || 0) + n;
}

function inc(obj, key, n=1) {
  obj[key] = (obj[key] || 0) + n;
}

// ==============================================================
// PROCESS LINES
// ==============================================================

for (const line of allOutLines) {
  const dateM = line.match(reDate);
  const date  = dateM ? dateM[1] : null;

  // --- Format A: old success saves ---
  if (line.includes('\u2705') && line.includes('salva')) {
    const ma = line.match(reA_proto);
    if (ma) {
      const count  = parseInt(ma[1]);
      const author = ma[2].trim();
      const group  = ma[3].trim();
      const protos = ma[4].split(',').map(p => p.trim()).filter(Boolean);
      const validProtos   = protos.filter(p => p.startsWith('2025') || p.startsWith('2026'));
      const invalidProtos = protos.filter(p => !p.startsWith('2025') && !p.startsWith('2026'));

      if (validProtos.length > 0) {
        // Valid protocol save (may also have invalid mixed in - treat all files as "valid save")
        salvoTotal += count;
        inc(salvoByAuthor, author, count);
        inc(salvoByGroup,  group,  count);
        addDaily(date, 'salvo', count);
      }
      if (invalidProtos.length > 0 && validProtos.length === 0) {
        // All protocols invalid -> protocolo_revisar
        protRevFilesTotal += count;
        inc(protRevFilesByAuthor, author, count);
      }
      continue;
    }
    // Format A no protocol
    const ma2 = line.match(reA_noproto);
    if (ma2) {
      // This is a sem_legenda flush (no protocol). Skip here; counted via ⏱️ alert.
      continue;
    }
  }

  // --- Format B: new success saves ---
  if (line.includes('\u2705') && !line.includes('salva')) {
    const mb = line.match(reB_proto);
    if (mb) {
      const author = mb[1].trim();
      const count  = parseInt(mb[2]);
      const protos = mb[3].split(',').map(p => p.trim()).filter(Boolean);
      const group  = mb[4].trim();
      const validProtos   = protos.filter(p => p.startsWith('2025') || p.startsWith('2026'));
      const invalidProtos = protos.filter(p => !p.startsWith('2025') && !p.startsWith('2026'));

      if (validProtos.length > 0) {
        salvoTotal += count;
        inc(salvoByAuthor, author, count);
        inc(salvoByGroup,  group,  count);
        addDaily(date, 'salvo', count);
      }
      if (invalidProtos.length > 0 && validProtos.length === 0) {
        protRevFilesTotal += count;
        inc(protRevFilesByAuthor, author, count);
      }
      continue;
    }
    // Format B no protocol = sem_legenda flush
    const mb2 = line.match(reB_noproto);
    if (mb2) {
      // sem_legenda flush - will also have a ⏱️ alert, skip to avoid double counting
      continue;
    }
  }

  // --- SEM LEGENDA (⏱️) ---
  if (line.includes('\u23f1') || (line.includes('sem legenda') && line.includes('ALERTA'))) {
    const m = line.match(reSemLeg);
    if (m) {
      const count  = parseInt(m[1]);
      const author = m[2].trim();
      const group  = m[3].trim();
      semLegTotal += count;
      semLegEvents++;
      inc(semLegByAuthor, author, count);
      inc(semLegByGroup,  group,  count);
      addDaily(date, 'semLeg', count);
    }
    continue;
  }

  // --- PROTOCOLO REVISAR (🔢) ---
  if (line.includes('\u1f522') || line.includes('fora do padr')) {
    const m = line.match(reProtRev);
    if (m) {
      const proto  = m[1];
      const author = m[2].trim();
      const group  = m[3].trim();
      protRevEvents++;
      inc(protRevByAuthor, author);
      inc(protRevByGroup,  group);
      addDaily(date, 'protRev', 1);
    }
    continue;
  }

  // --- MULTIPLAS LEGENDAS (📂) ---
  if (line.includes('\u1f4c2') || line.includes('ltiplas legendas')) {
    const m = line.match(reMult);
    if (m) {
      const protos = m[1];
      const author = m[2].trim();
      const group  = m[3].trim();
      multEvents++;
      inc(multByAuthor, author);
      inc(multByGroup,  group);
      addDaily(date, 'mult', 1);
    }
    continue;
  }

  // --- ERRO AO SALVAR (❌) ---
  if (line.includes('Erro ao salvar')) {
    const m = line.match(reErro);
    if (m) {
      const filename = m[1];
      const author   = m[2].trim();
      const group    = m[3].trim();
      const reason   = m[4].trim();
      errTotal++;
      if (!errByAuthor[author]) errByAuthor[author] = { total: 0, reasons: {} };
      errByAuthor[author].total++;
      errByAuthor[author].reasons[reason] = (errByAuthor[author].reasons[reason] || 0) + 1;
      inc(errByGroup, group);
      addDaily(date, 'erros', 1);
    }
  }
}

// ==============================================================
// HELPERS
// ==============================================================

function sortedDesc(obj, key) {
  return Object.entries(obj).sort((a, b) => {
    const va = key ? a[1][key] : a[1];
    const vb = key ? b[1][key] : b[1];
    return vb - va;
  });
}

const HR = '='.repeat(72);
const hr = '-'.repeat(72);

// ==============================================================
// PRINT REPORT
// ==============================================================

console.log('\n' + HR);
console.log('  RELATORIO ANALISE LOGS - WhatsApp Archiver Bot');
console.log('  Periodo coberto: 13/02/2026 a 03/03/2026');
console.log('  Arquivos analisados: 10 logs (5 out + 5 error)');
console.log('  Nota: formato do alerta mudou em 19/02/2026 (ambos capturados)');
console.log(HR);

// ---- 1. VALID SAVES ----
console.log('\n[1] SALVOS COM PROTOCOLO VALIDO (2025xxxxxx / 2026xxxxxx)');
console.log(hr);
console.log(`    Total de midias salvas com protocolo: ${salvoTotal} arquivos`);
console.log('\n    Por AUTOR (midias salvas) - Top 30:');
sortedDesc(salvoByAuthor).forEach(([a, v]) =>
  console.log(`      ${String(v).padStart(4)}  ${a}`)
);
console.log('\n    Por GRUPO:');
sortedDesc(salvoByGroup).forEach(([g, v]) =>
  console.log(`      ${String(v).padStart(4)}  ${g}`)
);

// ---- 2. SEM LEGENDA ----
console.log('\n[2] SEM LEGENDA (sem protocolo) -> sem_legenda/');
console.log(hr);
console.log(`    Eventos de flush sem legenda: ${semLegEvents}`);
console.log(`    Total de midias sem legenda:  ${semLegTotal} arquivos`);
console.log('\n    Por AUTOR (midias):');
sortedDesc(semLegByAuthor).forEach(([a, v]) =>
  console.log(`      ${String(v).padStart(4)}  ${a}`)
);
console.log('\n    Por GRUPO:');
sortedDesc(semLegByGroup).forEach(([g, v]) =>
  console.log(`      ${String(v).padStart(4)}  ${g}`)
);

// ---- 3. PROTOCOLO REVISAR ----
console.log('\n[3] PROTOCOLO INVALIDO -> protocolo_revisar/');
console.log(hr);
console.log(`    Eventos (alertas) de protocolo invalido: ${protRevEvents}`);
console.log(`    Midias salvas em protocolo_revisar:      ${protRevFilesTotal} arquivos`);
console.log('\n    Por AUTOR (eventos - 1 evento = 1 flush com protocolo invalido):');
sortedDesc(protRevByAuthor).forEach(([a, v]) =>
  console.log(`      ${String(v).padStart(4)}  ${a}`)
);
if (Object.keys(protRevFilesByAuthor).length > 0) {
  console.log('\n    Por AUTOR (midias em protocolo_revisar):');
  sortedDesc(protRevFilesByAuthor).forEach(([a, v]) =>
    console.log(`      ${String(v).padStart(4)}  ${a}`)
  );
}

// ---- 4. MULTIPLAS LEGENDAS ----
console.log('\n[4] MULTIPLAS LEGENDAS (buffer com varios protocolos ao mesmo tempo)');
console.log(hr);
console.log(`    Total de eventos: ${multEvents}`);
console.log('    (Midias ja contadas em [1] - aqui apenas o alerta de confusao de protocolo)');
console.log('\n    Por AUTOR (eventos - quantas vezes enviou midias com >1 protocolo):');
sortedDesc(multByAuthor).forEach(([a, v]) =>
  console.log(`      ${String(v).padStart(4)}  ${a}`)
);
console.log('\n    Por GRUPO:');
sortedDesc(multByGroup).forEach(([g, v]) =>
  console.log(`      ${String(v).padStart(4)}  ${g}`)
);

// ---- 5. ERROS ----
console.log('\n[5] ERROS AO SALVAR (arquivos definitivamente perdidos)');
console.log(hr);
console.log(`    Total de arquivos com erro: ${errTotal}`);
console.log('\n    Por AUTOR:');
sortedDesc(errByAuthor, 'total').forEach(([a, v]) => {
  console.log(`      ${String(v.total).padStart(4)}  ${a}`);
  const reasons = Object.entries(v.reasons).sort((a,b) => b[1]-a[1]);
  for (const [r, c] of reasons) {
    const shortR = r.length > 60 ? r.substring(0,57)+'...' : r;
    console.log(`             (${c}x) ${shortR}`);
  }
});
console.log('\n    Por GRUPO:');
sortedDesc(errByGroup).forEach(([g, v]) =>
  console.log(`      ${String(v).padStart(4)}  ${g}`)
);

// ---- DAILY BREAKDOWN ----
console.log('\n[6] DETALHAMENTO DIARIO');
console.log(hr);
const sortedDays = Object.entries(daily).sort((a, b) => {
  const [da,ma,ya] = a[0].split('/');
  const [db,mb,yb] = b[0].split('/');
  return new Date(ya,ma-1,da) - new Date(yb,mb-1,db);
});

console.log('\nDATA          SALVO  SEM_LEG  PROT_REV  MULTIPLAS  ERROS');
console.log('-'.repeat(60));
let ts=0, tsl=0, tpr=0, tm=0, te=0;
for (const [date, d] of sortedDays) {
  const salvo  = d.salvo   || 0;
  const semleg = d.semLeg  || 0;
  const prev   = d.protRev || 0;
  const mult   = d.mult    || 0;
  const erros  = d.erros   || 0;
  if (salvo + semleg + prev + mult + erros === 0) continue;
  console.log(
    `${date}  ${String(salvo).padStart(5)}  ${String(semleg).padStart(7)}  ` +
    `${String(prev).padStart(8)}  ${String(mult).padStart(9)}  ${String(erros).padStart(5)}`
  );
  ts+=salvo; tsl+=semleg; tpr+=prev; tm+=mult; te+=erros;
}
console.log('-'.repeat(60));
console.log(
  `TOTAL         ${String(ts).padStart(5)}  ${String(tsl).padStart(7)}  ` +
  `${String(tpr).padStart(8)}  ${String(tm).padStart(9)}  ${String(te).padStart(5)}`
);

// ---- EXECUTIVE SUMMARY ----
console.log('\n' + HR);
console.log('  RESUMO EXECUTIVO');
console.log(HR);
const grandTotal = salvoTotal + semLegTotal + errTotal;
const pctSalvo   = ((salvoTotal / grandTotal) * 100).toFixed(1);
const pctSemLeg  = ((semLegTotal / grandTotal) * 100).toFixed(1);
const pctErros   = ((errTotal / grandTotal) * 100).toFixed(1);

console.log(`  Salvos com protocolo valido:      ${String(salvoTotal).padStart(5)} midias  (${pctSalvo}%)`);
console.log(`  Sem legenda -> sem_legenda/:       ${String(semLegTotal).padStart(5)} midias  (${pctSemLeg}%)`);
console.log(`  Erros (arquivos NAO salvos):       ${String(errTotal).padStart(5)} arquivos (${pctErros}%)`);
console.log(`  Protocolo invalido -> revisar/:    ${String(protRevFilesTotal).padStart(5)} midias  (eventos: ${protRevEvents})`);
console.log(`  Eventos multiplas legendas:        ${String(multEvents).padStart(5)} eventos`);
console.log(`  ` + '-'.repeat(50));
console.log(`  TOTAL RASTREADO (salvo+semleg+err):${String(grandTotal).padStart(5)}`);
console.log(HR);

console.log('\n  DESTAQUE: TOP 5 - MAIS MIDIAS SEM LEGENDA (sem_legenda/)');
console.log(hr);
sortedDesc(semLegByAuthor).slice(0,5).forEach(([a, v], i) => {
  const pct = ((v / semLegTotal) * 100).toFixed(1);
  console.log(`    ${i+1}. ${a}: ${v} midias (${pct}% do total sem legenda)`);
});

console.log('\n  DESTAQUE: TOP 5 - MAIS MIDIAS COM PROTOCOLO VALIDO');
console.log(hr);
sortedDesc(salvoByAuthor).slice(0,5).forEach(([a, v], i) => {
  const pct = ((v / salvoTotal) * 100).toFixed(1);
  console.log(`    ${i+1}. ${a}: ${v} midias (${pct}% do total)`);
});

console.log('\n  DESTAQUE: TOP 5 - MAIS MULTIPLAS LEGENDAS (confusao de protocolo)');
console.log(hr);
sortedDesc(multByAuthor).slice(0,5).forEach(([a, v], i) => {
  console.log(`    ${i+1}. ${a}: ${v} eventos`);
});

console.log('\n  ERROS POR TIPO (causa raiz):');
console.log(hr);
const allReasons = {};
for (const [, v] of Object.entries(errByAuthor)) {
  for (const [r, c] of Object.entries(v.reasons)) {
    const cat = r.includes('arquivo temp') ? 'arquivo temp nao encontrado (crash do buffer)' : r;
    allReasons[cat] = (allReasons[cat] || 0) + c;
  }
}
for (const [r, c] of Object.entries(allReasons).sort((a,b) => b[1]-a[1])) {
  console.log(`    ${String(c).padStart(3)}x  ${r}`);
}

console.log('\n' + HR);
