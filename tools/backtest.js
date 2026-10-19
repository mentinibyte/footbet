// بک‌تست و تنظیم ابرپارامترهای مدل روی data/history.js
//   node tools/backtest.js          → گزارش با تنظیمات پیش‌فرض
//   node tools/backtest.js --tune   → جست‌وجوی شبکه‌ای xi / xgWeight / ridge
const fs = require('fs');
const path = require('path');
const M = require('../js/model.js');

const raw = fs.readFileSync(path.join(__dirname, '..', 'data', 'history.js'), 'utf8');
const data = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
const leagues = Object.entries(data.leagues).map(([id, l]) => [id, M.parseRows(l.matches)]);

function run(opts) {
  const tot = { model: [0, 0, 0], market: [0, 0, 0], base: [0, 0, 0], blend: [0, 0, 0] };
  const per = {};
  for (const [id, rows] of leagues) {
    const r = M.backtest(rows, opts);
    per[id] = r;
    for (const [k, src] of [['model', r.model], ['market', r.market], ['base', r.baseline], ['blend', r.blend]]) {
      if (!src) continue;
      tot[k][0] += src.n; tot[k][1] += src.logloss * src.n; tot[k][2] += src.brier * src.n;
    }
  }
  const avg = k => ({ n: tot[k][0], logloss: tot[k][1] / tot[k][0], brier: tot[k][2] / tot[k][0] });
  return { per, model: avg('model'), market: avg('market'), base: avg('base'), blend: avg('blend') };
}

const fmt = x => x.toFixed(4);
if (process.argv.includes('--tune')) {
  const results = [];
  for (const xi of [0.0015, 0.0025, 0.0035, 0.005])
    for (const xgWeight of [0, 0.3, 0.5, 0.7])
      for (const ridge of [3, 6, 12]) {
        const r = run({ xi, xgWeight, ridge, days: 300 });
        results.push({ xi, xgWeight, ridge, ll: r.model.logloss, br: r.model.brier });
        console.log(xi, xgWeight, ridge, fmt(r.model.logloss), fmt(r.model.brier));
      }
  results.sort((a, b) => a.ll - b.ll);
  console.log('best:', results.slice(0, 5));
} else {
  const r = run({ days: 300 });
  for (const [id, x] of Object.entries(r.per)) {
    console.log(id, 'n=' + x.model.n,
      'model', fmt(x.model.logloss), fmt(x.model.brier), (x.model.accuracy * 100).toFixed(1) + '%',
      '| market', x.market && fmt(x.market.logloss), '| blend w=' + (x.blend && x.blend.w), x.blend && fmt(x.blend.logloss),
      '| base', fmt(x.baseline.logloss));
  }
  console.log('ALL  model', r.model, '\n     market', r.market, '\n     blend', r.blend, '\n     base', r.base);
}
