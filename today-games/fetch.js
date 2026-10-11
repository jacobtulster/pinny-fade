'use strict';

/**
 * Unified "Today's Games" fetch — NFL, NCAAF, NHL, NBA, WNBA, NCAAB.
 *
 * Usage: node today-games/fetch.js
 *
 * Writes live slate to today-games-data.{json,js} and archives
 * today-games/history/YYYY-MM-DD.json (+ history/index.json) for GitHub Pages.
 *
 * Needs CFBD_API_KEY in repo-root .env for NCAAF season cover margins
 * (today's NCAAF odds still work via ESPN if CFBD is down).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_JSON = path.join(__dirname, 'today-games-data.json');
const OUT_JS = path.join(__dirname, 'today-games-data.js');
const HIST_DIR = path.join(__dirname, 'history');
const HIST_INDEX = path.join(HIST_DIR, 'index.json');
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
const CFBD = 'https://api.collegefootballdata.com';

const SPORTS = [
  {
    id: 'NFL',
    path: 'football/nfl',
    metric: 'spread',
    seasonType: 2,
  },
  {
    id: 'NCAAF',
    path: 'football/college-football',
    metric: 'spread',
    groups: '80',
    useCfbd: true,
    seasonType: 2,
  },
  {
    id: 'NHL',
    path: 'hockey/nhl',
    metric: 'mlEdge',
    seasonType: 2,
  },
  {
    id: 'MLB',
    path: 'baseball/mlb',
    metric: 'mlEdge',
    seasonType: 2,
  },
  {
    id: 'NBA',
    path: 'basketball/nba',
    metric: 'spread',
    seasonType: 2,
    fallbackPreseason: true,
  },
  {
    id: 'WNBA',
    path: 'basketball/wnba',
    metric: 'spread',
    seasonType: 2,
  },
  {
    id: 'NCAAB',
    path: 'basketball/mens-college-basketball',
    metric: 'spread',
    groups: '50',
    seasonType: 2,
    fallbackPreseason: true,
  },
];

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (process.env[k] == null || process.env[k] === '') process.env[k] = v;
  }
}

loadEnvFile(path.join(ROOT, '.env'));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function etDateString(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function etYmdCompact(d) {
  return etDateString(d).replace(/-/g, '');
}

/** Next calendar day in America/New_York (YYYY-MM-DD). */
function etNextDayString(ymd) {
  const parts = String(ymd || '').split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return ymd;
  const utc = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  utc.setUTCDate(utc.getUTCDate() + 1);
  return utc.toISOString().slice(0, 10);
}

function ymdToCompact(ymd) {
  return String(ymd || '').replace(/-/g, '');
}

function etKickoffLabel(iso) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(new Date(iso));
  } catch (_) {
    return iso || '';
  }
}

