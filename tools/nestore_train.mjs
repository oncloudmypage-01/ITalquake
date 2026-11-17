#!/usr/bin/env node
/*
 * Addestramento di NESTORE sul catalogo INGV (porting di run_training.m).
 * Copyright (C) 2026 ITalquake — GNU GPL v3 o successiva.
 * Metodo: Gentili, Brondi, Di Giovambattista (2023), SRL, doi:10.1785/0220220327
 *
 * Uso:  node tools/nestore_train.mjs [catalogo.json]
 *   senza argomenti scarica il catalogo da webservices.ingv.it
 *   e scrive nestore/model_italia.json e nestore/report_italia.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const N = require('../nestore/nestore-core.js');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT_MODEL = path.join(ROOT, 'nestore', 'model_italia.json');
const OUT_REPORT = path.join(ROOT, 'nestore', 'report_italia.md');
const OUT_CLUSTERS = path.join(ROOT, 'nestore', 'clusters_italia.json');
const CACHE = process.env.NESTORE_CACHE || path.join(ROOT, 'nestore', '.catalog-cache.json');

const CONF = {
  start: 1990, yearchMc: 2005, Mc1: 2.8, Mc2: 2.0,
  minMagOld: 2.0, minMagNew: 1.5,
  box: { minlat: 35, maxlat: 48, minlon: 5, maxlon: 20, maxdepth: 70 },
  labelLagDays: 200   // i principali più recenti non hanno ancora un esito certo
};

// ---------------------------------------------------------------- catalogo
async function fetchChunk(t1, t2, minmag, tries = 4) {
  const b = CONF.box;
  const url = 'https://webservices.ingv.it/fdsnws/event/1/query?format=text&orderby=time-asc' +
    `&starttime=${t1}&endtime=${t2}&minmag=${minmag}&minlat=${b.minlat}&maxlat=${b.maxlat}` +
    `&minlon=${b.minlon}&maxlon=${b.maxlon}&maxdepth=${b.maxdepth}`;
  for (let k = 0; k < tries; k++) {
    try {
      const r = await fetch(url);
      if (r.status === 204) return [];
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const txt = await r.text();
      const out = [];
      for (const line of txt.split('\n')) {
        if (!line || line[0] === '#') continue;
        const c = line.split('|');
        const m = parseFloat(c[10]);
        if (!isFinite(m)) continue;
        out.push({ id: c[0], time: Date.parse(c[1].endsWith('Z') ? c[1] : c[1] + 'Z'),
          lat: +c[2], lon: +c[3], dep: +c[4], m10: Math.round(m * 10) });
      }
      return out;
    } catch (e) {
      if (k === tries - 1) throw new Error(`${t1}..${t2}: ${e.message}`);
      await new Promise(r => setTimeout(r, 2000 * (k + 1)));
    }
  }
}

async function downloadCatalog() {
  const chunks = [];
  const now = new Date();
  for (let y = CONF.start; y <= now.getUTCFullYear(); y++) {
    for (let mo = 0; mo < 12; mo++) for (const half of [0, 1]) {
      const a = new Date(Date.UTC(y, mo, half ? 16 : 1));
      const b = half ? new Date(Date.UTC(y, mo + 1, 1)) : new Date(Date.UTC(y, mo, 16));
      if (a > now) continue;
      chunks.push([a.toISOString().slice(0, 19), b.toISOString().slice(0, 19),
        y < CONF.yearchMc ? CONF.minMagOld : CONF.minMagNew]);
    }
  }
  const res = new Array(chunks.length);
  let next = 0, done = 0;
  async function worker() {
    while (next < chunks.length) {
      const i = next++;
      res[i] = await fetchChunk(...chunks[i]);
      if (++done % 50 === 0) console.log(`  scaricati ${done}/${chunks.length} blocchi`);
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  const all = res.flat();
  const seen = new Set();
  const cat = all.filter(e => (seen.has(e.id) ? false : seen.add(e.id)))
    .sort((p, q) => p.time - q.time);
  return cat;
}

// ------------------------------------------------- identificazione cluster
// Porting di clus_ident_calc.m (finestre spazio-tempo, crescita iterativa)
function identifyClusters(cat) {
  const n = cat.length, DAY = 86400000;
  const t = cat.map(e => e.time / DAY);
  const vCl = new Int32Array(n);
  let nCount = 0;
  const lowerBound = (x) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] < x) lo = m + 1; else hi = m; } return lo; };
  const select = (c, onlyFree) => {
    const M = cat[c].m10 / 10, R = N.winSpace(M), T = N.winTime(M);
    const out = [];
    for (let i = lowerBound(t[c]); i < n && t[i] - t[c] <= T; i++) {
      if (onlyFree && vCl[i] !== 0) continue;
      if (N.distKm(cat[c].lat, cat[c].lon, cat[i].lat, cat[i].lon) <= R) out.push(i);
    }
    return out;
  };
  for (let ev = 0; ev < n; ev++) {
    if (vCl[ev] !== 0 || cat[ev].m10 < N.CFG.ThM * 10) continue;
    let sel = new Set(select(ev, false));
    let tmp = [...sel];
    if (tmp.length > 1) {
      let fMag = cat[ev].m10;
      let maxM = Math.max(...tmp.map(i => cat[i].m10));
      let iMax = Math.min(...tmp.filter(i => cat[i].m10 === maxM));
      while (maxM - fMag > 0) {
        tmp = select(iMax, true);
        tmp.forEach(i => sel.add(i));
        if (!tmp.length) break;
        fMag = maxM;
        maxM = Math.max(...tmp.map(i => cat[i].m10));
        iMax = Math.min(...tmp.filter(i => cat[i].m10 === maxM));
        if (maxM - fMag === 0) break;
      }
      nCount++;
      const idx = [...sel];
      if (idx.length > 1) idx.forEach(i => { if (vCl[i] === 0) vCl[i] = nCount; });
      let cnt = 0, last = -1;
      for (const i of idx) if (vCl[i] === nCount) { cnt++; last = i; }
      if (cnt === 1) { vCl[last] = 0; nCount--; }
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) if (vCl[i]) {
    if (!groups.has(vCl[i])) groups.set(vCl[i], []);
    groups.get(vCl[i]).push(i);
  }
  return [...groups.values()];
}

// Porting di clus_ident.m: principale, repliche, tipo A/B, Mc
function buildCluster(cat, u) {
  const DAY = 86400000, thm = N.CFG.ThM * 10;
  let v = u.map((g, k) => k).filter(k => cat[u[k]].m10 >= thm);
  if (!v.length) return null;
  let iv = v[0];
  if (v.length > 1) {
    const ms = Math.max(...v.map(k => cat[u[k]].m10));
    const uu = v.find(k => cat[u[k]].m10 === ms);
    if (uu !== v[0] && (cat[u[uu]].time - cat[u[v[0]]].time) / 3600000 < 6) iv = uu;
  }
  const m = cat[u[iv]];
  const afts = u.slice(iv + 1).map(i => ({ t: (cat[i].time - m.time) / DAY, m10: cat[i].m10, lat: cat[i].lat, lon: cat[i].lon }));
  if (!afts.length) return null;
  const ma = Math.max(...afts.map(e => e.m10));
  const strongest = afts.find(e => e.m10 === ma);
  const typeA = ma >= m.m10 - 10;
  const first = afts.find(e => e.m10 >= m.m10 - 10);
  const year = new Date(m.time).getUTCFullYear();
  let Mc10;
  if (afts.length >= 80) {
    const h = new Map(); afts.forEach(e => h.set(e.m10, (h.get(e.m10) || 0) + 1));
    let best = -1, bm = 0;
    for (const [k, c] of h) if (c > best || (c === best && k > bm)) { best = c; bm = k; }
    Mc10 = bm + 2;
  } else Mc10 = Math.round(10 * (year < CONF.yearchMc ? CONF.Mc1 : CONF.Mc2));
  return {
    id: m.id, time: m.time, year, lat: m.lat, lon: m.lon, dep: m.dep, m10: m.m10,
    afts, Naft: afts.length, maft10: ma, dt: strongest.t, typeA,
    Tmax: first ? first.t : strongest.t, Mc10,
    has3: afts.some(e => e.m10 >= m.m10 - 30)
  };
}

// Selezione (feacalc_nostop_ti.m, label 2) per l'intervallo td
function reject(c, td, lastTime) {
  if (!N.inArea(c.lon, c.lat)) return 'fuori area';
  if (!(c.dep <= N.CFG.Zth)) return 'profondo';
  if (c.year < CONF.start || c.time > lastTime) return 'periodo';
  if (!(c.m10 - c.Mc10 >= 20)) return 'Mc';
  if (!c.has3) return 'senza repliche';
  const dm = c.m10 - c.maft10;
  if (dm >= 8 && dm <= 12) return 'dm 0.8-1.2';
  if (c.typeA && !(c.Tmax > td)) return 'A già avvenuto';
  return null;
}
const selected = (c, td, lastTime) => !reject(c, td, lastTime);

// --------------------------------------------------------- prestazioni LOO
function loo(x, y) {
  let TP = 0, TN = 0, FP = 0, FN = 0;
  for (let i = 0; i < x.length; i++) {
    const X = x.filter((_, k) => k !== i), Y = y.filter((_, k) => k !== i);
    let pred;
    if (Math.max(...X) === Math.min(...X)) pred = 0;
    else pred = N.stumpPredict(N.stump(X, Y), x[i]);
    if (y[i] && pred) TP++; else if (!y[i] && !pred) TN++; else if (!y[i] && pred) FP++; else FN++;
  }
  const pre = TP / (TP + FP), re = TP / (TP + FN), acc = (TP + TN) / x.length;
  const inf = TP / (TP + FN) + TN / (TN + FP) - 1;
  return { TP, FP, FN, TN, pre, re, acc, inf };
}
const isNum = v => typeof v === 'number' && !isNaN(v);
const r6 = v => (isNum(v) ? Math.round(v * 1e6) / 1e6 : null);

// ------------------------------------------------------------------- main
async function main() {
  let cat, clusters;
  const arg = process.argv[2];
  if (arg === '--clusters') {
    // riaddestramento veloce dall'elenco delle sequenze già estratte
    const d = JSON.parse(fs.readFileSync(process.argv[3] || OUT_CLUSTERS, 'utf8'));
    clusters = d.clusters.map(c => ({ ...c, afts: c.afts.map(([t, m10, lat, lon]) => ({ t, m10, lat, lon })) }));
    cat = { length: d.catalogEvents };
  } else if (arg) cat = JSON.parse(fs.readFileSync(arg, 'utf8'));
  else if (fs.existsSync(CACHE) && process.env.NESTORE_USE_CACHE) cat = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  else {
    console.log('Scarico il catalogo INGV…');
    cat = await downloadCatalog();
    if (process.env.NESTORE_USE_CACHE) fs.writeFileSync(CACHE, JSON.stringify(cat));
  }
  console.log(`Catalogo: ${cat.length} eventi`);
  const lastTime = Date.now() - CONF.labelLagDays * 86400000;

  if (!clusters) {
    console.log(`Eventi M>=4: ${cat.filter(e => e.m10 >= 40).length}, di cui superficiali in area: ${cat.filter(e => e.m10 >= 40 && e.dep <= N.CFG.Zth && N.inArea(e.lon, e.lat)).length}`);
    const groups = identifyClusters(cat);
    clusters = groups.map(u => buildCluster(cat, u)).filter(Boolean);
    // elenco compatto delle sequenze (repliche dei primi 7,1 giorni, M >= Mm-3)
    fs.mkdirSync(path.dirname(OUT_CLUSTERS), { recursive: true });
    fs.writeFileSync(OUT_CLUSTERS, JSON.stringify({ catalogEvents: cat.length, clusters: clusters.map(c => ({
      ...c, afts: c.afts.filter(e => e.t <= 7.1 && e.m10 >= c.m10 - 30).map(e => [Math.round(e.t * 1e6) / 1e6, e.m10, e.lat, e.lon]) })) }));
  }
  console.log(`Cluster con M>=${N.CFG.ThM}: ${clusters.length}`);
  // diagnostica dei filtri a 6 ore
  const why = {};
  clusters.forEach(c => { const r = reject(c, 0.25, lastTime); why[r || 'ok'] = (why[r || 'ok'] || 0) + 1; });
  console.log('Selezione a 6 ore:', JSON.stringify(why));

  const F = N.FEATURES, TDall = N.TD;
  // 1) caratteristiche per ogni intervallo (nostop)
  const sets = TDall.map(td => {
    const cl = clusters.filter(c => selected(c, td, lastTime));
    return { td, cl, y: cl.map(c => (c.typeA ? 1 : 0)), f: cl.map(c => N.features(c, c.afts, td)) };
  });
  // 2) check_T_clus
  const S = sets.filter(s => s.cl.length >= 9 && s.y.reduce((a, b) => a + b, 0) >= 2);
  const td = S.map(s => s.td);
  console.log('Intervalli usati:', td.join(', '));
  // 3) prestazioni LOO per caratteristica e intervallo
  const perf = S.map(s => {
    const out = { constant: loo(s.y.map(() => 0), s.y) };
    F.forEach(k => {
      const x = s.f.map(f => f[k]);
      out[k] = x.some(v => !isNum(v)) ? null : loo(x, s.y);
    });
    return out;
  });
  // 4) buon intervallo (showperf_th05_nostop.m)
  const range = {};
  F.forEach(k => {
    const u = [];
    S.forEach((s, i) => {
      const p = perf[i][k];
      if (p && p.pre > 0.5 && p.re > 0.5 && p.acc > 0.5 && p.inf > 0 && p.acc >= perf[i].constant.acc) u.push(i);
    });
    if (!u.length) { range[k] = null; return; }
    const infs = u.map(i => perf[i][k].inf), mx = Math.max(...infs);
    const I = infs.indexOf(mx);
    const int = u.slice(0, I + 1);
    let endInt = int[int.length - 1];
    if (int[int.length - 1] < u[u.length - 1]) {
      const du = u.slice(I).map((v, q, arr) => (q ? v - arr[q - 1] : null)).slice(1);
      let l = 1;
      while (l <= du.length && du[l - 1] < 2) { endInt = int[int.length - 1] + l; l++; }
    }
    range[k] = [td[int[0]], td[int[int.length - 1]], td[endInt]];
  });
  // 5) ricostruzione con il buon intervallo (rebuild_feafile_stop.m)
  const R = S.map(s => {
    const f = s.cl.map(c => N.featureAt(c, c.afts, s.td, range, {}));
    return { ...s, f };
  });
  // 6-7) prestazioni LOO nel buon intervallo e ROC
  const FPR = [], TPR = [];
  R.forEach(s => {
    const fp = [], tp = [];
    F.forEach(k => {
      const x = s.f.map(f => f[k]);
      if (x.some(v => !isNum(v))) { fp.push(NaN); tp.push(NaN); return; }
      const p = loo(x, s.y);
      fp.push(p.FP / (p.FP + p.TN)); tp.push(p.TP / (p.TP + p.FN));
    });
    FPR.push(fp); TPR.push(tp);
  });
  // 8) soglie (thresfinder.m)
  const B = R.map(s => F.map(k => {
    const x = s.f.map(f => f[k]);
    if (x.some(v => !isNum(v))) return NaN;
    return N.stump(x, s.y).cut;
  }));
  const TH = R.map(() => F.map(() => NaN));
  F.forEach((k, j) => {
    const r = range[k];
    const indEnd = r ? td.indexOf(r[1]) : -1;
    const th = B.map(row => row[j]);
    if (indEnd >= 0) for (let q = indEnd + 1; q < th.length; q++) th[q] = B[indEnd][j];
    for (let q = 0; q < th.length; q++) if (FPR[q][j] > TPR[q][j]) th[q] = NaN;
    const first = th.findIndex(isNum);
    if (first >= 0 && indEnd - first >= 1) {
      for (let q = indEnd; q >= first + 1; q--) if (th[q - 1] > th[q]) th[q - 1] = th[q];
    }
    th.forEach((v, q) => { TH[q][j] = v; });
  });
  // 9) probabilità sopra/sotto soglia (calcprobA_th05.m)
  const pLess = R.map(() => F.map(() => NaN)), pMore = R.map(() => F.map(() => NaN));
  const nA = [], nB = [];
  R.forEach((s, i) => {
    const a = s.y.reduce((p, q) => p + q, 0);
    nA.push(a); nB.push(s.y.length - a);
    F.forEach((k, j) => {
      const th = TH[i][j];
      if (!isNum(th)) return;
      let lt = 0, la = 0, mt = 0, mA = 0;
      s.f.forEach((f, c) => {
        const v = f[k];
        if (!isNum(v)) return;
        if (v < th) { lt++; la += s.y[c]; } else { mt++; mA += s.y[c]; }
      });
      const pl = la / lt, pm = mA / mt;
      if (pm <= 0.5) { TH[i][j] = NaN; return; }
      pLess[i][j] = pl; pMore[i][j] = pm;
    });
  });
  // 10) verifica: classificazione LOO completa (stima di affidabilità)
  const model = {
    name: 'NESTORE Italia (INGV)', version: 1,
    trainedAt: new Date().toISOString(),
    method: 'NESTORE — Gentili, Brondi, Di Giovambattista (2023), SRL, doi:10.1785/0220220327',
    config: { ...N.CFG, catalogStart: CONF.start, yearchMc: CONF.yearchMc, Mc1: CONF.Mc1, Mc2: CONF.Mc2,
      minMag: [CONF.minMagOld, CONF.minMagNew], catalogEvents: cat.length,
      lastMainshock: new Date(lastTime).toISOString().slice(0, 10) },
    features: F, td, range,
    th: TH.map(r => r.map(r6)), pLess: pLess.map(r => r.map(r6)), pMore: pMore.map(r => r.map(r6)),
    nA, nB,
    perf: td.map((d, i) => {
      const o = {};
      F.forEach(k => { const p = perf[i][k]; o[k] = p ? { pre: r6(p.pre), re: r6(p.re), acc: r6(p.acc), inf: r6(p.inf) } : null; });
      return o;
    })
  };
  // Prova sul campione di addestramento: quante sequenze vengono riconosciute
  const check = td.map((d, i) => {
    let TP = 0, TN = 0, FP = 0, FN = 0;
    R[i].cl.forEach(c => {
      const out = N.classify(model, c, c.afts, d).find(o => o.td === d);
      if (!out || !isNum(out.pc)) return;
      const pa = out.pc >= 0.5;
      if (c.typeA && pa) TP++; else if (!c.typeA && !pa) TN++; else if (!c.typeA && pa) FP++; else FN++;
    });
    return { td: d, TP, FP, FN, TN };
  });
  model.check = check;
  model.clusters = R[0] ? R[0].cl.map(c => ({ id: c.id, t: new Date(c.time).toISOString().slice(0, 16),
    m: c.m10 / 10, lat: c.lat, lon: c.lon, maft: c.maft10 / 10, dt: Math.round(c.dt * 100) / 100,
    A: c.typeA ? 1 : 0 })) : [];

  fs.mkdirSync(path.dirname(OUT_MODEL), { recursive: true });
  fs.writeFileSync(OUT_MODEL, JSON.stringify(model));

  let md = `# NESTORE Italia — rapporto di addestramento\n\n`;
  md += `Addestrato il ${model.trainedAt.slice(0, 10)} su ${cat.length} eventi INGV (dal ${CONF.start}).\n\n`;
  md += `Sequenze con M ≥ ${N.CFG.ThM}: ${clusters.length}. Intervalli: ${td.join(', ')} giorni.\n\n`;
  md += `| intervallo | sequenze | A | B | TP | FP | FN | TN |\n|---|---|---|---|---|---|---|---|\n`;
  td.forEach((d, i) => { const c = check[i]; md += `| ${d} g | ${nA[i] + nB[i]} | ${nA[i]} | ${nB[i]} | ${c.TP} | ${c.FP} | ${c.FN} | ${c.TN} |\n`; });
  md += `\n## Prestazioni LOO (precisione / richiamo / accuratezza / informedness)\n\n| caratteristica | ${td.map(d => d + ' g').join(' | ')} |\n|---|${td.map(() => '---').join('|')}|\n`;
  ['constant', ...F].forEach(k => { md += `| ${k} | ${td.map((d, i) => { const p = perf[i][k]; return p ? [p.pre, p.re, p.acc, p.inf].map(v => (isNum(v) ? v.toFixed(2) : '–')).join(' / ') : '—'; }).join(' | ')} |\n`; });
  md += `\n## Buon intervallo per caratteristica\n\n| caratteristica | inizio | max informedness | fine |\n|---|---|---|---|\n`;
  F.forEach(k => { const r = range[k]; md += `| ${k} | ${r ? r.join(' | ') : '— | — | —'} |\n`; });
  md += `\n## Soglie\n\n| caratteristica | ${td.map(d => d + ' g').join(' | ')} |\n|---|${td.map(() => '---').join('|')}|\n`;
  F.forEach((k, j) => { md += `| ${k} | ${td.map((d, i) => (isNum(TH[i][j]) ? TH[i][j].toPrecision(3) : '—')).join(' | ')} |\n`; });
  fs.writeFileSync(OUT_REPORT, md);
  console.log(md);
}

main().catch(e => { console.error(e); process.exit(1); });
