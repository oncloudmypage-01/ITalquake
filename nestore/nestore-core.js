/*
 * nestore-core.js — porting JavaScript del metodo NESTORE
 * (NExt STrOng Related Earthquake) per ITalquake.
 *
 * Metodo e codice originale (MATLAB, GPL v3):
 *   S. Gentili, P. Brondi, R. Di Giovambattista (2023),
 *   "NESTOREv1.0: A MATLAB Package for Strong Forthcoming Earthquake
 *   Forecasting", Seismological Research Letters, doi:10.1785/0220220327
 *   https://github.com/StefaniaGentili/NESTORE  (Zenodo 10.5281/zenodo.7472134)
 *
 * Questo file è un'opera derivata, distribuita sotto GNU GPL v3 o successiva.
 * Copyright (C) 2026 ITalquake. Vedi LICENSE.
 *
 * Funziona sia nel browser (window.NESTORE) sia in Node (module.exports).
 * Tempi in giorni dal terremoto principale, magnitudo in decimi interi
 * (es. 4.3 -> 43) per evitare errori di arrotondamento nei confronti.
 */
(function (root) {
  'use strict';

  var FEATURES = ['S', 'Z', 'SLcum', 'QLcum', 'SLcum2', 'QLcum2', 'Q', 'Vm', 'N2'];
  var TD = [0.25, 0.5, 0.75, 1, 2, 3, 4, 5, 6, 7];

  // Finestre di selezione (file di esempio NESTORE), con raggio minimo
  // per tenere conto dell'errore di localizzazione del catalogo INGV.
  var CFG = {
    ThM: 4.0,          // magnitudo minima del terremoto principale
    Thwt: 6.5,         // cambio della formula della durata
    Rmin: 5,           // km, raggio minimo (adattamento per l'Italia)
    Zth: 30,           // km, profondità massima del principale
    six: 0.25          // 6 ore in giorni
  };

  function winSpace(M) { return Math.max(0.02 * Math.pow(10, M / 2), CFG.Rmin); }
  function winTime(M) {
    return M < CFG.Thwt ? Math.pow(10, 0.5409 * M - 0.547) : Math.pow(10, 0.032 * M + 2.7389);
  }

  var D2R = Math.PI / 180;
  function distKm(la1, lo1, la2, lo2) {
    var dla = (la2 - la1) * D2R, dlo = (lo2 - lo1) * D2R;
    var a = Math.sin(dla / 2) * Math.sin(dla / 2) +
      Math.cos(la1 * D2R) * Math.cos(la2 * D2R) * Math.sin(dlo / 2) * Math.sin(dlo / 2);
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // Area: Italia e mari vicini (esclude Balcani, Grecia, Nord Africa).
  var AREA = [
    [7.5, 43.7], [6.6, 44.3], [6.8, 45.2], [6.9, 46.0], [8.4, 46.5], [10.4, 46.6],
    [12.2, 47.1], [13.7, 46.6], [13.95, 45.6], [13.2, 44.9], [14.0, 44.2], [15.7, 42.9],
    [17.2, 42.0], [18.9, 40.4], [18.8, 39.4], [17.5, 38.6], [16.3, 37.3], [15.4, 36.3],
    [14.0, 36.4], [12.0, 36.4], [11.6, 37.6], [10.6, 38.6], [8.6, 38.6], [7.8, 39.5],
    [7.8, 41.5], [9.6, 42.0], [10.4, 43.0], [8.8, 43.7], [7.5, 43.7]
  ];
  function inArea(lon, lat) {
    var ins = false;
    for (var i = 0, j = AREA.length - 1; i < AREA.length; j = i++) {
      var xi = AREA[i][0], yi = AREA[i][1], xj = AREA[j][0], yj = AREA[j][1];
      if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) ins = !ins;
    }
    return ins;
  }

  /*
   * Caratteristiche della sequenza (feacalc_nostop_ti.m).
   * main: {m10}; afts: repliche ordinate nel tempo [{t (giorni), m10, lat, lon}]
   * (tutte le repliche: qui si tengono solo quelle con M >= Mm-3).
   * tEnd: fine dell'intervallo di osservazione in giorni.
   * Restituisce un oggetto con le 9 caratteristiche (NaN se non calcolabile).
   */
  function features(main, afts, tEnd) {
    var Mm10 = main.m10, Mm = Mm10 / 10;
    var a = afts.filter(function (e) { return e.m10 >= Mm10 - 30; });
    var s1 = 60 / 86400, s2 = tEnd, six = CFG.six;
    var big = a.filter(function (e) { return e.t >= s1 && e.t <= s2 && e.m10 >= Mm10 - 20; });
    var f = {};
    var i, j, sum;

    // S: energia (proxy) delle repliche forti, normalizzata
    sum = 0; for (i = 0; i < big.length; i++) sum += Math.pow(10, big[i].m10 / 10);
    f.S = sum / Math.pow(10, Mm);

    // Z: lunghezza media di rottura / distanza media tra le repliche
    if (big.length < 2) f.Z = 0;
    else {
      var Lm = 0; for (i = 0; i < big.length; i++) Lm += Math.pow(10, -3.22 + 0.69 * big[i].m10 / 10);
      Lm /= big.length;
      var R = 0, nR = 0;
      for (i = 0; i < big.length; i++) for (j = i + 1; j < big.length; j++) {
        R += distKm(big[i].lat, big[i].lon, big[j].lat, big[j].lon); nR++;
      }
      var Rm = R / nR; if (Rm === 0) Rm = 0.1;
      f.Z = Lm / Rm;
    }

    // Somme su (lo, hi] delle repliche con M >= Mm-2, con esponente k
    function sumPow(lo, hi, k) {
      var s = 0;
      for (var q = 0; q < a.length; q++) {
        var e = a[q];
        if (e.t > lo && e.t <= hi && e.m10 >= Mm10 - 20) s += Math.pow(10, k * e.m10 / 10);
      }
      return s;
    }
    // SLcum / QLcum: scarto cumulato dall'andamento di lungo periodo
    function cum(k) {
      var L = [], n = 1, sc1 = s1, sc3 = sc1 + six;
      while (sc3 <= s2) {
        var Nt = sumPow(s1, sc3, k), Ntms = sumPow(s1, sc1, k);
        var tmt0 = sc3 - s1, tmt0ms = tmt0 - six;
        L.push(tmt0ms > 0 ? Nt - Ntms * tmt0 / tmt0ms : Nt);
        n++; sc1 = s1 + n * six; sc3 = sc1 + six;
      }
      if (!L.length) return NaN;
      var s = 0; for (var q = 0; q < L.length; q++) s += Math.abs(L[q]);
      return s / Math.pow(10, Mm);
    }
    // SLcum2 / QLcum2: variante a finestra mobile
    function cum2(k, base) {
      var L = [], n = 1, sc1 = s1, sc2 = s1, sc3 = sc1 + six;
      while (sc3 <= s2) {
        var Nt = sumPow(sc2, sc3, k), Ntms = sumPow(sc2, sc1, k);
        var tmt0 = sc3 - sc2, tmt0ms = sc1 - sc2;
        L.push(tmt0ms > 0 ? Nt - Ntms * tmt0 / tmt0ms : Nt);
        n++; sc1 = base + 1 / 24 + (n - 1) * six; sc2 = s1 + (n - 1) * six; sc3 = sc2 + six;
      }
      if (!L.length || tEnd <= 0.5) return NaN;
      var s = 0; for (var q = 0; q < L.length; q++) s += Math.abs(L[q]);
      return s / Math.pow(10, Mm);
    }
    f.SLcum = cum(1);
    f.QLcum = cum(1.5);
    f.SLcum2 = cum2(1, s1);
    f.QLcum2 = cum2(1.5, 0);

    // Q: momento sismico (proxy) normalizzato
    sum = 0; for (i = 0; i < big.length; i++) sum += Math.pow(10, 1.5 * big[i].m10 / 10);
    f.Q = big.length ? sum / Math.pow(10, 1.5 * Mm) : 0;

    // Vm: variazione di magnitudo tra repliche consecutive
    sum = 0; for (i = 1; i < big.length; i++) sum += Math.abs(big[i].m10 - big[i - 1].m10) / 10;
    f.Vm = sum;

    // N2: numero di repliche con M >= Mm-2
    f.N2 = big.length;
    return f;
  }

  // Valore della caratteristica k all'intervallo td, con il "buon intervallo"
  // di addestramento: NaN prima dell'inizio, congelata dopo il massimo.
  function featureAt(main, afts, td, range, cache) {
    var out = {};
    FEATURES.forEach(function (k) {
      var r = range[k];
      if (!r || r[0] == null || td < r[0] - 1e-9) { out[k] = NaN; return; }
      var tEff = Math.min(td, r[1]);
      var key = tEff.toFixed(4);
      if (!cache[key]) cache[key] = features(main, afts, tEff);
      out[k] = cache[key][k];
    });
    return out;
  }

  // Albero decisionale a un nodo (fitctree 'MaxNumSplits',1, criterio di Gini)
  function stump(x, y) {
    // x: numeri, y: 1 = A, 0 = B. Restituisce {cut, left, right} o {cut:NaN, cls}
    var n = x.length, nA = 0, i;
    for (i = 0; i < n; i++) nA += y[i];
    var major = nA >= n - nA ? 1 : 0;
    if (n < 10 || nA === 0 || nA === n) return { cut: NaN, cls: major };
    var idx = x.map(function (_, q) { return q; }).sort(function (p, q) { return x[p] - x[q]; });
    var gini = function (a, t) { if (!t) return 0; var p = a / t; return 2 * p * (1 - p); };
    var parent = gini(nA, n), best = 0, bestK = -1, lA = 0;
    for (i = 0; i < n - 1; i++) {
      lA += y[idx[i]];
      if (x[idx[i]] === x[idx[i + 1]]) continue;
      var nl = i + 1, nr = n - nl;
      var g = parent - (nl / n) * gini(lA, nl) - (nr / n) * gini(nA - lA, nr);
      if (g > best + 1e-12) { best = g; bestK = i; }
    }
    if (bestK < 0) return { cut: NaN, cls: major };
    var cut = (x[idx[bestK]] + x[idx[bestK + 1]]) / 2;
    var la = 0, ln = 0, ra = 0, rn = 0;
    for (i = 0; i < n; i++) { if (x[i] < cut) { ln++; la += y[i]; } else { rn++; ra += y[i]; } }
    return { cut: cut, left: la >= ln - la ? 1 : 0, right: ra >= rn - ra ? 1 : 0 };
  }
  function stumpPredict(s, v) {
    if (isNaN(s.cut)) return s.cls;
    return v < s.cut ? s.left : s.right;
  }

  // Combinazione bayesiana (class_stop_comb_bayes.m, Bailer-Jones & Smith 2011)
  function bayes(p, na, nb) {
    var n = p.length, pp = Math.pow(nb, n - 1), np = Math.pow(na, n - 1);
    for (var i = 0; i < n; i++) { pp *= p[i]; np *= (1 - p[i]); }
    var tot = pp + np;
    if (tot > 0) return pp / tot;
    var s = p.slice().sort(function (a, b) { return a - b; }), h = Math.floor(n / 2);
    return n % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
  }

  /*
   * Classificazione in tempo quasi reale (nrt_class_stop.m).
   * model: JSON prodotto da tools/nestore_train.mjs
   * main: {m10, t:0}; afts: repliche note; elapsed: giorni trascorsi.
   * Restituisce un elenco, per ogni intervallo già trascorso, con P(A).
   */
  function classify(model, main, afts, elapsed) {
    var res = [], cache = {};
    model.td.forEach(function (td, i) {
      if (td > elapsed + 1e-9) return;
      var fv = featureAt(main, afts, td, model.range, cache);
      var P = [], used = [];
      FEATURES.forEach(function (k, j) {
        var th = model.th[i][j];
        if (th == null || isNaN(th)) return;
        var v = fv[k];
        if (v == null || isNaN(v)) return;
        var above = v >= th;
        var p = above ? model.pMore[i][j] : model.pLess[i][j];
        if (p == null || isNaN(p)) return;
        P.push(p); used.push({ f: k, v: v, th: th, above: above, p: p });
      });
      var pc = P.length ? bayes(P, model.nA[i], model.nB[i]) : NaN;
      res.push({ td: td, pc: pc, used: used });
    });
    return res;
  }

  var api = {
    FEATURES: FEATURES, TD: TD, CFG: CFG, AREA: AREA,
    winSpace: winSpace, winTime: winTime, distKm: distKm, inArea: inArea,
    features: features, featureAt: featureAt, stump: stump, stumpPredict: stumpPredict,
    bayes: bayes, classify: classify
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NESTORE = api;
})(typeof self !== 'undefined' ? self : this);