function parseAmerican(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = parseInt(String(v).replace(/[^\d+-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function fmtAmerican(n) {
  if (n == null || !Number.isFinite(n)) return null;
  return n > 0 ? '+' + n : String(n);
}

function rawImplied(american) {
  if (american == null || !Number.isFinite(american) || american === 0) {
    return null;
  }
  if (american < 0) return (-american) / (-american + 100);
  return 100 / (american + 100);
}

function vigFreePair(awayMl, homeMl) {
  const a = rawImplied(awayMl);
  const h = rawImplied(homeMl);
  if (a == null || h == null || a + h <= 0) return { away: null, home: null };
  return { away: a / (a + h), home: h / (a + h) };
}

function gameEdge(gd, winProb) {
  if (winProb == null || !(winProb > 0) || !(winProb < 1)) return null;
  if (!Number.isFinite(gd) || gd === 0) return null;
  if (gd > 0) return gd / winProb;
  return gd / (1 - winProb);
}

function parseScore(raw) {
  if (raw == null) return NaN;
  if (typeof raw === 'object') {
    return Number(raw.value != null ? raw.value : raw.displayValue);
  }
  return Number(raw);
}

async function espnGet(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('ESPN ' + res.status + ': ' + body.slice(0, 120));
  }
  return res.json();
}

async function cfbdGet(apiPath, key, retries) {
  let lastErr = null;
  const n = retries == null ? 2 : retries;
  for (let attempt = 0; attempt <= n; attempt++) {
    const res = await fetch(CFBD + apiPath, {
      headers: {
        Authorization: 'Bearer ' + key,
        Accept: 'application/json',
      },
    });
    if (res.ok) return res.json();
    const body = await res.text().catch(() => '');
    lastErr = new Error('CFBD ' + res.status + ' ' + apiPath);
    if (res.status >= 500 || res.status === 429) {
      await sleep(700 * (attempt + 1));
      continue;
    }
    break;
  }
  throw lastErr;
}

async function mapPool(items, limit, fn) {
  let i = 0;
  const out = new Array(items.length);
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  const n = Math.min(Math.max(1, limit), Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

function defaultEspnSeasonYear(sportId, now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth();
  // NHL/NBA: season labeled by ending spring year
  if (sportId === 'NHL' || sportId === 'NBA') {
    return m >= 6 ? y + 1 : y;
  }
  // MLB / WNBA: calendar season year
  if (sportId === 'MLB' || sportId === 'WNBA') return y;
  if (sportId === 'NCAAB') return m >= 9 ? y + 1 : m <= 3 ? y : y;
  return y; // NFL, NCAAF
}

function parseCompetitor(comp) {
  const team = comp.team || {};
  return {
    id: String(team.id || ''),
    name: team.displayName || team.name || '',
    abbrev: team.abbreviation || '',
    score: parseScore(comp.score),
    homeAway: comp.homeAway,
    winner: !!comp.winner,
  };
}

async function fetchDayEvents(sport, dayCompact) {
  let url =
    ESPN + '/' + sport.path + '/scoreboard?dates=' + dayCompact;
  if (sport.groups) url += '&groups=' + sport.groups;
  const j = await espnGet(url);
  const rows = [];
  for (const ev of j.events || []) {
    const c = (ev.competitions || [])[0];
    if (!c) continue;
    const st = c.status && c.status.type;
    const comps = (c.competitors || []).map(parseCompetitor);
    const home = comps.find((x) => x.homeAway === 'home');
    const away = comps.find((x) => x.homeAway === 'away');
    if (!home || !away) continue;
    rows.push({
      sport: sport.id,
      gameId: String(ev.id),
      startDate: ev.date || c.date || c.startDate,
      kickoffEt: etKickoffLabel(ev.date || c.date || c.startDate),
      awayTeam: away.name,
      homeTeam: home.name,
      awayId: away.id,
      homeId: home.id,
      awayAbbrev: away.abbrev,
      homeAbbrev: home.abbrev,
      awayScore: Number.isFinite(away.score) ? away.score : null,
      homeScore: Number.isFinite(home.score) ? home.score : null,
      completed: !!(st && st.completed),
      status: (st && (st.shortDetail || st.description || st.name)) || '',
      state: (st && st.state) || '',
    });
  }
  return rows;
}

async function fetchSummaryOdds(sportPath, gameId) {
  try {
    const j = await espnGet(
      ESPN + '/' + sportPath + '/summary?event=' + gameId
    );
    const pc = (j.pickcenter || [])[0];
    if (!pc) return null;
    const awayOdds = pc.awayTeamOdds || {};
    const homeOdds = pc.homeTeamOdds || {};
    let homeSpread = null;
    if (pc.spread != null && Number.isFinite(Number(pc.spread))) {
      const mag = Math.abs(Number(pc.spread));
      if (homeOdds.favorite) homeSpread = -mag;
      else if (awayOdds.favorite) homeSpread = mag;
      else homeSpread = Number(pc.spread);
    }
    return {
      provider: (pc.provider && pc.provider.name) || 'ESPN',
      details: pc.details || null,
      homeSpread,
      awaySpread: homeSpread == null ? null : -homeSpread,
      awayMl: parseAmerican(awayOdds.moneyLine),
      homeMl: parseAmerican(homeOdds.moneyLine),
      overUnder: pc.overUnder != null ? Number(pc.overUnder) : null,
    };
  } catch (_) {
    return null;
  }
}

async function fetchCoreMlOdds(leaguePath, gameId) {
  try {
    const url =
      'https://sports.core.api.espn.com/v2/sports/' +
      leaguePath +
      '/events/' +
      gameId +
      '/competitions/' +
      gameId +
      '/odds';
    const j = await espnGet(url);
    const item = (j.items || [])[0];
    if (!item) return null;
    const extract = (side) => {
      if (!side) return null;
      const close = side.close && side.close.moneyLine;
      if (close) {
        const a = parseAmerican(
          close.alternateDisplayValue || close.american
        );
        if (a != null) return a;
      }
      return parseAmerican(side.moneyLine);
    };
    return {
      provider: (item.provider && item.provider.name) || 'ESPN',
      details: item.details || null,
      awayMl: extract(item.awayTeamOdds),
      homeMl: extract(item.homeTeamOdds),
      homeSpread: null,
      awaySpread: null,
      overUnder: item.overUnder != null ? Number(item.overUnder) : null,
    };
  } catch (_) {
    return null;
  }
}

async function fetchGameOdds(sport, gameId) {
  if (sport.id === 'NHL') {
    const core = await fetchCoreMlOdds('hockey/leagues/nhl', gameId);
    if (core) return core;
  }
  if (sport.id === 'MLB') {
    const core = await fetchCoreMlOdds('baseball/leagues/mlb', gameId);
    if (core) return core;
  }
  return fetchSummaryOdds(sport.path, gameId);
}

/** Grade the hotter side after the game finishes. */
function gradeHotterResult(g, metric, odds) {
  if (!g.completed) return null;
  if (!g.edgeSide || g.edgeTeam === 'tie') return null;
  if (g.awayScore == null || g.homeScore == null) return null;
  if (!Number.isFinite(g.awayScore) || !Number.isFinite(g.homeScore)) {
    return null;
  }

  if (metric === 'mlEdge') {
    if (g.awayScore === g.homeScore) return 'P';
    const hotterWon =
      g.edgeSide === 'away'
        ? g.awayScore > g.homeScore
        : g.homeScore > g.awayScore;
    return hotterWon ? 'W' : 'L';
  }

  // Spread sports: did the hotter team cover?
  const homeSpread =
    odds && odds.homeSpread != null
      ? Number(odds.homeSpread)
      : g.homeSpread != null
        ? Number(g.homeSpread)
        : null;
  if (homeSpread == null || !Number.isFinite(homeSpread)) return null;
  const teamSpread = g.edgeSide === 'away' ? -homeSpread : homeSpread;
  const teamScore = g.edgeSide === 'away' ? g.awayScore : g.homeScore;
  const oppScore = g.edgeSide === 'away' ? g.homeScore : g.awayScore;
  const cover = teamScore - oppScore + teamSpread;
  if (Math.abs(cover) < 1e-9) return 'P';
  return cover > 0 ? 'W' : 'L';
}

async function fetchTeams(sport) {
  const j = await espnGet(ESPN + '/' + sport.path + '/teams?limit=400');
  const league = (((j.sports || [])[0] || {}).leagues || [])[0] || {};
  return (league.teams || [])
    .map((r) => r.team || r)
    .filter((t) => t && t.id)
    .map((t) => ({
      id: String(t.id),
      name: t.displayName || t.name || '',
      abbrev: t.abbreviation || '',
    }));
}

async function collectCompletedGames(sport, seasonYear) {
  const teams = await fetchTeams(sport);
  const byId = new Map();

  async function pull(seasonType) {
    await mapPool(teams, 6, async (t) => {
      const url =
        ESPN +
        '/' +
        sport.path +
        '/teams/' +
        t.id +
        '/schedule?season=' +
        seasonYear +
        '&seasontype=' +
        seasonType;
      try {
        const j = await espnGet(url);
        for (const ev of j.events || []) {
          const c = (ev.competitions || [])[0];
          if (!c) continue;
          const st = c.status && c.status.type;
          if (!st || !st.completed) continue;
          const id = String(ev.id);
          if (byId.has(id)) continue;
          const comps = (c.competitors || []).map(parseCompetitor);
          const home = comps.find((x) => x.homeAway === 'home');
          const away = comps.find((x) => x.homeAway === 'away');
          if (!home || !away) continue;
          if (!Number.isFinite(home.score) || !Number.isFinite(away.score)) {
            continue;
          }
          byId.set(id, {
            gameId: id,
            startDate: ev.date || c.date,
            away,
            home,
          });
        }
      } catch (_) {}
    });
  }

  await pull(sport.seasonType || 2);
  if (byId.size === 0 && sport.fallbackPreseason) {
    await pull(1);
  }
  return { teams, games: Array.from(byId.values()) };
}

function accumulateSpreadStats(gamesWithOdds) {
  const map = new Map();
  function ensure(id, name, abbrev) {
    if (!map.has(id)) {
      map.set(id, {
        teamId: id,
        team: name,
        abbrev: abbrev || '',
        games: 0,
        wins: 0,
        losses: 0,
        pushes: 0,
        coverSum: 0,
        coverCount: 0,
      });
    }
    return map.get(id);
  }

  for (const g of gamesWithOdds) {
    if (!g.odds || g.odds.homeSpread == null) continue;
    const hs = Number(g.odds.homeSpread);
    const as = -hs;
    const awayGd = g.away.score - g.home.score;
    const homeGd = g.home.score - g.away.score;
    const awayCover = awayGd + as;
    const homeCover = homeGd + hs;

    const a = ensure(g.away.id, g.away.name, g.away.abbrev);
    const h = ensure(g.home.id, g.home.name, g.home.abbrev);
    a.games++;
    h.games++;

    function apply(row, cover) {
      row.coverSum += cover;
      row.coverCount++;
      if (Math.abs(cover) < 1e-9) row.pushes++;
      else if (cover > 0) row.wins++;
      else row.losses++;
    }
    apply(a, awayCover);
    apply(h, homeCover);
  }

  return Array.from(map.values())
    .map((t) => ({
      teamId: t.teamId,
      team: t.team,
      abbrev: t.abbrev,
      games: t.games,
      atsWins: t.wins,
      atsLosses: t.losses,
      atsPushes: t.pushes,
      avg: t.coverCount
        ? Math.round((t.coverSum / t.coverCount) * 100) / 100
        : null,
    }))
    .filter((t) => t.games > 0);
}

function accumulateMlEdgeStats(gamesWithOdds) {
  const map = new Map();
  function ensure(id, name, abbrev) {
    if (!map.has(id)) {
      map.set(id, {
        teamId: id,
        team: name,
        abbrev: abbrev || '',
        games: 0,
        wins: 0,
        losses: 0,
        edgeSum: 0,
        edgeCount: 0,
      });
    }
    return map.get(id);
  }

  for (const g of gamesWithOdds) {
    const probs = vigFreePair(
      g.odds && g.odds.awayMl,
      g.odds && g.odds.homeMl
    );
    const awayGd = g.away.score - g.home.score;
    const homeGd = g.home.score - g.away.score;
    const awayEdge = gameEdge(awayGd, probs.away);
    const homeEdge = gameEdge(homeGd, probs.home);
    const a = ensure(g.away.id, g.away.name, g.away.abbrev);
    const h = ensure(g.home.id, g.home.name, g.home.abbrev);
    a.games++;
    h.games++;
    if (awayGd > 0) a.wins++;
    else a.losses++;
    if (homeGd > 0) h.wins++;
    else h.losses++;
    if (awayEdge != null) {
      a.edgeSum += awayEdge;
      a.edgeCount++;
    }
    if (homeEdge != null) {
      h.edgeSum += homeEdge;
      h.edgeCount++;
    }
  }

  return Array.from(map.values())
    .map((t) => ({
      teamId: t.teamId,
      team: t.team,
      abbrev: t.abbrev,
      games: t.games,
      wins: t.wins,
      losses: t.losses,
      avg: t.edgeCount
        ? Math.round((t.edgeSum / t.edgeCount) * 100) / 100
        : null,
    }))
    .filter((t) => t.games > 0);
}

async function buildEspnSeasonAverages(sport, seasonYear) {
  console.log('  [' + sport.id + '] collecting completed games…');
  let { games } = await collectCompletedGames(sport, seasonYear);
  console.log('  [' + sport.id + '] completed:', games.length);
  if (!games.length) return new Map();

  // Cap huge slates (full MLB season) so refreshes stay practical.
  const MAX_GAMES = sport.id === 'MLB' ? 400 : 500;
  if (games.length > MAX_GAMES) {
    games = games
      .slice()
      .sort((a, b) => String(b.startDate).localeCompare(String(a.startDate)))
      .slice(0, MAX_GAMES);
    console.log(
      '  [' + sport.id + '] using most recent',
      games.length,
      'for averages'
    );
  }

  console.log('  [' + sport.id + '] fetching odds…');
  const graded = await mapPool(games, 8, async (g, idx) => {
    if ((idx + 1) % 40 === 0) {
      console.log('  [' + sport.id + '] odds', idx + 1 + '/' + games.length);
    }
    const odds = await fetchGameOdds(sport, g.gameId);
    return Object.assign({}, g, { odds });
  });

  const stats =
    sport.metric === 'mlEdge'
      ? accumulateMlEdgeStats(graded)
      : accumulateSpreadStats(
          graded.filter((g) => g.odds && g.odds.homeSpread != null)
        );

  console.log('  [' + sport.id + '] teams with avg:', stats.length);
  return new Map(stats.map((t) => [t.teamId, t]));
}

async function buildCfbdNcaafAverages(year, key) {
  const [ats, allTeams] = await Promise.all([
    cfbdGet('/teams/ats?year=' + year, key, 3),
    cfbdGet('/teams?year=' + year, key, 2),
  ]);
  const fbsIds = new Set();
  for (const t of allTeams || []) {
    if (t && t.id != null && String(t.classification).toLowerCase() === 'fbs') {
      fbsIds.add(t.id);
    }
  }
  const byName = new Map();
  for (const row of ats || []) {
    if (!row || !fbsIds.has(row.teamId)) continue;
    const wins = Number(row.atsWins) || 0;
    const losses = Number(row.atsLosses) || 0;
    const pushes = Number(row.atsPushes) || 0;
    const rec = {
      teamId: 'cfbd-' + row.teamId,
      team: row.team || '',
      abbrev: '',
      games: Number(row.games) || 0,
      atsWins: wins,
      atsLosses: losses,
      atsPushes: pushes,
      avg:
        row.avgCoverMargin == null || row.avgCoverMargin === ''
          ? null
          : Number(row.avgCoverMargin),
    };
    if (rec.team) byName.set(rec.team.toLowerCase(), rec);
  }
  return byName;
}

function lookupTeam(statMap, id, name, isCfbdNameMap) {
  if (!statMap) return null;
  if (!isCfbdNameMap && id && statMap.has(id)) return statMap.get(id);
  const n = String(name || '').toLowerCase();
  if (statMap.has(n)) return statMap.get(n);
  for (const [k, v] of statMap) {
    if (typeof k !== 'string') continue;
    if (!k || !n) continue;
    if (k.indexOf(n) >= 0 || n.indexOf(k) >= 0) return v;
  }
  return null;
}

function oddsLabel(sport, odds) {
  if (!odds) return null;
  if (sport.metric === 'mlEdge') {
    const a = fmtAmerican(odds.awayMl);
    const h = fmtAmerican(odds.homeMl);
    if (a && h) return a + ' / ' + h;
    return odds.details || null;
  }
  return odds.details || null;
}

function mlLabel(odds) {
  if (!odds) return null;
  const a = fmtAmerican(odds.awayMl);
  const h = fmtAmerican(odds.homeMl);
  if (a && h) return a + ' / ' + h;
  return null;
}

function sortGamesByTime(games) {
  return games.slice().sort((a, b) => {
    const at = a.startDate || '';
    const bt = b.startDate || '';
    if (at !== bt) return at < bt ? -1 : 1;
    const ag = a.gap;
    const bg = b.gap;
    if (ag == null && bg == null) return 0;
    if (ag == null) return 1;
    if (bg == null) return -1;
    return bg - ag;
  });
}

async function fetchSlateBySport(dayCompact, label) {
  const bySport = {};
  await mapPool(SPORTS, 3, async (sport) => {
    try {
      bySport[sport.id] = await fetchDayEvents(sport, dayCompact);
      console.log(
        '  [' + label + ']',
        sport.id + ':',
        bySport[sport.id].length,
        'games'
      );
    } catch (e) {
      console.warn('  [' + label + ']', sport.id, 'fail', e.message || e);
      bySport[sport.id] = [];
    }
  });
  return bySport;
}

async function attachOddsAndAvgs(bySport, seasonMaps) {
  const games = [];
  for (const sport of SPORTS) {
    const slate = bySport[sport.id] || [];
    if (!slate.length) continue;
    const season = seasonMaps[sport.id] || { map: new Map(), byName: false };
    const oddsList = await mapPool(slate, 8, async (g) =>
      fetchGameOdds(sport, g.gameId)
    );

    slate.forEach((g, i) => {
      const odds = oddsList[i];
      const awayStat = lookupTeam(
        season.map,
        g.awayId,
        g.awayTeam,
        season.byName
      );
      const homeStat = lookupTeam(
        season.map,
        g.homeId,
        g.homeTeam,
        season.byName
      );
      const awayAvg = awayStat && awayStat.avg != null ? awayStat.avg : null;
      const homeAvg = homeStat && homeStat.avg != null ? homeStat.avg : null;
      let gap = null;
      let edgeTeam = null;
      let edgeSide = null;
      if (awayAvg != null && homeAvg != null) {
        gap = Math.round(Math.abs(awayAvg - homeAvg) * 100) / 100;
        if (awayAvg > homeAvg) {
          edgeTeam = g.awayTeam;
          edgeSide = 'away';
        } else if (homeAvg > awayAvg) {
          edgeTeam = g.homeTeam;
          edgeSide = 'home';
        } else edgeTeam = 'tie';
      }

      const row = {
        sport: sport.id,
        metric: sport.metric,
        gameId: g.gameId,
        startDate: g.startDate,
        kickoffEt: g.kickoffEt,
        awayTeam: g.awayTeam,
        homeTeam: g.homeTeam,
        awayAbbrev: g.awayAbbrev,
        homeAbbrev: g.homeAbbrev,
        awayAvg,
        homeAvg,
        gap,
        edgeTeam,
        edgeSide,
        line: oddsLabel(sport, odds),
        ml: mlLabel(odds),
        awayMl: odds ? odds.awayMl : null,
        homeMl: odds ? odds.homeMl : null,
        homeSpread: odds ? odds.homeSpread : null,
        awaySpread: odds ? odds.awaySpread : null,
        oddsProvider: odds ? odds.provider : null,
        overUnder: odds ? odds.overUnder : null,
        completed: g.completed,
        status: g.status,
        state: g.state,
        awayScore: g.awayScore,
        homeScore: g.homeScore,
      };
      row.hotterResult = gradeHotterResult(row, sport.metric, odds);
      games.push(row);
    });
  }
  return sortGamesByTime(games);
}

async function main() {
  const now = new Date();
  const todayEt = etDateString(now);
  const tomorrowEt = etNextDayString(todayEt);
  const todayCompact = ymdToCompact(todayEt);
  const tomorrowCompact = ymdToCompact(tomorrowEt);
  const cfbdKey = (process.env.CFBD_API_KEY || '').trim();

  console.log('Games fetch — today', todayEt, '· tomorrow', tomorrowEt, '(ET)');

  // 1) Slates for today + tomorrow
  console.log('Fetching today slate…');
  const todayBySport = await fetchSlateBySport(todayCompact, 'today');
  console.log('Fetching tomorrow slate…');
  const tomorrowBySport = await fetchSlateBySport(tomorrowCompact, 'tomorrow');

  // 2) Season averages for any sport on either day
  const seasonMaps = {};
  const sportsWithGames = SPORTS.filter(
    (s) =>
      (todayBySport[s.id] || []).length > 0 ||
      (tomorrowBySport[s.id] || []).length > 0
  );

  for (const sport of sportsWithGames) {
    const seasonYear = defaultEspnSeasonYear(sport.id, now);
    try {
      if (sport.useCfbd && cfbdKey) {
        const cfbYear = defaultYearCfb(now);
        console.log('  [' + sport.id + '] CFBD ATS…', cfbYear);
        seasonMaps[sport.id] = {
          map: await buildCfbdNcaafAverages(cfbYear, cfbdKey),
          byName: true,
          seasonYear: cfbYear,
        };
      } else if (sport.useCfbd && !cfbdKey) {
        console.warn('  [' + sport.id + '] no CFBD_API_KEY — ESPN spread avgs');
        seasonMaps[sport.id] = {
          map: await buildEspnSeasonAverages(sport, seasonYear),
          byName: false,
          seasonYear,
        };
      } else {
        seasonMaps[sport.id] = {
          map: await buildEspnSeasonAverages(sport, seasonYear),
          byName: false,
          seasonYear,
        };
      }
    } catch (e) {
      console.warn('  [' + sport.id + '] season fail', e.message || e);
      seasonMaps[sport.id] = { map: new Map(), byName: false, seasonYear };
    }
  }

  // 3) Attach odds + season avgs
  console.log('Attaching odds — today…');
  const todayGames = await attachOddsAndAvgs(todayBySport, seasonMaps);
  console.log('Attaching odds — tomorrow…');
  const tomorrowGames = await attachOddsAndAvgs(tomorrowBySport, seasonMaps);

  const todaySports = SPORTS.map((s) => s.id).filter(
    (id) => (todayBySport[id] || []).length > 0
  );
  const tomorrowSports = SPORTS.map((s) => s.id).filter(
    (id) => (tomorrowBySport[id] || []).length > 0
  );

  const payload = {
    todayEt,
    tomorrowEt,
    fetchedAt: new Date().toISOString(),
    sportsPresent: todaySports,
    tomorrowSportsPresent: tomorrowSports,
    metricNotes: {
      spread:
        'avg cover margin vs closing/current spread (score margin + team spread); finished hotter = ATS W/P/L',
      mlEdge:
        'avg GD/p (win) or GD/(1-p) (loss) vs vig-free close ML; finished hotter = moneyline W/L',
    },
    // backward-compatible alias for today
    games: todayGames,
    today: { dateEt: todayEt, sportsPresent: todaySports, games: todayGames },
    tomorrow: {
      dateEt: tomorrowEt,
      sportsPresent: tomorrowSports,
      games: tomorrowGames,
    },
  };

  // Preserve prior slate day if the rolling file is about to roll forward.
  archiveExistingIfRollover(todayEt);
  writeDayArchive(payload);
  writeLiveFiles(payload);

  console.log(
    'Wrote today',
    todayGames.length,
    '(' + (todaySports.join(', ') || 'none') + ') · tomorrow',
    tomorrowGames.length,
    '(' + (tomorrowSports.join(', ') || 'none') + ') →',
    OUT_JSON
  );
  console.log('Archived →', path.join(HIST_DIR, todayEt + '.json'));
}

function readExistingPayload() {
  try {
    if (fs.existsSync(OUT_JSON)) {
      return JSON.parse(fs.readFileSync(OUT_JSON, 'utf8'));
    }
  } catch (_) {
    /* ignore */
  }
  try {
    if (!fs.existsSync(OUT_JS)) return null;
    const src = fs.readFileSync(OUT_JS, 'utf8');
    const m = src.match(/window\.__TODAY_GAMES_DATA__\s*=\s*([\s\S]*);\s*$/);
    if (!m) return null;
    return JSON.parse(m[1]);
  } catch (_) {
    return null;
  }
}

function archiveExistingIfRollover(newTodayEt) {
  const prev = readExistingPayload();
  if (!prev || !prev.todayEt) return;
  if (prev.todayEt === newTodayEt) return;
  const dest = path.join(HIST_DIR, prev.todayEt + '.json');
  if (fs.existsSync(dest)) return;
  writeDayArchive(prev);
  console.log('Preserved prior day →', dest);
}

function writeDayArchive(payload) {
  if (!payload || !payload.todayEt) return;
  fs.mkdirSync(HIST_DIR, { recursive: true });
  const dest = path.join(HIST_DIR, payload.todayEt + '.json');
  fs.writeFileSync(dest, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  updateHistoryIndex(payload.todayEt);
}

function updateHistoryIndex(dateEt) {
  fs.mkdirSync(HIST_DIR, { recursive: true });
  let days = [];
  try {
    if (fs.existsSync(HIST_INDEX)) {
      const idx = JSON.parse(fs.readFileSync(HIST_INDEX, 'utf8'));
      if (Array.isArray(idx.days)) days = idx.days.slice();
    }
  } catch (_) {
    days = [];
  }
  if (!days.includes(dateEt)) days.push(dateEt);
  days = [...new Set(days)].sort();
  fs.writeFileSync(
    HIST_INDEX,
    JSON.stringify({ days }, null, 2) + '\n',
    'utf8'
  );
}

function writeLiveFiles(payload) {
  fs.writeFileSync(OUT_JSON, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  fs.writeFileSync(
    OUT_JS,
    'window.__TODAY_GAMES_DATA__ = ' + JSON.stringify(payload) + ';\n',
    'utf8'
  );
}

function defaultYearCfb(now = new Date()) {
  const y = now.getFullYear();
  if (now.getMonth() <= 1) return y - 1;
  return y;
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
