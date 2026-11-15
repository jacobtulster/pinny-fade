/**
 * One-shot: backfill consensus fav spreads from ESPN (when possible) and
 * hard-grade coverTeamIdx / favCovered / gradeKind on legacy Book League snaps.
 *
 * Usage: node scripts/backfill-legacy-ats.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '..', 'book-league', 'book-league-data.js');
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
const CORE = 'https://sports.core.api.espn.com/v2/sports';

const SPORT_META = {
  MLB: { path: 'baseball/mlb', core: 'baseball/leagues/mlb' },
  NHL: { path: 'hockey/nhl', core: 'hockey/leagues/nhl' },
  NFL: { path: 'football/nfl', core: 'football/leagues/nfl' },
  NCAAF: {
    path: 'football/college-football',
    core: 'football/leagues/college-football',
    groups: ['80', '81', null],
  },
  NBA: { path: 'basketball/nba', core: 'basketball/leagues/nba' },
  WNBA: { path: 'basketball/wnba', core: 'basketball/leagues/wnba' },
  NCAAB: {
    path: 'basketball/mens-college-basketball',
    core: 'basketball/leagues/mens-college-basketball',
    groups: ['50', null],
  },
};

const boardCache = new Map(); // key -> events[]
const oddsCache = new Map(); // eventId|core -> odds json | null
let fetchCount = 0;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url) {
  fetchCount++;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'pinny-fade-backfill/1.0' },
  });
  if (!res.ok) return null;
  return res.json();
}

function normTeam(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(university|univ|the|club|fc)\b/g, ' ')
    .replace(/\bst\b/g, 'state')
    .replace(/\s+/g, ' ')
    .trim();
}

function teamsMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a))) return true;
  const wa = a.split(' ').filter(Boolean);
  const wb = b.split(' ').filter(Boolean);
  if (wa.length && wb.length) {
    const setB = new Set(wb);
    let hit = 0;
    for (const w of wa) if (setB.has(w)) hit++;
    if (hit >= 1 && hit / Math.max(wa.length, wb.length) >= 0.5) return true;
  }
  return false;
}

function isMoneylineMarket(s) {
  return /money\s*line|^ml$/i.test(String((s && s.market) || ''));
}

function favTeamIndex(s) {
  const teams = Array.isArray(s && s.teams) ? s.teams : [];
  if (s && s.favTeam) {
    const i = teams.findIndex((t) => t === s.favTeam);
    if (i === 0 || i === 1) return i;
  }
  if (s && (s.favSide === 0 || s.favSide === 1)) return s.favSide;
  return null;
}

function looksLikeSoccer(s) {
  const sport = String((s && s.sport) || '').toLowerCase();
  if (sport === 'soccer' || sport === 'hot') return true;
  const lg = String((s && s.league) || '');
  return /CHAMPIONS|EUROPA|PREMIER|LA\s*LIGA|SERIE\s*A|LIGUE|BUNDESLIGA|MLS|NATIONS|FRIENDL/i.test(
    lg
  );
}

function sportKeyFromSnap(s) {
  const league = String((s && s.league) || '').toUpperCase();
  const sport = String((s && s.sport) || '').toLowerCase();
  if (looksLikeSoccer(s)) return 'SOCCER';
  if (/MLB/i.test(league) || sport === 'baseball' || sport === 'mlb') return 'MLB';
  if (/NHL/i.test(league) || sport === 'hockey' || sport === 'nhl') return 'NHL';
  if (/NCAAF|CFB|FCS/i.test(league) || sport === 'ncaaf') return 'NCAAF';
  if (/NCAAB|CBB|EXTRAS/i.test(league) || sport === 'ncaab') return 'NCAAB';
  if (/WNBA/i.test(league) || sport === 'wnba') return 'WNBA';
  if (/NFL/i.test(league) || sport === 'nfl') return 'NFL';
  if (/\bNBA\b/i.test(league) || sport === 'nba') return 'NBA';
  if (sport === 'football') return /NCAAF|CFB|FCS/i.test(league) ? 'NCAAF' : 'NFL';
  if (sport === 'basketball') return /NCAAB|CBB/i.test(league) ? 'NCAAB' : 'NBA';
  return null;
}

function sportKeysToTry(s) {
  const k = sportKeyFromSnap(s);
  if (k && k !== 'SOCCER') return [k];
  if (k === 'SOCCER') return ['SOCCER'];
  const sport = String((s && s.sport) || '').toLowerCase();
  if (sport === 'football') return ['NCAAF', 'NFL'];
  if (sport === 'basketball') return ['NCAAB', 'NBA', 'WNBA'];
  return ['NFL', 'NCAAF', 'NBA', 'NCAAB', 'NHL', 'MLB'];
}

function ymdCompactFromTs(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return null;
  const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return (
    et.getFullYear() +
    String(et.getMonth() + 1).padStart(2, '0') +
    String(et.getDate()).padStart(2, '0')
  );
}

function shiftYmd(ymd, delta) {
  if (!ymd || String(ymd).length !== 8) return null;
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(4, 6));
  const d = Number(ymd.slice(6, 8));
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return (
    dt.getUTCFullYear() +
    String(dt.getUTCMonth() + 1).padStart(2, '0') +
    String(dt.getUTCDate()).padStart(2, '0')
  );
}

function daysToTry(s) {
  const primary = ymdCompactFromTs(s.startAt != null ? s.startAt : s.at);
  const snapDay = ymdCompactFromTs(s.at);
  const out = [];
  const seen = new Set();
  function add(day) {
    if (!day || seen.has(day)) return;
    seen.add(day);
    out.push(day);
  }
  add(primary);
  add(snapDay);
  if (primary) {
    add(shiftYmd(primary, -1));
    add(shiftYmd(primary, 1));
  }
  return out;
}

function parseBoardEvents(j) {
  const out = [];
  for (const ev of (j && j.events) || []) {
    const c = (ev.competitions || [])[0];
    if (!c) continue;
    const comps = c.competitors || [];
    const home = comps.find((x) => x.homeAway === 'home');
    const away = comps.find((x) => x.homeAway === 'away');
    if (!home || !away) continue;
    const st = c.status && c.status.type;
    const awayScore = Number(away.score);
    const homeScore = Number(home.score);
    out.push({
      eventId: String(ev.id),
      competitionId: String(c.id || ev.id),
      completed: !!(st && st.completed),
      status: (st && (st.shortDetail || st.description || st.name)) || '',
      awayName: (away.team && (away.team.displayName || away.team.name)) || '',
      homeName: (home.team && (home.team.displayName || home.team.name)) || '',
      awayCanon: normTeam((away.team && (away.team.displayName || away.team.name)) || ''),
      homeCanon: normTeam((home.team && (home.team.displayName || home.team.name)) || ''),
      awayShort: normTeam((away.team && away.team.shortDisplayName) || ''),
      homeShort: normTeam((home.team && home.team.shortDisplayName) || ''),
      awayAbbr: normTeam((away.team && away.team.abbreviation) || ''),
      homeAbbr: normTeam((home.team && home.team.abbreviation) || ''),
      awayScore: Number.isFinite(awayScore) ? awayScore : null,
      homeScore: Number.isFinite(homeScore) ? homeScore : null,
    });
  }
  return out;
}

async function loadBoard(sportKey, dateCompact, group) {
  const meta = SPORT_META[sportKey];
  if (!meta) return [];
  const cacheKey = sportKey + '|' + dateCompact + '|' + String(group);
  if (boardCache.has(cacheKey)) return boardCache.get(cacheKey);
  let url = ESPN + '/' + meta.path + '/scoreboard?dates=' + dateCompact;
  if (group) url += '&groups=' + group;
  const j = await fetchJson(url);
  const events = parseBoardEvents(j);
  boardCache.set(cacheKey, events);
  await sleep(40);
  return events;
}

function sideMatch(boardTeam, evCanon, evAbbr, evShort) {
  const t = normTeam(boardTeam);
  return (
    teamsMatch(t, evCanon) ||
    teamsMatch(t, evShort) ||
    teamsMatch(t, evAbbr) ||
    (evAbbr && t === evAbbr)
  );
}

function matchEvent(s, events) {
  const teams = s.teams || [];
  const a = teams[0];
  const h = teams[1];
  for (const e of events) {
    if (
      sideMatch(a, e.awayCanon, e.awayAbbr, e.awayShort) &&
      sideMatch(h, e.homeCanon, e.homeAbbr, e.homeShort)
    ) {
      return { ev: e, orient: 'ah' };
    }
    if (
      sideMatch(a, e.homeCanon, e.homeAbbr, e.homeShort) &&
      sideMatch(h, e.awayCanon, e.awayAbbr, e.awayShort)
    ) {
      return { ev: e, orient: 'ha' };
    }
  }
  return null;
}

async function fetchOdds(sportKey, eventId, competitionId) {
  const meta = SPORT_META[sportKey];
  if (!meta) return null;
  const cacheKey = meta.core + '|' + eventId;
  if (oddsCache.has(cacheKey)) return oddsCache.get(cacheKey);
  const listUrl =
    CORE +
    '/' +
    meta.core +
    '/events/' +
    eventId +
    '/competitions/' +
    competitionId +
    '/odds?lang=en&region=us';
  const list = await fetchJson(listUrl);
  await sleep(30);
  let odds = null;
  if (list && Array.isArray(list.items) && list.items.length) {
    // Prefer first provider (usually DraftKings); follow $ref if needed
    const item = list.items[0];
    if (item && typeof item.spread === 'number') {
      odds = item;
    } else if (item && item.$ref) {
      const ref = String(item.$ref).replace(/^http:/, 'https:');
      odds = await fetchJson(ref);
      await sleep(30);
    }
  }
  oddsCache.set(cacheKey, odds);
  return odds;
}

/** Fav-signed spread (negative = fav giving points), using ESPN home-spread convention. */
function favSpreadFromOdds(odds, orient, favIdx) {
  if (!odds || !Number.isFinite(Number(odds.spread))) return null;
  const homeLine = Number(odds.spread); // ESPN: line on home team
  const awayLine = -homeLine;
  // teams[0]/teams[1] mapped through orient to away/home
  // orient ah: teams[0]=away, teams[1]=home
  // orient ha: teams[0]=home, teams[1]=away
  let lineOnTeam0;
  let lineOnTeam1;
  if (orient === 'ah') {
    lineOnTeam0 = awayLine;
    lineOnTeam1 = homeLine;
  } else {
    lineOnTeam0 = homeLine;
    lineOnTeam1 = awayLine;
  }
  if (favIdx === 0) return lineOnTeam0;
  if (favIdx === 1) return lineOnTeam1;
  // Fallback: use ESPN favorite flags
  if (odds.homeTeamOdds && odds.homeTeamOdds.favorite) {
    const homeIsTeam = orient === 'ah' ? 1 : 0;
    return homeIsTeam === 0 ? homeLine : homeLine; // fav home line
  }
  return null;
}

