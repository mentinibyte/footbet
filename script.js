/* بازی‌خوان — اتصال رابط کاربری به دادهٔ زنده و مدل پیش‌بینی */
(function () {
  'use strict';
  const M = window.BetModel, D = window.BetData, AI = window.BetAI;
  const DAY = 86400000;

  const state = {
    events: new Map(),      // id → رویداد ESPN
    fits: new Map(),        // لیگ → پارامترهای مدل
    weights: new Map(),     // لیگ → وزن بازار از بک‌تست
    backtests: new Map(),
    fdOdds: new Map(),      // ضرایب football-data برای بازی‌های آینده
    history: null,
    selectedDay: null, filter: 'all', league: 'all', sortByPick: false, showAll: false,
    expanded: new Set(), ai: new Map(),
    lastUpdate: null, error: null, pollTimer: null,
  };

  // ---------- قالب‌بندی ----------
  const faNum = new Intl.NumberFormat('fa-IR');
  const faDec = new Intl.NumberFormat('fa-IR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = p => faNum.format(Math.round(p * 100));
  const timeFmt = new Intl.DateTimeFormat('fa-IR', { hour: '2-digit', minute: '2-digit' });
  const dayFmt = new Intl.DateTimeFormat('fa-IR', { weekday: 'long', day: 'numeric', month: 'long' });
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = s => document.querySelector(s);
  const localDayKey = d => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  const leagueInfo = id => D.LEAGUES.find(l => l.id === id);

  function dayLabel(key) {
    const today = new Date();
    const tomorrow = new Date(Date.now() + DAY);
    const yesterday = new Date(Date.now() - DAY);
    if (key === localDayKey(today)) return 'امروز';
    if (key === localDayKey(tomorrow)) return 'فردا';
    if (key === localDayKey(yesterday)) return 'دیروز';
    const [y, m, d] = key.split('-').map(Number);
    return dayFmt.format(new Date(y, m - 1, d));
  }

  // ---------- داده و مدل ----------
  function trainingRows(league) {
    const hist = state.history && state.history.leagues[league];
    const rows = hist ? M.parseRows(hist.matches) : [];
    // نتایج تازهٔ ESPN که هنوز در فایل تاریخچه نیامده‌اند
    const seen = new Set(rows.map(r => `${r.h}|${r.a}|${Math.round(r.t / DAY)}`));
    for (const e of state.events.values()) {
      if (e.league !== league || !e.completed || e.home.score == null) continue;
      const day = Math.round(Date.parse(e.date.toISOString().slice(0, 10) + 'T12:00:00Z') / DAY);
      if ([day - 1, day, day + 1].some(d => seen.has(`${e.home.id}|${e.away.id}|${d}`))) continue;
      rows.push({ t: day * DAY, h: e.home.id, a: e.away.id, hg: e.home.score, ag: e.away.score, hxg: null, axg: null, odds: null });
    }
    return rows.sort((a, b) => a.t - b.t);
  }

  function fitAll() {
    for (const l of D.LEAGUES) {
      const rows = trainingRows(l.id);
      if (rows.length >= 60) state.fits.set(l.id, M.fitRatings(rows, Date.now()));
    }
  }

  function runBacktests() {
    for (const l of D.LEAGUES) {
      const rows = trainingRows(l.id);
      if (rows.length < 300) continue;
      const bt = M.backtest(rows, { days: 280 });
      state.backtests.set(l.id, bt);
      if (bt.blend && bt.blend.n >= 80) state.weights.set(l.id, bt.blend.w);
    }
  }

  function indexFdOdds() {
    state.fdOdds.clear();
    if (!state.history) return;
    for (const [lg, l] of Object.entries(state.history.leagues)) {
      for (const u of l.upcoming || []) {
        state.fdOdds.set(`${lg}|${u[1]}|${u[2]}`, { t: Date.parse(u[0] + 'T12:00:00Z'), h: u[3], d: u[4], a: u[5], over: u[6], under: u[7], provider: 'Pinnacle/بازار' });
      }
    }
  }

  function oddsFor(e) {
    const fd = state.fdOdds.get(`${e.league}|${e.home.id}|${e.away.id}`);
    if (fd && fd.h && Math.abs(fd.t - e.date.getTime()) < 2 * DAY) return fd;
    return e.odds;
  }

  function predictEvent(e) {
    const fit = state.fits.get(e.league);
    if (!fit) return null;
    const odds = oddsFor(e);
    const pre = M.predict(fit, e.home.id, e.away.id, odds, { marketWeight: state.weights.get(e.league) ?? M.DEFAULTS.marketWeight });
    pre.odds = odds;
    if (e.state === 'in') {
      const live = M.livePredict(pre, {
        minute: e.statusName === 'STATUS_HALFTIME' ? 45 : e.minute, period: e.statusName === 'STATUS_HALFTIME' ? 1 : e.period,
        hg: e.home.score || 0, ag: e.away.score || 0, redH: e.reds.h, redA: e.reds.a,
      });
      return { ...pre, pre: pre.final, final: live.final, live };
    }
    return { ...pre, pre: pre.final };
  }

  // ---------- انتخاب پیشنهاد ----------
  function pickFor(e, p) {
    const f = p.final, H = e.home.name, A = e.away.name;
    const c = [
      { key: 'H', label: `برد ${H}`, p: f.home, odds: p.odds && p.odds.h },
      { key: 'A', label: `برد ${A}`, p: f.away, odds: p.odds && p.odds.a },
      { key: 'HX', label: `${H} یا مساوی`, p: f.home + f.draw, safe: 1 },
      { key: 'AX', label: `${A} یا مساوی`, p: f.away + f.draw, safe: 1 },
      { key: 'O25', label: 'بالای ۲.۵ گل', p: f.over25, odds: p.odds && p.odds.over },
      { key: 'U25', label: 'زیر ۲.۵ گل', p: 1 - f.over25, odds: p.odds && p.odds.under },
      { key: 'BTTS', label: 'هر دو تیم گل می‌زنند', p: f.btts },
      { key: 'NBTTS', label: 'حداقل یک تیم گل نمی‌زند', p: 1 - f.btts },
      { key: 'O15', label: 'بالای ۱.۵ گل', p: f.over15, safe: 1 },
      { key: 'U35', label: 'زیر ۳.۵ گل', p: 1 - f.over35, safe: 1 },
    ].filter(x => x.p <= 0.82 && x.p >= 0.5);
    // بازارهای «امن» احتمال بالایی دارند ولی اطلاعات کمی می‌دهند؛ کمی جریمه می‌شوند.
    c.sort((a, b) => (b.p - (b.safe ? 0.07 : 0)) - (a.p - (a.safe ? 0.07 : 0)));
    const best = c[0];
    if (!best || best.p < 0.58) return null;
    return best;
  }

  function pickHit(key, hg, ag) {
    return { H: hg > ag, A: ag > hg, HX: hg >= ag, AX: ag >= hg, O25: hg + ag > 2, U25: hg + ag < 3, BTTS: hg > 0 && ag > 0, NBTTS: !(hg > 0 && ag > 0), O15: hg + ag > 1, U35: hg + ag < 4 }[key];
  }

  // ---------- رندر ----------
  function crest(t) {
    const img = t.logo ? `<img src="${esc(t.logo)}" alt="" loading="lazy" onerror="this.remove()">` : '';
    return `<span class="crest" style="background:${esc(t.color)}">${img}<b>${esc(t.abbr)}</b></span>`;
  }

  function statusChip(e) {
    if (e.state === 'in') return `<span class="status live">زنده</span>`;
    if (e.state === 'post') return `<span class="status finished">${e.completed ? 'پایان' : esc(e.statusText)}</span>`;
    if (/POSTPONED|CANCELED/.test(e.statusName)) return `<span class="status finished">لغو/تعویق</span>`;
    return `<span class="status upcoming">${timeFmt.format(e.date)}</span>`;
  }

  function centerBlock(e) {
    if (e.state === 'pre') return `<div class="vs">مقابل</div><div class="kickoff">${timeFmt.format(e.date)}</div>`;
    const score = `<div class="score">${faNum.format(e.home.score ?? 0)} <span>-</span> ${faNum.format(e.away.score ?? 0)}</div>`;
    const clock = e.state === 'in' ? `<div class="match-clock">${e.statusName === 'STATUS_HALFTIME' ? 'بین دو نیمه' : esc(e.clock)}</div>` : '';
    return score + clock;
  }

  function formBadges(form) {
    if (!form) return '<span class="muted">—</span>';
    const fa = { W: 'ب', D: 'م', L: 'ش' };
    return [...form].map(c => `<i class="form-${c}">${fa[c] || c}</i>`).join('');
  }

  function detailsHtml(e, p) {
    const f = p.final, m = p.model, mk = p.market;
    const row = (label, a, b, c, d) => `<tr><th>${label}</th><td>${a}</td><td>${b}</td><td>${c}</td><td>${d}</td></tr>`;
    const cell = x => (x == null ? '—' : pct(x) + '٪');
    const ai = state.ai.get(e.id);
    const aiBlock = ai ? `<div class="ai-out" id="ai-${e.id}">${ai.probs ? `<div class="ai-probs">برآورد Claude: میزبان <b>${pct(ai.probs.home)}٪</b> · مساوی <b>${pct(ai.probs.draw)}٪</b> · مهمان <b>${pct(ai.probs.away)}٪</b>${ai.probs.over25 != null ? ` · بالای ۲.۵ <b>${pct(ai.probs.over25)}٪</b>` : ''}</div>` : ''}${renderMd(ai.text)}${ai.loading ? '<span class="ai-cursor"></span>' : ''}${ai.error ? `<div class="ai-error">${esc(ai.error)}</div>` : ''}</div>` : '';
    return `<div class="details">
      <div class="xg-row"><span>گل مورد انتظار</span><b>${faDec.format(p.lh)}</b><i style="--a:${Math.min(100, p.lh / (p.lh + p.la) * 100)}%"></i><b>${faDec.format(p.la)}</b></div>
      <table class="prob-table"><thead><tr><th></th><th>میزبان</th><th>مساوی</th><th>مهمان</th><th>بالای ۲.۵</th></tr></thead><tbody>
        ${row('مدل آماری', cell(m.home), cell(m.draw), cell(m.away), cell(m.over25))}
        ${row(`بازار${p.odds && p.odds.provider ? ` <small>(${esc(p.odds.provider)})</small>` : ''}`, cell(mk && mk.home), cell(mk && mk.draw), cell(mk && mk.away), cell(mk && mk.over25))}
        ${e.state === 'in' ? row('پیش از بازی', cell(p.pre.home), cell(p.pre.draw), cell(p.pre.away), cell(p.pre.over25)) : ''}
        ${row(e.state === 'in' ? '<b>زنده (نهایی)</b>' : '<b>نهایی</b>', cell(f.home), cell(f.draw), cell(f.away), cell(f.over25))}
      </tbody></table>
      <div class="detail-grid">
        <div><span class="dlabel">محتمل‌ترین نتایج</span><div class="scores">${f.topScores.slice(0, 5).map(s => `<span>${faNum.format(s.h)}-${faNum.format(s.a)} <b>${pct(s.p)}٪</b></span>`).join('')}</div></div>
        <div><span class="dlabel">گل‌ها</span><div class="scores"><span>بالای ۱.۵ <b>${pct(f.over15)}٪</b></span><span>بالای ۳.۵ <b>${pct(f.over35)}٪</b></span><span>گل هر دو <b>${pct(f.btts)}٪</b></span></div></div>
        <div><span class="dlabel">فرم اخیر</span><div class="form-row"><span>${esc(e.home.name)}</span>${formBadges(e.home.form)}</div><div class="form-row"><span>${esc(e.away.name)}</span>${formBadges(e.away.form)}</div></div>
      </div>
      ${e.state === 'in' ? `<p class="note">${faNum.format(Math.round(p.live.share * 100))}٪ از گل‌های مورد انتظار بازی هنوز باقی مانده${e.reds.h || e.reds.a ? ` · کارت قرمز: ${esc(e.home.name)} ${faNum.format(e.reds.h)}، ${esc(e.away.name)} ${faNum.format(e.reds.a)}` : ''}.</p>` : ''}
      <p class="note">${p.source === 'blend' ? `ترکیب مدل Dixon-Coles با ضرایب بازار (وزن بازار ${pct(state.weights.get(e.league) ?? M.DEFAULTS.marketWeight)}٪، تنظیم‌شده با بک‌تست).` : 'ضریب بازار در دسترس نبود؛ فقط مدل آماری.'} احتمال‌ها تضمین نتیجه نیستند.</p>
      <div class="ai-bar"><button class="ai-button" data-ai="${e.id}" ${ai && ai.loading ? 'disabled' : ''}>✦ ${ai && ai.loading ? 'در حال تحلیل…' : ai ? 'تحلیل دوباره با هوش مصنوعی' : 'تحلیل هوش مصنوعی (Claude + جست‌وجوی اخبار)'}</button></div>
      ${aiBlock}
    </div>`;
  }

  function card(e) {
    const p = e.pred;
    const L = leagueInfo(e.league);
    const expanded = state.expanded.has(e.id);
    if (!p) {
      return `<article class="match-card" data-id="${e.id}"><div class="match-head"><span class="league-name"><span class="flag">${L.flag}</span>${L.name}</span>${statusChip(e)}</div>
        <div class="teams-row"><div class="team">${crest(e.home)}<span class="team-name">${esc(e.home.name)}</span></div><div>${centerBlock(e)}</div><div class="team">${crest(e.away)}<span class="team-name">${esc(e.away.name)}</span></div></div>
        <div class="pick none">دادهٔ کافی برای مدل این لیگ وجود ندارد</div></article>`;
    }
    const f = p.final, pick = e.pick;
    const [h, d, a] = [f.home, f.draw, f.away].map(x => Math.round(x * 100));
    let pickHtml;
    if (pick) {
      const fair = 1 / pick.p;
      const value = pick.odds ? pick.p * pick.odds - 1 : null;
      const hit = e.state === 'post' && e.completed ? pickHit(pick.key, e.home.score, e.away.score) : null;
      pickHtml = `<div class="pick${hit === true ? ' won' : hit === false ? ' lost' : ''}"><div><div class="pick-label">${esc(pick.label)}</div>
        <div class="pick-meta">ضریب منصفانه ${faDec.format(fair)}${pick.odds ? ` · ضریب بازار ${faDec.format(pick.odds)}` : ''}${value != null && value > 0.02 ? ` · ارزش +${pct(value)}٪` : ''}</div></div>
        <div class="confidence">${pct(pick.p)}٪<small>احتمال</small></div><span class="pick-tag">${hit === true ? 'درست ✓' : hit === false ? 'نادرست ✗' : e.state === 'in' ? 'زنده' : 'پیشنهاد'}</span></div>`;
    } else {
      pickHtml = `<div class="pick none">هیچ بازاری احتمال کافی (≥ ۵۸٪) برای پیشنهاد ندارد</div>`;
    }
    const chips = [['هر دو تیم گل می‌زنند', f.btts], ['بالای ۲.۵ گل', f.over25], ['زیر ۳.۵ گل', 1 - f.over35]]
      .filter(x => !pick || !pick.label.startsWith(x[0].slice(0, 6))).slice(0, 2);
    return `<article class="match-card${expanded ? ' expanded' : ''}${e.state === 'in' ? ' is-live' : ''}" data-id="${e.id}">
      <div class="match-head"><span class="league-name"><span class="flag">${L.flag}</span>${L.name}</span>${statusChip(e)}</div>
      <div class="teams-row"><div class="team">${crest(e.home)}<span class="team-name">${esc(e.home.name)}</span></div><div>${centerBlock(e)}</div><div class="team">${crest(e.away)}<span class="team-name">${esc(e.away.name)}</span></div></div>
      <div class="probability"><div class="prob-bar"><i style="width:${h}%"></i><i style="width:${d}%"></i><i style="width:${a}%"></i></div>
        <div class="prob-labels"><span><b>${faNum.format(h)}٪</b> برد میزبان</span><span>مساوی <b>${faNum.format(d)}٪</b></span><span>برد مهمان <b>${faNum.format(a)}٪</b></span></div></div>
      ${pickHtml}
      <div class="markets">${chips.map(x => `<div class="market-chip"><span>${x[0]}</span><b>${pct(x[1])}٪</b></div>`).join('')}</div>
      <div class="card-foot"><span>${e.state === 'in' ? 'احتمال‌ها با جریان بازی به‌روز می‌شوند' : e.state === 'post' ? 'پیش‌بینی پیش از بازی' : p.source === 'blend' ? 'مدل + ضرایب بازار' : 'فقط مدل آماری'}</span>
        <button class="details-button" data-details="${e.id}">${expanded ? 'بستن جزئیات <span>⌃</span>' : 'جزئیات بیشتر <span>⌄</span>'}</button></div>
      ${expanded ? detailsHtml(e, p) : ''}
    </article>`;
  }

  function renderMd(text) {
    return esc(text).split(/\n{2,}/).map(par => `<p>${par.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>')}</p>`).join('');
  }

  function eventsForDay() {
    return [...state.events.values()].filter(e => localDayKey(e.date) === state.selectedDay);
  }

  function visibleEvents() {
    let items = eventsForDay()
      .filter(e => state.league === 'all' || e.league === state.league)
      .filter(e => state.filter === 'all' || (state.filter === 'live' && e.state === 'in') || (state.filter === 'suggested' && e.pick));
    const rank = e => (e.state === 'in' ? 0 : e.state === 'pre' ? 1 : 2);
    items.sort(state.sortByPick
      ? (x, y) => ((y.pick ? y.pick.p : 0) - (x.pick ? x.pick.p : 0))
      : (x, y) => rank(x) - rank(y) || x.date - y.date);
    return items;
  }

  function render() {
    const day = eventsForDay();
    const items = visibleEvents();
    const shown = state.showAll ? items : items.slice(0, 9);
    const list = $('#match-list');
    if (!state.fits.size && !state.error) list.innerHTML = '<div class="empty-state">در حال دریافت داده و آموزش مدل…</div>';
    else list.innerHTML = shown.length ? shown.map(card).join('') : '<div class="empty-state">بازی‌ای با این فیلتر پیدا نشد.</div>';
    $('#load-more').hidden = items.length <= 9;
    $('#load-more').innerHTML = state.showAll ? 'نمایش کمتر <span>⌃</span>' : `نمایش ${faNum.format(items.length - 9)} بازی دیگر <span>⌄</span>`;

    const live = day.filter(e => e.state === 'in').length;
    const picks = day.filter(e => e.pick);
    const leagues = new Set(day.map(e => e.league)).size;
    $('#filter-all').textContent = faNum.format(day.length);
    $('#filter-suggested').textContent = faNum.format(picks.length);
    $('#filter-live').textContent = faNum.format(live);
    $('#nav-count').textContent = faNum.format(day.length);
    $('#sum-matches').textContent = faNum.format(day.length);
    $('#sum-leagues').textContent = `در ${faNum.format(leagues)} لیگ${live ? ` · ${faNum.format(live)} بازی زنده` : ''}`;
    $('#sum-picks').textContent = faNum.format(picks.length);
    const avg = picks.length ? picks.reduce((s, e) => s + e.pick.p, 0) / picks.length : 0;
    $('#sum-conf').innerHTML = `${pct(avg)}<small class="percent">٪</small>`;
    $('#sum-conf-bar').style.width = Math.round(avg * 100) + '%';
    const finished = picks.filter(e => e.state === 'post' && e.completed);
    $('#sum-picks-note').textContent = finished.length
      ? `${faNum.format(finished.filter(e => pickHit(e.pick.key, e.home.score, e.away.score)).length)} از ${faNum.format(finished.length)} پیشنهاد تمام‌شده درست بود`
      : 'احتمال ≥ ۵۸٪ در یکی از بازارها';
    $('#day-title').textContent = `مسابقات ${dayLabel(state.selectedDay)}`;
    renderDayMenu();
  }

  function renderDayMenu() {
    const counts = new Map();
    for (const e of state.events.values()) counts.set(localDayKey(e.date), (counts.get(localDayKey(e.date)) || 0) + 1);
    const days = [];
    for (let i = -1; i <= 7; i++) days.push(localDayKey(new Date(Date.now() + i * DAY)));
    const sel = $('#day-select');
    sel.innerHTML = days.map(k => `<option value="${k}" ${k === state.selectedDay ? 'selected' : ''}>${dayLabel(k)} (${faNum.format(counts.get(k) || 0)})</option>`).join('');
  }

  function renderStatus() {
    const badge = $('#data-badge');
    if (state.error && !state.lastUpdate) {
      badge.className = 'data-badge error'; badge.innerHTML = '<i></i>خطا در دریافت داده';
    } else if (state.lastUpdate) {
      badge.className = 'data-badge live'; badge.innerHTML = `<i></i>دادهٔ زنده · ${timeFmt.format(state.lastUpdate)}`;
    }
    const h = state.history;
    $('#sidebar-foot').innerHTML = h ? `تاریخچه: ${esc(new Date(h.generated).toLocaleDateString('fa-IR'))} <span class="demo-dot ok"></span>` : 'فقط دادهٔ ESPN <span class="demo-dot"></span>';
  }

  function renderMethod() {
    let n = 0, sums = { model: [0, 0, 0], market: [0, 0, 0], blend: [0, 0, 0], baseline: [0, 0, 0] }, counts = { model: 0, market: 0, blend: 0, baseline: 0 };
    const calib = Array.from({ length: 10 }, () => ({ p: 0, y: 0, n: 0 }));
    for (const bt of state.backtests.values()) {
      for (const k of Object.keys(sums)) {
        const s = bt[k]; if (!s) continue;
        sums[k][0] += s.logloss * s.n; sums[k][1] += s.brier * s.n; sums[k][2] += s.accuracy * s.n; counts[k] += s.n;
      }
      bt.calibration.forEach((c, i) => { if (c.n) { calib[i].p += c.predicted * c.n; calib[i].y += c.observed * c.n; calib[i].n += c.n; } });
      n += bt.model ? bt.model.n : 0;
    }
    if (!n) return;
    const names = { baseline: 'خط پایه (فراوانی تاریخی)', model: 'مدل آماری Dixon-Coles', market: 'ضرایب بسته‌شدن بازار', blend: 'ترکیب مدل + بازار (سایت)' };
    const rows = Object.keys(names).filter(k => counts[k]).map(k => `<tr${k === 'blend' ? ' class="hl"' : ''}><th>${names[k]}</th><td>${faNum.format(counts[k])}</td><td>${faNum.format(+(sums[k][0] / counts[k]).toFixed(3))}</td><td>${faNum.format(+(sums[k][1] / counts[k]).toFixed(3))}</td><td>${pct(sums[k][2] / counts[k])}٪</td></tr>`).join('');
    const bars = calib.filter(c => c.n >= 20).map(c => `<div class="cal" title="${faNum.format(c.n)} پیش‌بینی"><i style="height:${(c.p / c.n) * 100}%"></i><b style="height:${(c.y / c.n) * 100}%"></b><span>${pct(c.p / c.n)}</span></div>`).join('');
    $('#method-body').innerHTML = `
      <p>هر هفته از ${faNum.format(Math.round(280 / 7))} هفتهٔ اخیر، مدل فقط با بازی‌های <b>قبل</b> از همان هفته آموزش دید و بازی‌های آن هفته را پیش‌بینی کرد (walk-forward، بدون نشت اطلاعات). معیارها برای نتیجهٔ ۱X۲ در ۵ لیگ است؛ log-loss و Brier هرچه کمتر بهتر.</p>
      <table class="bt-table"><thead><tr><th>روش</th><th>بازی</th><th>Log-loss</th><th>Brier</th><th>دقت</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="cal-wrap"><span class="dlabel">کالیبراسیون: احتمال پیش‌بینی‌شده (روشن) در برابر فراوانی واقعی (تیره)</span><div class="cal-chart">${bars}</div></div>
      <p>«دقت» یعنی درصد بازی‌هایی که محتمل‌ترین نتیجه رخ داد. در فوتبال حتی بهترین مدل‌ها و بازار هم معمولاً ۵۰ تا ۵۵ درصد دقت دارند؛ معیار اصلی کیفیت، کالیبره‌بودن احتمال‌هاست، نه نرخ برد.</p>`;
  }

  // ---------- چرخهٔ داده ----------
  function recompute() {
    for (const e of state.events.values()) {
      e.pred = predictEvent(e);
      e.pick = e.pred ? pickFor(e, e.pred) : null;
      if (e.pick && e.state === 'post') {
        // برای بازی تمام‌شده، پیشنهاد پیش از بازی را ارزیابی می‌کنیم
        e.pick = pickFor(e, { ...e.pred, final: e.pred.pre });
      }
    }
  }

  async function loadEvents() {
    const now = new Date();
    const months = D.monthsCovering(new Date(now.getTime() - 12 * DAY), new Date(now.getTime() + 8 * DAY));
    const jobs = [];
    for (const l of D.LEAGUES) for (const m of months) jobs.push(D.scoreboard(l.id, m).catch(err => { state.error = err; return []; }));
    const results = await Promise.all(jobs);
    for (const list of results) for (const e of list) state.events.set(e.id, e);
  }

  async function poll() {
    const now = Date.now();
    const active = [...state.events.values()].filter(e => e.state === 'in' || (e.state === 'pre' && e.date - now < 20 * 60000 && now - e.date < 3 * 3600000));
    const keys = new Set(active.map(e => `${e.league}|${D.espnDay(e.date)}`));
    if (!keys.size) for (const l of D.LEAGUES) keys.add(`${l.id}|${D.espnDay(new Date())}`);
    try {
      const lists = await Promise.all([...keys].map(k => { const [lg, d] = k.split('|'); return D.scoreboard(lg, d); }));
      for (const list of lists) for (const e of list) state.events.set(e.id, e);
      state.lastUpdate = new Date(); state.error = null;
      recompute(); render(); renderStatus();
    } catch (err) { console.warn(err); state.error = err; }
    schedulePoll();
  }

  function schedulePoll() {
    clearTimeout(state.pollTimer);
    const now = Date.now();
    const hot = [...state.events.values()].some(e => e.state === 'in' || (e.state === 'pre' && Math.abs(e.date - now) < 20 * 60000));
    state.pollTimer = setTimeout(poll, hot ? 30000 : 180000);
  }

  async function init() {
    try { $('#today-date').textContent = dayFmt.format(new Date()); } catch { /* مرورگر قدیمی */ }
    state.selectedDay = localDayKey(new Date());
    render();
    state.history = window.BAAZIKHAN_HISTORY || null;
    indexFdOdds();
    await loadEvents();
    if (!state.events.size) {
      state.error = state.error || new Error('no events');
      $('#match-list').innerHTML = '<div class="empty-state">دریافت دادهٔ زنده ممکن نشد. اتصال اینترنت را بررسی کنید.</div>';
      renderStatus();
      // خطای موقت شبکه نباید صفحه را برای همیشه در حالت خالی نگه دارد.
      schedulePoll();
      return;
    }
    state.lastUpdate = new Date();
    fitAll(); recompute();
    // اگر امروز بازی نیست، اولین روز دارای بازی را نشان بده
    if (!eventsForDay().length) {
      const next = [...state.events.values()].filter(e => e.date >= Date.now() - 3 * 3600000).sort((a, b) => a.date - b.date)[0];
      if (next) state.selectedDay = localDayKey(next.date);
    }
    render(); renderStatus();
    // بک‌تست بعد از اولین نمایش اجرا می‌شود تا صفحه منتظر نماند
    setTimeout(() => { runBacktests(); recompute(); render(); renderMethod(); }, 50);
    schedulePoll();
  }

  // ---------- هوش مصنوعی ----------
  async function runAI(id) {
    const e = state.events.get(id);
    if (!e || !e.pred) return;
    if (!AI.getKey()) { openSettings(); return; }
    const entry = { text: '', loading: true, probs: null, error: null };
    state.ai.set(id, entry);
    render();
    try {
      const res = await AI.analyze(e, e.pred, text => {
        entry.text = text.replace(/<probs>[\s\S]*$/, '');
        const el = document.getElementById('ai-' + id);
        if (el) el.innerHTML = renderMd(entry.text) + '<span class="ai-cursor"></span>';
      });
      Object.assign(entry, res);
    } catch (err) {
      entry.error = err.message === 'NO_KEY' ? 'کلید API تنظیم نشده است.'
        : err.message === 'REFUSAL' ? 'Claude این درخواست را رد کرد.'
          : err.status === 401 ? 'کلید API نامعتبر است.' : `خطا: ${err.message || err}`;
    }
    entry.loading = false;
    render();
  }

  function openSettings() {
    const dlg = $('#ai-dialog');
    $('#ai-key').value = AI.getKey();
    dlg.showModal();
  }

  // ---------- رویدادها ----------
  document.addEventListener('click', ev => {
    const det = ev.target.closest('[data-details]');
    if (det) {
      const id = det.dataset.details;
      state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id);
      render(); return;
    }
    const ai = ev.target.closest('[data-ai]');
    if (ai) { runAI(ai.dataset.ai); }
  });
  document.querySelectorAll('.filter').forEach(btn => btn.addEventListener('click', () => {
    document.querySelector('.filter.active').classList.remove('active');
    btn.classList.add('active'); state.filter = btn.dataset.filter; render();
  }));
  $('#league-select').addEventListener('change', e => { state.league = e.target.value; render(); });
  $('#day-select').addEventListener('change', e => { state.selectedDay = e.target.value; state.showAll = false; render(); });
  $('#load-more').addEventListener('click', () => { state.showAll = !state.showAll; render(); });
  $('#sort-button').addEventListener('click', e => {
    state.sortByPick = !state.sortByPick;
    e.currentTarget.innerHTML = `مرتب‌سازی: ${state.sortByPick ? 'احتمال پیشنهاد' : 'شروع بازی'} <span>⌄</span>`;
    render();
  });
  $('#settings-button').addEventListener('click', openSettings);
  $('#ai-form').addEventListener('submit', () => { AI.setKey($('#ai-key').value.trim()); toast(AI.getKey() ? 'کلید ذخیره شد' : 'کلید حذف شد'); });
  $('#clear-key').addEventListener('click', () => {
    AI.setKey(''); $('#ai-key').value = ''; toast('کلید حذف شد');
  });
  document.querySelectorAll('.nav-link').forEach(link => link.addEventListener('click', () => {
    document.querySelector('.nav-link.active')?.classList.remove('active'); link.classList.add('active');
  }));

  let toastTimer;
  function toast(message) {
    const el = $('#toast'); el.textContent = message; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  init();
})();
