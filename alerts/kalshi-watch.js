'use strict';

require('dotenv').config();

const http = require('http');

const KALSHI_BASE = 'https://external-api.kalshi.com/trade-api/v2';
const ORDERBOOK_CHUNK = 80;
const HTTP_CONCURRENCY = 4;
const HTTP_TIMEOUT_MS = 18000;
const SPORT_CONCURRENCY = 2;

const ALL_SPORTS = [
  { id: 'NFL', kind: 'spread', series: 'KXNFLSPREAD' },
  { id: 'NCAAF', kind: 'spread', series: 'KXNCAAFSPREAD' },
  { id: 'WNBA', kind: 'spread', series: 'KXWNBASPREAD' },
  { id: 'NBA', kind: 'spread', series: 'KXNBASPREAD' },
  { id: 'MLB', kind: 'ml', series: 'KXMLBGAME' },
  { id: 'NHL', kind: 'ml', series: 'KXNHLGAME' },
  { id: 'TENNIS', kind: 'ml', series: ['KXATPMATCH', 'KXWTAMATCH'] },
  {
    id: 'SOCCER',
    kind: 'ml3',
    series: [
      'KXEPLGAME',
      'KXMLSGAME',
      'KXLALIGAGAME',
      'KXBUNDESLIGAGAME',
      'KXSERIEAGAME',
      'KXLIGUE1GAME',
      'KXUCLGAME',
      'KXUELGAME',
      'KXUECLGAME',
      'KXNWSLGAME',
      'KXLIGAMXGAME',
    ],
  },
];