function applyCover(s, spread, gradeKind) {
  const favIdx = favTeamIndex(s);
  if (favIdx == null) return false;
  if (s.awayScore == null || s.homeScore == null) return false;
  const score0 = Number(s.awayScore);
  const score1 = Number(s.homeScore);
  if (!Number.isFinite(score0) || !Number.isFinite(score1)) return false;
  const favScore = favIdx === 0 ? score0 : score1;
  const dogScore = favIdx === 0 ? score1 : score0;
  const margin = favScore - dogScore;
  const dogIdx = 1 - favIdx;

  if (gradeKind === 'ml' || spread == null) {
    if (margin === 0) {
      s.coverTeamIdx = 'void';
      s.gradeKind = gradeKind === 'ml' ? 'ml' : 'legacy';
      s.favCovered = null;
    } else {
      s.coverTeamIdx = margin > 0 ? favIdx : dogIdx;
      s.gradeKind = gradeKind === 'ml' ? 'ml' : 'legacy';
      s.favCovered = margin > 0;
    }
    s.gradedAt = Date.now();
    return true;
  }

  const ats = margin + Number(spread);
  if (Math.abs(ats) < 1e-9) {
    s.coverTeamIdx = 'void';
    s.gradeKind = 'ats';
    s.favCovered = null;
  } else {
    s.coverTeamIdx = ats > 0 ? favIdx : dogIdx;
    s.gradeKind = 'ats';
    s.favCovered = ats > 0;
  }
  s.spread = Number(spread);
  s.gradedAt = Date.now();
  return true;
}

