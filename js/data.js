/*
 * لایهٔ داده: بازی‌ها و نتایج زنده از API عمومی ESPN (CORS آزاد، بدون کلید)
 * تاریخچهٔ نتایج/xG/ضرایب در data/history.js است (ساخته‌شده با tools/build_data.py).
 */
(function (root) {
  'use strict';

  const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/soccer';

  const LEAGUES = [
    { id: 'eng.1', name: 'لیگ برتر انگلیس', country: 'انگلستان', flag: '🏴' },
    { id: 'esp.1', name: 'لالیگا', country: 'اسپانیا', flag: '🇪🇸' },
    { id: 'ita.1', name: 'سری آ', country: 'ایتالیا', flag: '🇮🇹' },
    { id: 'ger.1', name: 'بوندس‌لیگا', country: 'آلمان', flag: '🇩🇪' },
    { id: 'fra.1', name: 'لیگ ۱', country: 'فرانسه', flag: '🇫🇷' },
  ];

  // نام فارسی تیم‌ها بر اساس shortDisplayName در ESPN؛ تیم‌های ناشناخته با نام انگلیسی نمایش داده می‌شوند.
  const FA_NAMES = {
    'Arsenal': 'آرسنال', 'Aston Villa': 'استون ویلا', 'Bournemouth': 'بورنموث', 'Brentford': 'برنتفورد',
    'Brighton': 'برایتون', 'C Palace': 'کریستال پالاس', 'Chelsea': 'چلسی', 'Coventry': 'کاونتری',
    'Everton': 'اورتون', 'Fulham': 'فولام', 'Hull': 'هال سیتی', 'Ipswich': 'ایپسویچ', 'Leeds': 'لیدز',
    'Liverpool': 'لیورپول', 'Man City': 'منچستر سیتی', 'Man United': 'منچستر یونایتد', 'Newcastle': 'نیوکاسل',
    'Nottm Forest': 'ناتینگهام فارست', 'Spurs': 'تاتنهام', 'Sunderland': 'ساندرلند', 'West Ham': 'وستهام',
    'Wolves': 'ولورهمپتون', 'Burnley': 'برنلی', 'Leicester': 'لستر', 'Southampton': 'ساوتهمپتون',
    'Alavés': 'آلاوس', 'Athletic': 'اتلتیک بیلبائو', 'Atlético': 'اتلتیکو مادرید', 'Barcelona': 'بارسلونا',
    'Betis': 'رئال بتیس', 'Celta Vigo': 'سلتاویگو', 'Deportivo': 'دپورتیوو لاکرونیا', 'Elche': 'الچه',
    'Espanyol': 'اسپانیول', 'Getafe': 'ختافه', 'Levante': 'لوانته', 'Málaga': 'مالاگا', 'Osasuna': 'اوساسونا',
    'Racing': 'راسینگ سانتاندر', 'Rayo': 'رایو وایکانو', 'Real Madrid': 'رئال مادرید', 'Real Sociedad': 'رئال سوسیداد',
    'Sevilla': 'سویا', 'Valencia': 'والنسیا', 'Villarreal': 'ویارئال', 'Girona': 'جیرونا', 'Mallorca': 'مایورکا',
    'Real Oviedo': 'رئال اوویدو', 'Las Palmas': 'لاس پالماس', 'Leganés': 'لگانس', 'Valladolid': 'وایادولید',
    'AS Roma': 'آ.اس رم', 'Atalanta': 'آتالانتا', 'Bologna': 'بولونیا', 'Cagliari': 'کالیاری', 'Como': 'کومو',
    'Fiorentina': 'فیورنتینا', 'Frosinone': 'فروزینونه', 'Genoa': 'جنوا', 'Inter Milan': 'اینتر', 'Juventus': 'یوونتوس',
    'Lazio': 'لاتزیو', 'Lecce': 'لچه', 'Milan': 'آ.ث. میلان', 'Monza': 'مونزا', 'Napoli': 'ناپولی', 'Parma': 'پارما',
    'Sassuolo': 'ساسوئولو', 'Torino': 'تورینو', 'Udinese': 'اودینزه', 'Venezia': 'ونزیا', 'Verona': 'ورونا',
    'Empoli': 'امپولی', 'Cremonese': 'کرمونزه', 'Pisa': 'پیزا',
    'Augsburg': 'آگسبورگ', 'Bayern': 'بایرن مونیخ', 'Bremen': 'وردر برمن', 'Cologne': 'کلن', 'Dortmund': 'دورتموند',
    'Elversberg': 'الورسبرگ', 'Frankfurt': 'آینتراخت فرانکفورت', 'Freiburg': 'فرایبورگ', 'Gladbach': 'مونشن‌گلادباخ',
    'Hamburg': 'هامبورگ', 'Hoffenheim': 'هوفنهایم', 'Leverkusen': 'بایر لورکوزن', 'Mainz': 'ماینتس',
    'Paderborn': 'پادربورن', 'RB Leipzig': 'لایپزیگ', 'Schalke': 'شالکه', 'Stuttgart': 'اشتوتگارت',
    'Union Berlin': 'اونیون برلین', 'Wolfsburg': 'ولفسبورگ', 'Heidenheim': 'هایدنهایم', 'St. Pauli': 'سنت پائولی',
    'Bochum': 'بوخوم', 'Holstein Kiel': 'هولشتاین کیل',
    'Angers': 'آنژه', 'Auxerre': 'اوسر', 'Brest': 'برست', 'Le Havre AC': 'لوهاور', 'Le Mans': 'لومان', 'Lens': 'لانس',
    'Lille': 'لیل', 'Lorient': 'لوریان', 'Lyon': 'لیون', 'Marseille': 'مارسی', 'Monaco': 'موناکو', 'Nice': 'نیس',
    'PSG': 'پاری‌سن‌ژرمن', 'Paris FC': 'پاریس اف‌سی', 'Rennes': 'رن', 'Strasbourg': 'استراسبورگ', 'Toulouse': 'تولوز',
    'Troyes': 'تروا', 'Nantes': 'نانت', 'Metz': 'متز', 'Montpellier': 'مون‌پلیه', 'Reims': 'رنس', 'St. Étienne': 'سنت‌اتین',
  };

  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  const ym = d => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}`;

  async function getJSON(url, { timeout = 15000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return await r.json();
    } finally { clearTimeout(timer); }
  }

  function teamFrom(c) {
    const t = c.team || {};
    return {
      id: t.id, short: t.shortDisplayName || t.displayName, name: FA_NAMES[t.shortDisplayName] || t.shortDisplayName || t.displayName,
      en: t.displayName, abbr: t.abbreviation || '', color: t.color ? '#' + t.color : '#2a4450', logo: t.logo || '',
      score: c.score != null && c.score !== '' ? Number(c.score) : null, form: c.form || '',
    };
  }

  /** ضرایب ESPN (DraftKings، آمریکایی) → اعشاری */
  function espnOdds(comp) {
    const o = (comp.odds || []).find(Boolean);
    if (!o) return null;
    const am = BetModel.americanToDecimal;
    const ml = o.moneyline || {};
    const pick = side => ml[side] && (ml[side].close || ml[side].open) && (ml[side].close || ml[side].open).odds;
    const h = am(pick('home')), a = am(pick('away')), d = o.drawOdds ? am(o.drawOdds.moneyLine) : null;
    let over = null, under = null;
    const tot = o.total || {};
    const ln = tot.over && (tot.over.close || tot.over.open);
    if (ln && /2\.5$/.test(ln.line || '')) {
      over = am(ln.odds);
      const un = tot.under && (tot.under.close || tot.under.open);
      under = un ? am(un.odds) : null;
    }
    if (!h || !d || !a) return null;
    return { h, d, a, over, under, provider: (o.provider && o.provider.name) || 'ESPN' };
  }

  function parseEvent(e, league) {
    const c = e.competitions[0];
    const st = e.status || {};
    const type = st.type || {};
    const home = teamFrom(c.competitors.find(x => x.homeAway === 'home'));
    const away = teamFrom(c.competitors.find(x => x.homeAway === 'away'));
    const reds = { h: 0, a: 0 };
    for (const d of c.details || []) {
      if (!d.redCard || !d.team) continue;
      if (d.team.id === home.id) reds.h++; else if (d.team.id === away.id) reds.a++;
    }
    return {
      id: e.id, league, date: new Date(e.date), state: type.state, statusName: type.name,
      completed: !!type.completed, statusText: type.shortDetail || type.detail || '',
      minute: (st.clock || 0) / 60, period: st.period || 0, clock: st.displayClock || '',
      home, away, reds, odds: espnOdds(c),
    };
  }

  async function scoreboard(league, dates) {
    const j = await getJSON(`${ESPN}/${league}/scoreboard?dates=${dates}&limit=400`);
    return (j.events || []).map(e => parseEvent(e, league));
  }

  /** ماه‌هایی که بازه [from, to] را می‌پوشانند (به‌صورت YYYYMM) */
  function monthsCovering(from, to) {
    const out = [];
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
    while (d <= to) { out.push(ym(d)); d.setUTCMonth(d.getUTCMonth() + 1); }
    return out;
  }

  /** تاریخ ESPN (به وقت شرق آمریکا) برای یک لحظه؛ پارامتر dates در ESPN با این تقویم کار می‌کند. */
  function espnDay(date) {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
    return p.replace(/-/g, '');
  }

  root.BetData = { LEAGUES, FA_NAMES, scoreboard, monthsCovering, espnDay, ymd, getJSON };
})(window);