const cfg = {
  webhook: String(process.env.DISCORD_WEBHOOK_URL || '').trim(),
  userIds: String(process.env.DISCORD_USER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  delta: Math.max(1, Number(process.env.ALERT_DELTA_USD) || 100000),
  minSide: Math.max(0, Number(process.env.ALERT_MIN_SIDE_USD) || 0),
  cooldownMs: Math.max(0, Number(process.env.ALERT_COOLDOWN_MS) || 600000),
  pollMs: Math.max(15000, Number(process.env.POLL_MS) || 45000),
  sports: String(process.env.KALSHI_SPORTS || 'NFL,NCAAF,MLB,WNBA')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
};

const snapshot = new Map();
const lastAlertAt = new Map();
let seeded = false;
let cycle = 0;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function parseNum(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function canon(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function fmtMoney(n) {
  if (!Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1e6) return sign + '$' + (abs / 1e6).toFixed(2).replace(/\.00$/, '') + 'M';
  if (abs >= 1000) return sign + '$' + (abs / 1000).toFixed(abs >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return sign + '$' + Math.round(abs);
}

function fmtSpreadNum(n) {
  if (!Number.isFinite(n)) return '';
  const abs = Math.abs(n);
  const body = Number.isInteger(abs) ? String(abs) : abs.toFixed(1).replace(/\.0$/, '');
  if (n === 0) return 'pk';
  return (n > 0 ? '+' : '-') + body;
}

function marketLive(m) {
  const s = String((m && m.status) || '').toLowerCase();
  return s === 'active' || s === 'open';
}

function yesMid(m) {
  const bid = parseNum(m.yes_bid_dollars);
  const ask = parseNum(m.yes_ask_dollars);
  if (bid != null && ask != null) return (bid + ask) / 2;
  return bid != null ? bid : ask;
}

function tickerYesAbbr(ticker) {
  const last = String(ticker || '').split('-').pop() || '';
  return last.replace(/\d+$/, '');
}

function seriesListOf(sport) {
  return Array.isArray(sport.series) ? sport.series : [sport.series];
}

function seriesTickerOf(sport, ev) {
  return (ev && ev._series) || (Array.isArray(sport.series) ? sport.series[0] : sport.series);
}

function kalshiEventUrl(series, eventTicker) {
  if (!series || !eventTicker || Array.isArray(series)) return '';
  return (
    'https://kalshi.com/markets/' +
    String(series).toLowerCase() +
    '/' +
    String(eventTicker).toLowerCase()
  );
}

function parseEventTeams(ev) {
  const sub = String(ev.sub_title || '');
  const sm = sub.match(/^(.+?)\s+vs\s+(.+?)(?:\s*\(|$)/i);
  const awayAbbr = sm ? sm[1].trim() : '';
  const homeAbbr = sm ? sm[2].trim() : '';
  const title = String(ev.title || '')
    .replace(/:\s*Spread\s*$/i, '')
    .trim();
  const tm = title.match(/^(.+?)\s+vs\s+(.+)$/i);
  return {
    awayAbbr,
    homeAbbr,
    awayName: tm ? tm[1].trim() : awayAbbr,
    homeName: tm ? tm[2].trim() : homeAbbr,
  };
}

function namesMatch(a, b) {
  const ca = canon(a);
  const cb = canon(b);
  if (!ca || !cb) return false;
  if (ca === cb) return true;
  if (ca.length >= 3 && (cb.startsWith(ca) || ca.startsWith(cb))) return true;
  if (ca.length >= 4 && (cb.includes(ca) || ca.includes(cb))) return true;
  return false;
}

function yesIsAway(yesAbbr, yesTitle, teams) {
  const y = canon(yesAbbr);
  if (y && y === canon(teams.awayAbbr)) return true;
  if (y && y === canon(teams.homeAbbr)) return false;
  if (namesMatch(yesTitle, teams.awayName) || namesMatch(yesAbbr, teams.awayName)) return true;
  if (namesMatch(yesTitle, teams.homeName) || namesMatch(yesAbbr, teams.homeName)) return false;
  return null;
}

function pickMainSpread(markets) {
  const live = (markets || []).filter(marketLive);
  let best = null;
  let bestDist = Infinity;
  let bestOi = -1;
  live.forEach((m) => {
    const mid = yesMid(m);
    if (mid == null) return;
    const dist = Math.abs(mid - 0.5);
    const oi = parseNum(m.open_interest_fp) || 0;
    if (dist < bestDist - 0.005 || (Math.abs(dist - bestDist) <= 0.005 && oi > bestOi)) {
      best = m;
      bestDist = dist;
      bestOi = oi;
    }
  });
  return best;
}

function bookDollars(levels) {
  let dollars = 0;
  (levels || []).forEach((row) => {
    const price = parseNum(row && row[0]);
    const count = parseNum(row && row[1]);
    if (price == null || count == null || count <= 0) return;
    dollars += price * count;
  });
  return dollars;
}

function fallbackSpreadBooks(m) {
  const yesBid = parseNum(m.yes_bid_dollars) || 0;
  const yesAsk = parseNum(m.yes_ask_dollars) || 0;
  const yesBidSz = parseNum(m.yes_bid_size_fp) || 0;
  const yesAskSz = parseNum(m.yes_ask_size_fp) || 0;
  const noBid = parseNum(m.no_bid_dollars);
  return {
    yes: yesBid * yesBidSz,
    no: (noBid != null ? noBid : Math.max(0, 1 - yesAsk)) * yesAskSz,
  };
}

function fallbackMlBook(m) {
  const yesBid = parseNum(m.yes_bid_dollars) || 0;
  const yesBidSz = parseNum(m.yes_bid_size_fp) || 0;
  return yesBid * yesBidSz;
}

function marketForTeam(markets, abbr, name) {
  const live = (markets || []).filter(marketLive);
  return (
    live.find((m) => {
      const y = tickerYesAbbr(m.ticker);
      if (y === 'TIE') return false;
      return canon(y) === canon(abbr) || namesMatch(m.yes_sub_title, name);
    }) || null
  );
}

function marketForTie(markets) {
  return (
    (markets || []).filter(marketLive).find((m) => {
      const y = tickerYesAbbr(m.ticker);
      const title = canon(m.yes_sub_title);
      return y === 'TIE' || title === 'TIE' || title === 'DRAW';
    }) || null
  );
}

async function kalshiGetJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function mapPool(items, limit, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

async function fetchAllEvents(seriesTicker) {
  const events = [];
  let cursor = '';
  for (let i = 0; i < 8; i++) {
    let url =
      KALSHI_BASE +
      '/events?series_ticker=' +
      encodeURIComponent(seriesTicker) +
      '&status=open&with_nested_markets=true&limit=200';
    if (cursor) url += '&cursor=' + encodeURIComponent(cursor);
    const data = await kalshiGetJson(url);
    events.push.apply(events, data.events || []);
    cursor = data.cursor || '';
    if (!cursor) break;
  }
  return events;
}

async function fetchOrderbooks(tickers) {
  const out = {};
  const uniq = [];
  const seen = {};
  (tickers || []).forEach((t) => {
    if (!t || seen[t]) return;
    seen[t] = true;
    uniq.push(t);
  });
  const chunks = [];
  for (let i = 0; i < uniq.length; i += ORDERBOOK_CHUNK) {
    chunks.push(uniq.slice(i, i + ORDERBOOK_CHUNK));
  }
  await mapPool(chunks, HTTP_CONCURRENCY, async (chunk) => {
    const qs = chunk.map((t) => 'tickers=' + encodeURIComponent(t)).join('&');
    const data = await kalshiGetJson(KALSHI_BASE + '/markets/orderbooks?' + qs);
    (data.orderbooks || []).forEach((ob) => {
      if (ob && ob.ticker) out[ob.ticker] = ob.orderbook_fp || {};
    });
  });
  return out;
}

function sideFromSpread(m, books, teams) {
  const fp = books[m.ticker];
  const fromBook = fp
    ? { yes: bookDollars(fp.yes_dollars), no: bookDollars(fp.no_dollars) }
    : fallbackSpreadBooks(m);
  const yesAbbr = tickerYesAbbr(m.ticker);
  const yesAway = yesIsAway(yesAbbr, m.yes_sub_title, teams);
  const strike = parseNum(m.floor_strike);
  const favLine = strike != null ? -strike : null;
  const dogLine = strike != null ? strike : null;
  const yes = {
    key: 'yes',
    abbr: yesAbbr || (yesAway ? teams.awayAbbr : teams.homeAbbr),
    line: favLine,
    unfilled: fromBook.yes,
  };
  const noAbbr = yesAway === true ? teams.homeAbbr : yesAway === false ? teams.awayAbbr : '';
  const no = {
    key: 'no',
    abbr: noAbbr,
    line: dogLine,
    unfilled: fromBook.no,
  };
  const away = yesAway === false ? no : yes;
  const home = yesAway === false ? yes : no;
  return { away, home, yesAway, favLine };
}

function mlUnfilled(m, books) {
  if (!m) return 0;
  const fp = books[m.ticker];
  return fp ? bookDollars(fp.yes_dollars) : fallbackMlBook(m);
}

function buildRow(sport, ev, books) {
  const teams = parseEventTeams(ev);
  const series = seriesTickerOf(sport, ev);
  const url = kalshiEventUrl(series, ev.event_ticker);
  const matchup =
    (teams.awayName || teams.awayAbbr || 'Away') +
    ' @ ' +
    (teams.homeName || teams.homeAbbr || 'Home');

  if (sport.kind === 'spread') {
    const m = pickMainSpread(ev.markets || []);
    if (!m) return null;
    const sides = sideFromSpread(m, books, teams);
    return {
      sportId: sport.id,
      eventTicker: ev.event_ticker,
      matchup,
      url,
      line: sides.away.abbr
        ? sides.away.abbr + ' ' + (fmtSpreadNum(sides.favLine) || '').replace('−', '-')
        : 'Spread',
      sides: [
        { id: 'away', label: sides.away.abbr || teams.awayAbbr || 'Away', unfilled: sides.away.unfilled || 0 },
        { id: 'home', label: sides.home.abbr || teams.homeAbbr || 'Home', unfilled: sides.home.unfilled || 0 },
      ],
    };
  }

  const awayM = marketForTeam(ev.markets, teams.awayAbbr, teams.awayName);
  const homeM = marketForTeam(ev.markets, teams.homeAbbr, teams.homeName);
  if (!awayM && !homeM) return null;
  const sides = [
    {
      id: 'away',
      label: tickerYesAbbr((awayM && awayM.ticker) || '') || teams.awayAbbr || 'Away',
      unfilled: mlUnfilled(awayM, books),
    },
    {
      id: 'home',
      label: tickerYesAbbr((homeM && homeM.ticker) || '') || teams.homeAbbr || 'Home',
      unfilled: mlUnfilled(homeM, books),
    },
  ];
  if (sport.kind === 'ml3') {
    const drawM = marketForTie(ev.markets);
    sides.push({
      id: 'draw',
      label: 'TIE',
      unfilled: mlUnfilled(drawM, books),
    });
  }
  return {
    sportId: sport.id,
    eventTicker: ev.event_ticker,
    matchup,
    url,
    line: sport.kind === 'ml3' ? '1X2' : sport.id === 'TENNIS' ? 'Match' : 'ML',
    sides,
  };
}

async function loadSport(sport) {
  const packs = await mapPool(seriesListOf(sport), 2, async (series) => {
    try {
      const events = await fetchAllEvents(series);
      return { series, events };
    } catch (err) {
      log('events fail', sport.id, series, err.message || err);
      return { series, events: [] };
    }
  });
  const events = [];
  packs.forEach((p) => {
    (p.events || []).forEach((ev) => {
      ev._series = ev.series_ticker || p.series;
      events.push(ev);
    });
  });
  if (!events.length) return [];

  const tickers = [];
  events.forEach((ev) => {
    if (sport.kind === 'spread') {
      const m = pickMainSpread(ev.markets || []);
      if (m) tickers.push(m.ticker);
    } else {
      const teams = parseEventTeams(ev);
      const awayM = marketForTeam(ev.markets, teams.awayAbbr, teams.awayName);
      const homeM = marketForTeam(ev.markets, teams.homeAbbr, teams.homeName);
      if (awayM) tickers.push(awayM.ticker);
      if (homeM) tickers.push(homeM.ticker);
      if (sport.kind === 'ml3') {
        const drawM = marketForTie(ev.markets);
        if (drawM) tickers.push(drawM.ticker);
      }
    }
  });

  let books = {};
  try {
    books = await fetchOrderbooks(tickers);
  } catch (err) {
    log('books fail', sport.id, err.message || err);
  }

  return events.map((ev) => buildRow(sport, ev, books)).filter(Boolean);
}

async function loadAllRows() {
  const wanted = ALL_SPORTS.filter((s) => cfg.sports.includes(s.id));
  const rows = [];
  await mapPool(wanted, SPORT_CONCURRENCY, async (sport) => {
    const sportRows = await loadSport(sport);
    rows.push.apply(rows, sportRows);
  });
  return rows;
}

function mentionText() {
  return cfg.userIds.map((id) => '<@' + id + '>').join(' ');
}

async function postDiscord(content) {
  if (!cfg.webhook) throw new Error('DISCORD_WEBHOOK_URL is empty');
  const prefix = mentionText();
  const body = prefix ? prefix + '\n' + content : content;
  const res = await fetch(cfg.webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: body,
      allowed_mentions: cfg.userIds.length
        ? { parse: [], users: cfg.userIds }
        : { parse: [] },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('Discord ' + res.status + ' ' + text.slice(0, 200));
  }
}

function cooldownKey(row, side, kind) {
  return row.eventTicker + '|' + side.id + '|' + kind;
}

function cooled(key) {
  const at = lastAlertAt.get(key) || 0;
  return Date.now() - at < cfg.cooldownMs;
}

function markAlert(key) {
  lastAlertAt.set(key, Date.now());
}

function snapKey(row, side) {
  return row.eventTicker + '|' + side.id;
}

async function applyRows(rows) {
  const alerts = [];
  const seen = new Set();

  rows.forEach((row) => {
    row.sides.forEach((side) => {
      const key = snapKey(row, side);
      seen.add(key);
      const next = Number(side.unfilled) || 0;
      if (!seeded) {
        snapshot.set(key, next);
        return;
      }
      const prev = snapshot.has(key) ? snapshot.get(key) : next;
      snapshot.set(key, next);
      const delta = next - prev;
      if (Math.abs(delta) < cfg.delta) return;
      if (cfg.minSide > 0 && Math.max(prev, next) < cfg.minSide) return;
      const kind = delta > 0 ? 'appear' : 'drop';
      const ck = cooldownKey(row, side, kind);
      if (cooled(ck)) return;
      markAlert(ck);
      alerts.push({ row, side, prev, next, delta, kind });
    });
  });

  if (seeded) {
    snapshot.forEach((_, key) => {
      if (!seen.has(key)) snapshot.delete(key);
    });
  }

  for (const a of alerts) {
    const arrow = a.kind === 'appear' ? 'appeared' : 'dropped';
    const lines = [
      '**' + (a.kind === 'appear' ? 'Wall appeared' : 'Wall dropped') + '** · ' + a.row.sportId,
      a.row.matchup,
      a.row.line + ' · **' + a.side.label + '** unfilled ' + arrow,
      fmtMoney(a.prev) + ' → ' + fmtMoney(a.next) + '  (' + (a.delta > 0 ? '+' : '') + fmtMoney(a.delta) + ')',
      a.row.url || '',
    ].filter(Boolean);
    try {
      await postDiscord(lines.join('\n'));
      log('alert', a.kind, a.row.sportId, a.row.matchup, a.side.label, a.prev, '->', a.next);
    } catch (err) {
      log('discord fail', err.message || err);
    }
  }
  return alerts.length;
}

async function tick() {
  cycle += 1;
  const label = seeded ? 'poll' : 'seed';
  log(label, '#' + cycle, 'sports', cfg.sports.join(','));
  try {
    const rows = await loadAllRows();
    const n = await applyRows(rows);
    if (!seeded) {
      seeded = true;
      log('seeded', rows.length, 'games — next cycle will alert');
    } else {
      log('done', rows.length, 'games', n, 'alerts');
    }
  } catch (err) {
    log('tick fail', err.message || err);
  }
}

function startHealthServer() {
  const port = Number(process.env.PORT) || 3000;
  http
    .createServer((_, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('kalshi watcher ok cycle=' + cycle + ' seeded=' + seeded + '\n');
    })
    .listen(port, () => log('health http :' + port));
}

async function boot() {
  if (!cfg.webhook) {
    console.error('Set DISCORD_WEBHOOK_URL (channel webhook in your existing Discord server).');
    process.exit(1);
  }
  startHealthServer();
  try {
    await postDiscord(
      'Kalshi watcher is up. Watching **' +
        cfg.sports.join(', ') +
        '**. Posts if a side’s unfilled $ moves ±' +
        fmtMoney(cfg.delta) +
        '.'
    );
  } catch (err) {
    log('boot ping fail', err.message || err);
  }
  await tick();
  setInterval(tick, cfg.pollMs);
}

boot().catch((err) => {
  console.error(err);
  process.exit(1);
});
