/*
 * تحلیل هوش مصنوعی با Claude (اختیاری).
 * Claude با جست‌وجوی وب اخبار مصدومیت، محرومیت، ترکیب احتمالی و انگیزه را پیدا می‌کند و
 * خروجی مدل آماری را بازبینی می‌کند. کلید API فقط در localStorage همین مرورگر ذخیره می‌شود و
 * درخواست مستقیم از مرورگر به api.anthropic.com می‌رود.
 */
(function (root) {
  'use strict';

  const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.129.0/+esm';
  const MODEL = 'claude-opus-5';
  const KEY_STORAGE = 'baazikhan.anthropicKey';

  const SYSTEM = `You are a careful football (soccer) analyst writing for a Persian-language match-analysis site.
You receive a statistical model's output (Dixon-Coles ratings blended with bookmaker odds) for one match.
Use web search to find information the model cannot see: confirmed or likely injuries and suspensions,
expected line-ups, rotation risk (cup/European fixtures), manager changes, motivation, weather, and any
late news. Prefer sources from the last 7 days and say when information is unconfirmed.

Write in Persian (Farsi), concise, with these short sections:
**خلاصه** (2–3 sentences), **اخبار تیم‌ها**, **نقاط کلیدی**, **جمع‌بندی و ریسک‌ها**.
Be calibrated: bookmaker odds already price in most public news, so only move probabilities when you found
concrete information, and usually by a few percentage points. Never promise outcomes or encourage betting.

End your answer with exactly one line in this format (probabilities are numbers that sum to 1):
<probs>{"home":0.00,"draw":0.00,"away":0.00,"over25":0.00}</probs>`;

  const getKey = () => { try { return localStorage.getItem(KEY_STORAGE) || ''; } catch { return ''; } };
  const setKey = k => { try { k ? localStorage.setItem(KEY_STORAGE, k) : localStorage.removeItem(KEY_STORAGE); } catch { /* حالت خصوصی */ } };

  let clientPromise = null, clientKey = null;
  async function client() {
    const key = getKey();
    if (!key) throw new Error('NO_KEY');
    if (!clientPromise || clientKey !== key) {
      clientKey = key;
      clientPromise = import(SDK_URL).then(({ default: Anthropic }) =>
        new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true }));
    }
    return clientPromise;
  }

  function describe(match, pred) {
    const pct = x => (x == null ? '—' : (x * 100).toFixed(1) + '%');
    const f = pred.final;
    const lines = [
      `Match: ${match.home.en} (home) vs ${match.away.en} (away)`,
      `League: ${match.league}  Kick-off (UTC): ${match.date.toISOString()}`,
      `Status: ${match.state === 'in' ? `LIVE ${match.clock} score ${match.home.score}-${match.away.score}, red cards home ${match.reds.h} away ${match.reds.a}` : match.state === 'post' ? `finished ${match.home.score}-${match.away.score}` : 'not started'}`,
      `Recent form (oldest→newest, W/D/L): home ${match.home.form || 'n/a'}, away ${match.away.form || 'n/a'}`,
      `Model expected goals: home ${pred.lh.toFixed(2)}, away ${pred.la.toFixed(2)}`,
      `Stats-only model: home ${pct(pred.model.home)}, draw ${pct(pred.model.draw)}, away ${pct(pred.model.away)}, over 2.5 ${pct(pred.model.over25)}`,
      pred.market ? `Bookmaker (vig removed): home ${pct(pred.market.home)}, draw ${pct(pred.market.draw)}, away ${pct(pred.market.away)}, over 2.5 ${pct(pred.market.over25)}` : 'Bookmaker odds: not available',
      `Final site estimate${match.state === 'in' ? ' (live)' : ''}: home ${pct(f.home)}, draw ${pct(f.draw)}, away ${pct(f.away)}, over 2.5 ${pct(f.over25)}, BTTS ${pct(f.btts)}`,
      `Most likely scores: ${f.topScores.slice(0, 4).map(s => `${s.h}-${s.a} (${pct(s.p)})`).join(', ')}`,
    ];
    return lines.join('\n');
  }

  /**
   * تحلیل را استریم می‌کند. onText(متن تجمعی) برای نمایش زنده صدا زده می‌شود.
   * خروجی: {text, probs}
   */
  async function analyze(match, pred, onText, signal) {
    const anthropic = await client();
    const messages = [{ role: 'user', content: describe(match, pred) }];
    let text = '';
    // web search ممکن است با pause_turn متوقف شود؛ تا چند دور ادامه می‌دهیم.
    for (let turn = 0; turn < 4; turn++) {
      const stream = anthropic.beta.messages.stream({
        model: MODEL,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
        system: SYSTEM,
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }],
        messages,
      }, { signal });
      stream.on('text', delta => { text += delta; onText(text); });
      const msg = await stream.finalMessage();
      if (msg.stop_reason === 'refusal') throw new Error('REFUSAL');
      if (msg.stop_reason !== 'pause_turn') break;
      messages.push({ role: 'assistant', content: msg.content });
    }
    let probs = null;
    const m = text.match(/<probs>\s*(\{[\s\S]*?\})\s*<\/probs>/);
    if (m) {
      try {
        const p = JSON.parse(m[1]);
        const s = (p.home || 0) + (p.draw || 0) + (p.away || 0);
        if (s > 0.9 && s < 1.1) probs = { home: p.home / s, draw: p.draw / s, away: p.away / s, over25: p.over25 ?? null };
      } catch { /* خروجی نامعتبر؛ فقط متن نمایش داده می‌شود */ }
    }
    return { text: text.replace(/<probs>[\s\S]*?<\/probs>/, '').trim(), probs };
  }

  root.BetAI = { analyze, getKey, setKey, MODEL };
})(window);
