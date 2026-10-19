/*
 * مدل پیش‌بینی فوتبال بازی‌خوان
 *
 * ۱) Dixon-Coles: قدرت حمله/دفاع هر تیم + مزیت میزبانی با رگرسیون پواسون وزن‌دار
 *    (وزن زمانی نمایی، ترکیب گل واقعی و xG، و پیشینِ ridge برای تیم‌های کم‌داده/صعودکرده).
 *    ضریب rho برای اصلاح نتایج کم‌گل (۰-۰، ۱-۰، ۰-۱، ۱-۱).
 * ۲) ترکیب با بازار: احتمال ضمنی ضرایب (پس از حذف حاشیهٔ سود) با pooling لگاریتمی،
 *    سپس λ دو تیم طوری حل می‌شود که ماتریس نتایج با احتمال ترکیبی سازگار باشد.
 * ۳) حالت زنده: گل‌های باقی‌مانده با توزیع زمانی واقعی گل‌ها، کارت قرمز و وضعیت نتیجه.
 * ۴) بک‌تست walk-forward: مدل هر هفته فقط با داده‌های قبل از همان هفته آموزش می‌بیند.
 *
 * در مرورگر window.BetModel و در Node، module.exports را می‌سازد.
 */
(function (root) {
  'use strict';

  const DAY = 86400000;
  const MAX_GOALS = 10;

  const DEFAULTS = {
    xi: 0.002,         // نرخ زوال زمانی در روز (نیمه‌عمر ≈ ۳۵۰ روز)
    xgWeight: 0.4,     // سهم xG در هدف آموزش وقتی xG موجود است
    ridge: 6,          // قدرت پیشین روی حمله/دفاع (۱/σ²)
    promotedAtt: -0.18,
    promotedDef: 0.18,
    sweeps: 40,
    marketWeight: 0.85, // در مرورگر برای هر لیگ با بک‌تست دوباره تنظیم می‌شود
  };

  // ---------- ابزار ریاضی ----------
  function poissonVec(lambda, n) {
    const out = new Array(n + 1);
    out[0] = Math.exp(-lambda);
    for (let k = 1; k <= n; k++) out[k] = out[k - 1] * lambda / k;
    return out;
  }

  function tau(x, y, lh, la, rho) {
    if (x === 0 && y === 0) return 1 - lh * la * rho;
    if (x === 0 && y === 1) return 1 + lh * rho;
    if (x === 1 && y === 0) return 1 + la * rho;
    if (x === 1 && y === 1) return 1 - rho;
    return 1;
  }

  function scoreMatrix(lh, la, rho = 0, n = MAX_GOALS) {
    const ph = poissonVec(lh, n), pa = poissonVec(la, n);
    const m = [];
    let total = 0;
    for (let i = 0; i <= n; i++) {
      m.push(new Array(n + 1));
      for (let j = 0; j <= n; j++) {
        const v = Math.max(0, ph[i] * pa[j] * tau(i, j, lh, la, rho));
        m[i][j] = v;
        total += v;
      }
    }
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) m[i][j] /= total;
    return m;
  }

  /** همهٔ بازارها از روی ماتریس نتیجه. offset برای حالت زنده (گل‌های فعلی) است. */
  function markets(m, offset = [0, 0]) {
    const n = m.length - 1;
    let h = 0, d = 0, a = 0, btts = 0, xgH = 0, xgA = 0;
    const totals = new Array(2 * n + 1).fill(0);
    const scores = [];
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n; j++) {
        const p = m[i][j];
        const fh = i + offset[0], fa = j + offset[1];
        if (fh > fa) h += p; else if (fh === fa) d += p; else a += p;
        if (fh > 0 && fa > 0) btts += p;
        totals[Math.min(fh + fa, 2 * n)] += p;
        xgH += p * fh; xgA += p * fa;
        scores.push({ h: fh, a: fa, p });
      }
    }
    const over = line => totals.reduce((s, p, k) => s + (k > line ? p : 0), 0);
    scores.sort((x, y) => y.p - x.p);
    return {
      home: h, draw: d, away: a, btts,
      over15: over(1.5), over25: over(2.5), over35: over(3.5), over45: over(4.5),
      xgHome: xgH, xgAway: xgA, topScores: scores.slice(0, 6),
    };
  }

  // ---------- ضرایب بازار ----------
  /** حذف حاشیهٔ سود بنگاه با روش توان (منصفانه‌تر از نرمال‌سازی ساده برای favourite-longshot). */
  function devig(odds) {
    if (!odds || odds.some(o => !o || o <= 1)) return null;
    const inv = odds.map(o => 1 / o);
    let lo = 0.5, hi = 2;
    for (let it = 0; it < 60; it++) {
      const k = (lo + hi) / 2;
      const s = inv.reduce((t, p) => t + Math.pow(p, k), 0);
      if (s > 1) lo = k; else hi = k;
    }
    const k = (lo + hi) / 2;
    const p = inv.map(x => Math.pow(x, k));
    const s = p.reduce((t, x) => t + x, 0);
    return p.map(x => x / s);
  }

  function americanToDecimal(v) {
    const x = typeof v === 'string' ? parseFloat(v.replace('+', '')) : v;
    if (!isFinite(x) || x === 0) return null;
    return x > 0 ? 1 + x / 100 : 1 + 100 / -x;
  }

  /** pooling لگاریتمی: p ∝ model^(1-w) · market^w */
  function logPool(pModel, pMarket, w) {
    if (!pMarket) return pModel.slice();
    const q = pModel.map((p, i) => Math.pow(Math.max(p, 1e-9), 1 - w) * Math.pow(Math.max(pMarket[i], 1e-9), w));
    const s = q.reduce((a, b) => a + b, 0);
    return q.map(x => x / s);
  }

  /** λ‌هایی پیدا می‌کند که ماتریس Dixon-Coles با احتمال‌های هدف (۱X۲ و در صورت وجود بالای ۲.۵) جور شود. */
  function solveLambdas(target, init, rho) {
    const f = ([x, y]) => {
      const mk = markets(scoreMatrix(Math.exp(x), Math.exp(y), rho, 8));
      let e = (mk.home - target[0]) ** 2 + (mk.draw - target[1]) ** 2 + (mk.away - target[2]) ** 2;
      if (target[3] != null) e += 0.5 * (mk.over25 - target[3]) ** 2;
      return e;
    };
    // Nelder-Mead دوبعدی
    let s = [[Math.log(init[0]), Math.log(init[1])]];
    s.push([s[0][0] + 0.15, s[0][1]], [s[0][0], s[0][1] + 0.15]);
    let fs = s.map(f);
    for (let it = 0; it < 120; it++) {
      const idx = [0, 1, 2].sort((a, b) => fs[a] - fs[b]);
      s = idx.map(i => s[i]); fs = idx.map(i => fs[i]);
      if (fs[2] - fs[0] < 1e-12) break;
      const c = [(s[0][0] + s[1][0]) / 2, (s[0][1] + s[1][1]) / 2];
      const pt = k => [c[0] + k * (s[2][0] - c[0]), c[1] + k * (s[2][1] - c[1])];
      const r = pt(-1), fr = f(r);
      if (fr < fs[0]) {
        const e = pt(-2), fe = f(e);
        if (fe < fr) { s[2] = e; fs[2] = fe; } else { s[2] = r; fs[2] = fr; }
      } else if (fr < fs[1]) { s[2] = r; fs[2] = fr; }
      else {
        const k = pt(0.5), fk = f(k);
        if (fk < fs[2]) { s[2] = k; fs[2] = fk; }
        else { s[1] = [(s[0][0] + s[1][0]) / 2, (s[0][1] + s[1][1]) / 2]; s[2] = [(s[0][0] + s[2][0]) / 2, (s[0][1] + s[2][1]) / 2]; fs[1] = f(s[1]); fs[2] = f(s[2]); }
      }
    }
    return [Math.exp(s[0][0]), Math.exp(s[0][1])];
  }

  // ---------- آموزش Dixon-Coles ----------
  /**
   * matches: [{t, h, a, hg, ag, hxg, axg}]  (t = میلی‌ثانیهٔ تاریخ)
   * فقط بازی‌های قبل از asOf استفاده می‌شوند.
   */
  function fitRatings(matches, asOf, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const rows = [];
    const firstSeen = new Map();
    let tMin = Infinity;
    for (const m of matches) {
      if (m.t >= asOf) continue;
      const w = Math.exp(-o.xi * (asOf - m.t) / DAY);
      if (w < 1e-3) continue;
      const yh = m.hxg != null ? o.xgWeight * m.hxg + (1 - o.xgWeight) * m.hg : m.hg;
      const ya = m.axg != null ? o.xgWeight * m.axg + (1 - o.xgWeight) * m.ag : m.ag;
      rows.push({ h: m.h, a: m.a, w, yh, ya, hg: m.hg, ag: m.ag, lh: 1, la: 1 });
      tMin = Math.min(tMin, m.t);
      for (const id of [m.h, m.a]) firstSeen.set(id, Math.min(firstSeen.get(id) ?? Infinity, m.t));
    }
    const teams = [...firstSeen.keys()];
    const att = new Map(), def = new Map(), prior = new Map();
    for (const id of teams) {
      // تیمی که بیش از ۳۰۰ روز بعد از شروع داده‌ها ظاهر شده = صعودکرده
      const promoted = firstSeen.get(id) - tMin > 300 * DAY;
      prior.set(id, promoted ? [o.promotedAtt, o.promotedDef] : [0, 0]);
      att.set(id, prior.get(id)[0]); def.set(id, prior.get(id)[1]);
    }
    let mu = Math.log(1.3), home = 0.2;
    const refresh = () => {
      for (const r of rows) {
        r.lh = Math.exp(mu + home + att.get(r.h) + def.get(r.a));
        r.la = Math.exp(mu + att.get(r.a) + def.get(r.h));
      }
    };
    for (let sweep = 0; sweep < o.sweeps; sweep++) {
      refresh();
      let g = 0, H = 0;
      for (const r of rows) { g += r.w * (r.yh - r.lh + r.ya - r.la); H += r.w * (r.lh + r.la); }
      mu += g / H; refresh();
      g = 0; H = 0;
      for (const r of rows) { g += r.w * (r.yh - r.lh); H += r.w * r.lh; }
      home += g / H; refresh();
      // بلوک حمله: هسین قطری است، پس نیوتن بلوکی دقیق است
      const ga = new Map(teams.map(id => [id, [0, 0]]));
      for (const r of rows) {
        const x = ga.get(r.h); x[0] += r.w * (r.yh - r.lh); x[1] += r.w * r.lh;
        const y = ga.get(r.a); y[0] += r.w * (r.ya - r.la); y[1] += r.w * r.la;
      }
      for (const id of teams) {
        const [gg, hh] = ga.get(id), p = prior.get(id)[0], v = att.get(id);
        att.set(id, v + (gg - o.ridge * (v - p)) / (hh + o.ridge));
      }
      refresh();
      const gd = new Map(teams.map(id => [id, [0, 0]]));
      for (const r of rows) {
        const x = gd.get(r.a); x[0] += r.w * (r.yh - r.lh); x[1] += r.w * r.lh;
        const y = gd.get(r.h); y[0] += r.w * (r.ya - r.la); y[1] += r.w * r.la;
      }
      for (const id of teams) {
        const [gg, hh] = gd.get(id), p = prior.get(id)[1], v = def.get(id);
        def.set(id, v + (gg - o.ridge * (v - p)) / (hh + o.ridge));
      }
    }
    refresh();
    // rho با جست‌وجوی شبکه‌ای روی گل‌های واقعی
    let rho = 0, best = -Infinity;
    for (let r = -0.2; r <= 0.1001; r += 0.01) {
      let ll = 0;
      for (const x of rows) if (x.hg <= 1 && x.ag <= 1) ll += x.w * Math.log(Math.max(tau(x.hg, x.ag, x.lh, x.la, r), 1e-9));
      if (ll > best) { best = ll; rho = r; }
    }
    return { mu, home, att, def, rho, n: rows.length, asOf };
  }

  function expectedGoals(fit, h, a) {
    const ah = fit.att.get(h) ?? DEFAULTS.promotedAtt, dh = fit.def.get(h) ?? DEFAULTS.promotedDef;
    const aa = fit.att.get(a) ?? DEFAULTS.promotedAtt, da = fit.def.get(a) ?? DEFAULTS.promotedDef;
    return [Math.exp(fit.mu + fit.home + ah + da), Math.exp(fit.mu + aa + dh)];
  }

  /**
   * پیش‌بینی پیش از بازی.
   * odds: {h, d, a, over, under} ضرایب اعشاری (اختیاری)
   */
  function predict(fit, h, a, odds, opts = {}) {
    const w = opts.marketWeight ?? DEFAULTS.marketWeight;
    const [lh0, la0] = expectedGoals(fit, h, a);
    const model = markets(scoreMatrix(lh0, la0, fit.rho));
    const p1x2 = odds && devig([odds.h, odds.d, odds.a]);
    const pOU = odds && devig([odds.over, odds.under]);
    let lh = lh0, la = la0, source = 'model', blended = [model.home, model.draw, model.away];
    if (p1x2) {
      blended = logPool(blended, p1x2, w);
      const over = pOU ? logPool([model.over25, 1 - model.over25], pOU, w)[0] : null;
      [lh, la] = solveLambdas([...blended, over], [lh0, la0], fit.rho);
      source = 'blend';
    }
    const final = markets(scoreMatrix(lh, la, fit.rho));
    return {
      lh, la, rho: fit.rho, source, model, final,
      market: p1x2 ? { home: p1x2[0], draw: p1x2[1], away: p1x2[2], over25: pOU ? pOU[0] : null } : null,
    };
  }

  // ---------- حالت زنده ----------
  // سهم گل‌ها در بازه‌های ۱۵ دقیقه‌ای (شامل وقت‌های اضافه)؛ گل‌ها در اواخر بازی بیشترند.
  const GOAL_SHARE = [0.125, 0.15, 0.18, 0.16, 0.175, 0.21];
  function remainingShare(minute, period) {
    if (period >= 2 && minute < 45) minute = 45;
    if (period === 1 && minute > 45) minute = 45;
    const m = Math.max(0, Math.min(90, minute));
    let done = 0;
    for (let b = 0; b < 6; b++) {
      const start = b * 15;
      if (m >= start + 15) done += GOAL_SHARE[b];
      else if (m > start) done += GOAL_SHARE[b] * (m - start) / 15;
    }
    return Math.max(0.005, 1 - done);
  }

  /** state: {minute, period, hg, ag, redH, redA} */
  function livePredict(pre, state) {
    const share = remainingShare(state.minute, state.period);
    let rh = pre.lh * share, ra = pre.la * share;
    // کارت قرمز: تیم ده‌نفره حدود ۳۰٪ کمتر و حریف حدود ۲۵٪ بیشتر گل می‌زند
    rh *= Math.pow(0.7, state.redH || 0) * Math.pow(1.25, state.redA || 0);
    ra *= Math.pow(0.7, state.redA || 0) * Math.pow(1.25, state.redH || 0);
    // تیم عقب حمله می‌کند، تیم جلو محتاط‌تر بازی می‌کند
    const diff = state.hg - state.ag;
    if (diff > 0) { rh *= 0.9; ra *= 1.12; } else if (diff < 0) { rh *= 1.12; ra *= 0.9; }
    const m = scoreMatrix(rh, ra, 0);
    return { remaining: [rh, ra], share, final: markets(m, [state.hg, state.ag]) };
  }

  // ---------- بک‌تست ----------
  function outcomeIndex(m) { return m.hg > m.ag ? 0 : m.hg === m.ag ? 1 : 2; }

  function scoreProbs(p, y) {
    const brier = p.reduce((s, x, i) => s + (x - (i === y ? 1 : 0)) ** 2, 0);
    return { brier, logloss: -Math.log(Math.max(p[y], 1e-12)), hit: p.indexOf(Math.max(...p)) === y ? 1 : 0 };
  }

  /**
   * walk-forward: بازی‌های آخرِ `days` روز به هفته‌ها تقسیم می‌شوند؛ برای هر هفته مدل فقط با
   * داده‌های قبل از آن هفته آموزش می‌بیند.
   */
  function backtest(matches, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const days = o.days ?? 280, now = o.now ?? Math.max(...matches.map(m => m.t)) + DAY;
    const start = now - days * DAY;
    const weights = [0, 0.2, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
    const acc = { baseline: [], model: [], market: [] };
    const blendAcc = weights.map(() => []);
    const preds = [];
    for (let t = start; t < now; t += 7 * DAY) {
      const test = matches.filter(m => m.t >= t && m.t < t + 7 * DAY);
      if (!test.length) continue;
      const train = matches.filter(m => m.t < t);
      if (train.length < 150) continue;
      const fit = fitRatings(train, t, o);
      // خط پایه: فراوانی برد/مساوی/باخت میزبان در داده‌های آموزشی
      const base = [0, 0, 0];
      for (const m of train) base[outcomeIndex(m)]++;
      const baseP = base.map(x => x / train.length);
      for (const m of test) {
        const y = outcomeIndex(m);
        const [lh, la] = expectedGoals(fit, m.h, m.a);
        const mk = markets(scoreMatrix(lh, la, fit.rho));
        const pm = [mk.home, mk.draw, mk.away];
        const pk = m.odds && devig([m.odds.h, m.odds.d, m.odds.a]);
        acc.baseline.push(scoreProbs(baseP, y));
        acc.model.push(scoreProbs(pm, y));
        if (pk) {
          acc.market.push(scoreProbs(pk, y));
          weights.forEach((w, i) => blendAcc[i].push(scoreProbs(logPool(pm, pk, w), y)));
        }
        preds.push({ p: pm, pk, y });
      }
    }
    const summary = arr => arr.length ? {
      n: arr.length,
      brier: arr.reduce((s, x) => s + x.brier, 0) / arr.length,
      logloss: arr.reduce((s, x) => s + x.logloss, 0) / arr.length,
      accuracy: arr.reduce((s, x) => s + x.hit, 0) / arr.length,
    } : null;
    const blends = weights.map((w, i) => ({ w, ...summary(blendAcc[i]) }));
    const bestBlend = blends.filter(b => b.n).sort((a, b) => a.logloss - b.logloss)[0] || null;
    return {
      baseline: summary(acc.baseline), model: summary(acc.model), market: summary(acc.market),
      blend: bestBlend, blends, calibration: calibration(preds, bestBlend ? bestBlend.w : 0),
    };
  }

  /** جدول کالیبراسیون: در هر بازهٔ احتمال، میانگین پیش‌بینی در برابر فراوانی واقعی */
  function calibration(preds, w) {
    const bins = Array.from({ length: 10 }, () => ({ p: 0, y: 0, n: 0 }));
    for (const x of preds) {
      const p = x.pk ? logPool(x.p, x.pk, w) : x.p;
      p.forEach((v, i) => {
        const b = bins[Math.min(9, Math.floor(v * 10))];
        b.p += v; b.y += i === x.y ? 1 : 0; b.n++;
      });
    }
    return bins.map((b, i) => ({ bin: i, n: b.n, predicted: b.n ? b.p / b.n : null, observed: b.n ? b.y / b.n : null }));
  }

  /** ردیف‌های فشردهٔ history.js را به شیء تبدیل می‌کند. */
  function parseRows(rows) {
    return rows.map(r => ({
      t: Date.parse(r[0] + 'T12:00:00Z'), h: r[1], a: r[2], hg: r[3], ag: r[4], hxg: r[5], axg: r[6],
      odds: r[7] ? { h: r[7], d: r[8], a: r[9], over: r[10], under: r[11] } : null,
    }));
  }

  const api = {
    DEFAULTS, scoreMatrix, markets, devig, americanToDecimal, logPool, solveLambdas,
    fitRatings, expectedGoals, predict, livePredict, remainingShare, backtest, parseRows,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BetModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