async function findMatch(s) {
  const keys = sportKeysToTry(s).filter((k) => k !== 'SOCCER');
  const days = daysToTry(s);
  for (const sportKey of keys) {
    const meta = SPORT_META[sportKey];
    if (!meta) continue;
    const groups = meta.groups || [null];
    for (const day of days) {
      for (const group of groups) {
        const events = await loadBoard(sportKey, day, group);
        const hit = matchEvent(s, events);
        if (hit) return { sportKey, ...hit };
      }
    }
  }
  return null;
}

async function main() {
  console.log('Loading', DATA_PATH);
  const raw = fs.readFileSync(DATA_PATH, 'utf8');
  const json = JSON.parse(
    raw.replace(/^window\.__BOOK_LEAGUE_DATA__\s*=\s*/, '').replace(/;\s*$/, '')
  );
  const snaps = json.snaps;
  console.log('snaps', snaps.length);

  const stats = {
    mlGraded: 0,
    atsGraded: 0,
    legacyGraded: 0,
    noScores: 0,
    oddsMiss: 0,
    matchMiss: 0,
    already: 0,
  };

  for (let i = 0; i < snaps.length; i++) {
    const s = snaps[i];
    if (i && i % 200 === 0) {
      console.log(
        'progress',
        i + '/' + snaps.length,
        'fetches',
        fetchCount,
        'ats',
        stats.atsGraded,
        'legacy',
        stats.legacyGraded,
        'ml',
        stats.mlGraded
      );
    }

    if (s.coverTeamIdx != null && s.coverTeamIdx !== '') {
      stats.already++;
      continue;
    }

    const ml = isMoneylineMarket(s);

    // Ensure scores when possible
    if ((s.awayScore == null || s.homeScore == null) && !ml) {
      // try match for scores anyway below
    }

    if (ml) {
      if (s.awayScore == null || s.homeScore == null) {
        const hit = await findMatch(s);
        if (hit && hit.ev.awayScore != null && hit.ev.homeScore != null) {
          if (hit.orient === 'ah') {
            s.awayScore = hit.ev.awayScore;
            s.homeScore = hit.ev.homeScore;
          } else {
            s.awayScore = hit.ev.homeScore;
            s.homeScore = hit.ev.awayScore;
          }
          if (hit.ev.status) s.status = hit.ev.status;
        }
      }
      if (s.awayScore == null || s.homeScore == null) {
        stats.noScores++;
        continue;
      }
      if (applyCover(s, null, 'ml')) stats.mlGraded++;
      continue;
    }

    // Spread market — prefer ESPN line for true ATS
    const hit = await findMatch(s);
    if (!hit) {
      stats.matchMiss++;
      if (s.awayScore != null && s.homeScore != null) {
        if (applyCover(s, null, 'legacy')) stats.legacyGraded++;
      } else {
        stats.noScores++;
      }
      continue;
    }

    if (s.awayScore == null || s.homeScore == null) {
      if (hit.ev.awayScore != null && hit.ev.homeScore != null) {
        if (hit.orient === 'ah') {
          s.awayScore = hit.ev.awayScore;
          s.homeScore = hit.ev.homeScore;
        } else {
          s.awayScore = hit.ev.homeScore;
          s.homeScore = hit.ev.awayScore;
        }
      }
    }
    if (hit.ev.status) s.status = hit.ev.status;

    const favIdx = favTeamIndex(s);
    const odds = await fetchOdds(hit.sportKey, hit.ev.eventId, hit.ev.competitionId);
    const spread = favSpreadFromOdds(odds, hit.orient, favIdx);

    if (spread != null && s.awayScore != null && s.homeScore != null) {
      if (applyCover(s, spread, 'ats')) {
        stats.atsGraded++;
        continue;
      }
    }

    stats.oddsMiss++;
    if (s.awayScore != null && s.homeScore != null) {
      if (applyCover(s, null, 'legacy')) stats.legacyGraded++;
    } else {
      stats.noScores++;
    }
  }

  const graded = snaps.filter((s) => s.coverTeamIdx != null && s.coverTeamIdx !== '').length;
  json.updatedAt = new Date().toISOString();
  json.source = 'backfill-legacy-ats';
  const out = 'window.__BOOK_LEAGUE_DATA__ = ' + JSON.stringify(json) + ';\n';
  fs.writeFileSync(DATA_PATH, out, 'utf8');

  console.log('DONE');
  console.log(stats);
  console.log({ graded, total: snaps.length, fetchCount });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
