// ==UserScript==
// @name         Pinny Fade — ZCode + Bet105 (MLB/NFL/WNBA)
// @namespace    https://github.com/local/pinny-fade
// @version      1.7.1
// @description  Scrape ZCode LR; Bet105 open→current; live scores; multi-book slam tracker; GitHub history
// @author       You
// @match        https://zcodesystem.com/linereversals.php*
// @match        https://www.bookmakersreview.com/odds-scores*
// @match        https://bookmakersreview.com/odds-scores*
// @match        https://*.github.io/*
// @match        http://localhost/*
// @match        http://127.0.0.1/*
// @match        file:///*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @connect      bookmakersreview.com
// @connect      www.bookmakersreview.com
// @connect      ms.virginia.us-east-1.bookmakersreview.com
// @connect      api.github.com
// @connect      statsapi.mlb.com
// @connect      site.api.espn.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /** Live IPC between tabs — per-sport keys avoid multi-tab clobber races. */
  const ZCODE_KEY_LEGACY = 'pinnyFadeZcodeGames';
  const ZCODE_SPORT_KEYS = {
    MLB: 'pinnyFadeZcodeGames_MLB',
    NFL: 'pinnyFadeZcodeGames_NFL',
    WNBA: 'pinnyFadeZcodeGames_WNBA',
  };
  const ZCODE_TS_KEY = 'pinnyFadeZcodeTs';
  const PINNY_KEY = 'pinnyFadePinnyGames';
  const PINNY_TS_KEY = 'pinnyFadePinnyTs';
  const PINNY_ERR_KEY = 'pinnyFadePinnyError';
  const SPORTS_KEY = 'pinnyFadeSportsPresent';
  const SCORE_KEY = 'pinnyFadeScores';
  const SCORE_TS_KEY = 'pinnyFadeScoresTs';
  const SLAMS_KEY = 'pinnyFadeSlams';
  const GH_TOKEN_KEY = 'pinnyFadeGithubToken';
  const GH_REPO_KEY = 'pinnyFadeGithubRepo';
  const GH_BRANCH_KEY = 'pinnyFadeGithubBranch';

  const BMR_ODDS_SCORES_URL = 'https://www.bookmakersreview.com/odds-scores/';
  /** BMR league ids on odds-scores (see newPages.leaguePages) */
  const BMR_LID_BY_SPORT = { MLB: 3, NFL: 16, WNBA: 15 };
  const ZCODE_URLS = {
    MLB: 'https://zcodesystem.com/linereversals.php?sport=MLB',
    NFL: 'https://zcodesystem.com/linereversals.php?sport=NFL',
    WNBA: 'https://zcodesystem.com/linereversals.php?sport=WNBA',
  };
  const BMR_ODDS_V2 =
    'https://ms.virginia.us-east-1.bookmakersreview.com/ms-odds-v2/odds-v2-service';
  const BMR_PAID_BET105 = 130;
  /** MLB moneyline; NFL/WNBA point spread (Bet105) */
  const BMR_MTID_BY_SPORT = { MLB: 83, NFL: 401, WNBA: 401 };
  const MARKET_BY_SPORT = { MLB: 'ml', NFL: 'spread', WNBA: 'spread' };
  /** BMR paid IDs (PySBR sportsbooks.yaml + Bet105=130) */
  const SLAM_BOOKS = [
    { name: 'Bet105', paid: 130 },
    { name: 'BetCRIS', paid: 10 },
    { name: 'BetOnline', paid: 8 },
    { name: 'Bovada', paid: 9 },
  ];
  const SLAM_CURSOR_KEY = 'pinnyFadeSlamCursor';
  const SLAM_BATCH = 16;
  const SLAM_WINDOW_MS = 2 * 60 * 1000;
  const SLAM_MIN_CENTS = 6;
  const SLAM_MIN_SPREAD = 0.5;
  const POLL_MS = 60 * 1000;
  const SCORE_MS = 75 * 1000;
  const SLAM_MS = 90 * 1000;
  const ZCODE_SCRAPE_MS = 2000;
  const DASHBOARD_PUSH_MS = 1500;
  const BACKUP_MS = 60 * 1000;
  const BACKUP_DEBOUNCE_MS = 2500;
  const RESULTS_MS = 15 * 60 * 1000;

  // --- utils ---

  function log() {
    try {
      console.log.apply(console, ['[PinnyFade]'].concat([].slice.call(arguments)));
    } catch (_) {}
  }

  function canon(name) {
    if (!name) return '';
    return String(name)
      .toUpperCase()
      .replace(/\./g, '')
      .replace(/[^A-Z0-9 ]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\s+W$/g, '') // ZCode WNBA gender suffix e.g. "Portland Fire W"
      .trim();
  }

  function cleanTeamLabel(name) {
    return String(name || '')
      .replace(/\s+W$/i, '')
      .trim();
  }

  /** Fallback abbr: first 3 letters of the name (spaces ignored). */
  function fallbackAbbr(name) {
    const s = canon(name).replace(/\s+/g, '');
    return s.slice(0, 3);
  }

  function tokens(name) {
    const stop = new Set([
      'THE', 'OF', 'AND', 'AT', 'VS', 'FC', 'CLUB',
      'BASEBALL', 'TEAM',
    ]);
    return canon(name)
      .split(' ')
      .filter((t) => t && !stop.has(t));
  }

  /** Map common MLB nicknames / cities / abbrs for fuzzy join */
  const MLB_NICK = {
    DODGERS: 'LAD',
    YANKEES: 'NYY',
    METS: 'NYM',
    CUBS: 'CHC',
    'WHITE SOX': 'CWS',
    WHITESOX: 'CWS',
    REDSOX: 'BOS',
    'RED SOX': 'BOS',
    GIANTS: 'SF',
    ATHLETICS: 'ATH',
    OAKLAND: 'ATH',
    GUARDIANS: 'CLE',
    INDIANS: 'CLE',
    DIAMONDBACKS: 'ARI',
    DBACKS: 'ARI',
    'D BACKS': 'ARI',
    ARIZONA: 'ARI',
    BLUEJAYS: 'TOR',
    'BLUE JAYS': 'TOR',
    RAYS: 'TB',
    DEVILRAYS: 'TB',
    PADRES: 'SD',
    MARINERS: 'SEA',
    MARLINS: 'MIA',
    FLORIDA: 'MIA',
    NATIONALS: 'WSH',
    WASHINGTON: 'WSH',
    ORIOLES: 'BAL',
    PIRATES: 'PIT',
    PHILLIES: 'PHI',
    BRAVES: 'ATL',
    BREWERS: 'MIL',
    CARDINALS: 'STL',
    'ST LOUIS': 'STL',
    TWINS: 'MIN',
    TIGERS: 'DET',
    DETROIT: 'DET',
    ROYALS: 'KC',
    'KANSAS CITY': 'KC',
    RANGERS: 'TEX',
    TEXAS: 'TEX',
    ANGELS: 'LAA',
    ASTROS: 'HOU',
    HOUSTON: 'HOU',
    ROCKIES: 'COL',
    REDS: 'CIN',
    // Official / BMR abbreviations (exact only — never substring)
    LAD: 'LAD',
    NYY: 'NYY',
    NYM: 'NYM',
    CHC: 'CHC',
    CWS: 'CWS',
    BOS: 'BOS',
    SF: 'SF',
    ATH: 'ATH',
    CLE: 'CLE',
    ARI: 'ARI',
    AZ: 'ARI',
    TOR: 'TOR',
    TB: 'TB',
    SD: 'SD',
    SEA: 'SEA',
    MIA: 'MIA',
    WSH: 'WSH',
    WAS: 'WSH',
    BAL: 'BAL',
    PIT: 'PIT',
    PHI: 'PHI',
    ATL: 'ATL',
    MIL: 'MIL',
    STL: 'STL',
    MIN: 'MIN',
    DET: 'DET',
    KC: 'KC',
    TEX: 'TEX',
    LAA: 'LAA',
    HOU: 'HOU',
    COL: 'COL',
    CIN: 'CIN',
  };

  const NFL_NICK = {
    BILLS: 'BUF',
    BUFFALO: 'BUF',
    DOLPHINS: 'MIA',
    MIAMI: 'MIA',
    PATRIOTS: 'NE',
    'NEW ENGLAND': 'NE',
    JETS: 'NYJ',
    'NY JETS': 'NYJ',
    'N Y JETS': 'NYJ',
    'NEW YORK JETS': 'NYJ',
    RAVENS: 'BAL',
    BALTIMORE: 'BAL',
    BENGALS: 'CIN',
    CINCINNATI: 'CIN',
    BROWNS: 'CLE',
    CLEVELAND: 'CLE',
    STEELERS: 'PIT',
    PITTSBURGH: 'PIT',
    TEXANS: 'HOU',
    HOUSTON: 'HOU',
    COLTS: 'IND',
    INDIANAPOLIS: 'IND',
    JAGUARS: 'JAX',
    JACKSONVILLE: 'JAX',
    TITANS: 'TEN',
    TENNESSEE: 'TEN',
    BRONCOS: 'DEN',
    DENVER: 'DEN',
    CHIEFS: 'KC',
    'KANSAS CITY': 'KC',
    RAIDERS: 'LV',
    'LAS VEGAS': 'LV',
    OAKLAND: 'LV',
    CHARGERS: 'LAC',
    'LA CHARGERS': 'LAC',
    'L A CHARGERS': 'LAC',
    'LOS ANGELES CHARGERS': 'LAC',
    COWBOYS: 'DAL',
    DALLAS: 'DAL',
    GIANTS: 'NYG',
    'NY GIANTS': 'NYG',
    'N Y GIANTS': 'NYG',
    'NEW YORK GIANTS': 'NYG',
    EAGLES: 'PHI',
    PHILADELPHIA: 'PHI',
    COMMANDERS: 'WSH',
    WASHINGTON: 'WSH',
    REDSKINS: 'WSH',
    BEARS: 'CHI',
    CHICAGO: 'CHI',
    LIONS: 'DET',
    DETROIT: 'DET',
    PACKERS: 'GB',
    'GREEN BAY': 'GB',
    VIKINGS: 'MIN',
    MINNESOTA: 'MIN',
    FALCONS: 'ATL',
    ATLANTA: 'ATL',
    PANTHERS: 'CAR',
    CAROLINA: 'CAR',
    SAINTS: 'NO',
    'NEW ORLEANS': 'NO',
    BUCCANEERS: 'TB',
    BUCS: 'TB',
    'TAMPA BAY': 'TB',
    CARDINALS: 'ARI',
    ARIZONA: 'ARI',
    RAMS: 'LAR',
    'LA RAMS': 'LAR',
    'L A RAMS': 'LAR',
    'LOS ANGELES RAMS': 'LAR',
    '49ERS': 'SF',
    NINERS: 'SF',
    'SAN FRANCISCO': 'SF',
    SEAHAWKS: 'SEA',
    SEATTLE: 'SEA',
    BUF: 'BUF',
    MIA: 'MIA',
    NE: 'NE',
    NYJ: 'NYJ',
    BAL: 'BAL',
    CIN: 'CIN',
    CLE: 'CLE',
    PIT: 'PIT',
    HOU: 'HOU',
    IND: 'IND',
    JAX: 'JAX',
    JAC: 'JAX',
    TEN: 'TEN',
    DEN: 'DEN',
    KC: 'KC',
    LV: 'LV',
    LAC: 'LAC',
    DAL: 'DAL',
    NYG: 'NYG',
    PHI: 'PHI',
    WSH: 'WSH',
    WAS: 'WSH',
    CHI: 'CHI',
    DET: 'DET',
    GB: 'GB',
    MIN: 'MIN',
    ATL: 'ATL',
    CAR: 'CAR',
    NO: 'NO',
    TB: 'TB',
    ARI: 'ARI',
    AZ: 'ARI',
    LAR: 'LAR',
    SF: 'SF',
    SEA: 'SEA',
  };

  const WNBA_NICK = {
    SKY: 'CHI',
    CHICAGO: 'CHI',
    LYNX: 'MIN',
    MINNESOTA: 'MIN',
    MYSTICS: 'WAS',
    WASHINGTON: 'WAS',
    VALKYRIES: 'GS',
    'GOLDEN STATE': 'GS',
    'GOLDEN STATE VALKYRIES': 'GS',
    FIRE: 'POR',
    PORTLAND: 'POR',
    'PORTLAND FIRE': 'POR',
    TEMPO: 'TOR',
    TORONTO: 'TOR',
    'TORONTO TEMPO': 'TOR',
    ACES: 'LV',
    'LAS VEGAS': 'LV',
    'LAS VEGAS ACES': 'LV',
    LIBERTY: 'NY',
    'NEW YORK': 'NY',
    'NEW YORK LIBERTY': 'NY',
    SUN: 'CON',
    CONNECTICUT: 'CON',
    'CONNECTICUT SUN': 'CON',
    STORM: 'SEA',
    SEATTLE: 'SEA',
    'SEATTLE STORM': 'SEA',
    MERCURY: 'PHX',
    PHOENIX: 'PHX',
    'PHOENIX MERCURY': 'PHX',
    WINGS: 'DAL',
    DALLAS: 'DAL',
    'DALLAS WINGS': 'DAL',
    DREAM: 'ATL',
    ATLANTA: 'ATL',
    'ATLANTA DREAM': 'ATL',
    FEVER: 'IND',
    INDIANA: 'IND',
    'INDIANA FEVER': 'IND',
    SPARKS: 'LA',
    'LOS ANGELES': 'LA',
    'LOS ANGELES SPARKS': 'LA',
    'LA SPARKS': 'LA',
    CHI: 'CHI',
    MIN: 'MIN',
    WAS: 'WAS',
    WSH: 'WAS',
    GS: 'GS',
    GSV: 'GS',
    POR: 'POR',
    TOR: 'TOR',
    LV: 'LV',
    LVA: 'LV',
    NY: 'NY',
    NYL: 'NY',
    CON: 'CON',
    CONN: 'CON',
    SEA: 'SEA',
    PHX: 'PHX',
    PHO: 'PHX',
    DAL: 'DAL',
    ATL: 'ATL',
    IND: 'IND',
    LA: 'LA',
    LAS: 'LA',
  };

  const NICK_EXACT_ONLY = new Set(['AS']);

  function nickKeysLong(map) {
    return Object.keys(map)
      .filter((k) => k.length >= 3)
      .sort((a, b) => b.length - a.length);
  }

  const MLB_NICK_KEYS_LONG = nickKeysLong(MLB_NICK);
  const NFL_NICK_KEYS_LONG = nickKeysLong(NFL_NICK);
  const WNBA_NICK_KEYS_LONG = nickKeysLong(WNBA_NICK);

  function teamIdFromMap(name, map, keysLong) {
    const c = canon(name);
    if (!c) return '';
    if (map[c]) return map[c];
    if (map === MLB_NICK && (c === 'AS' || c === 'A S')) return 'ATH';

    const t = tokens(name);
    if (t.length) {
      for (let n = Math.min(3, t.length); n >= 2; n--) {
        for (let i = 0; i <= t.length - n; i++) {
          const joined = t.slice(i, i + n).join(' ');
          if (map[joined]) return map[joined];
        }
      }
      for (let i = 0; i < t.length; i++) {
        if (map[t[i]]) return map[t[i]];
      }
    }

    for (let i = 0; i < keysLong.length; i++) {
      const k = keysLong[i];
      if (NICK_EXACT_ONLY.has(k)) continue;
      if (c.includes(k)) return map[k];
    }
    return c;
  }

  function teamId(name, sport) {
    if (sport === 'NFL') return teamIdFromMap(name, NFL_NICK, NFL_NICK_KEYS_LONG);
    if (sport === 'WNBA') return teamIdFromMap(name, WNBA_NICK, WNBA_NICK_KEYS_LONG);
    return teamIdFromMap(name, MLB_NICK, MLB_NICK_KEYS_LONG);
  }

  function teamsMatch(a, b, sport) {
    if (!a || !b) return false;
    const idA = teamId(a, sport);
    const idB = teamId(b, sport);
    // Require resolved abbr/id equality — fuzzy includes("New York") caused wrong pairings
    if (idA && idB && idA === idB) return true;
    const ca = canon(a);
    const cb = canon(b);
    return !!(ca && cb && ca === cb);
  }

  /** Higher = better. -1 = no match. */
  function pairMatchScore(zAway, zHome, pAway, pHome, sport) {
    const zA = teamId(zAway, sport) || canon(zAway);
    const zH = teamId(zHome, sport) || canon(zHome);
    const pA = teamId(pAway, sport) || canon(pAway);
    const pH = teamId(pHome, sport) || canon(pHome);
    if (!zA || !zH || !pA || !pH) return -1;
    if (zA === pA && zH === pH) {
      // Prefer abbr-quality matches
      const abbrBonus =
        (String(zA).length <= 4 ? 2 : 0) + (String(zH).length <= 4 ? 2 : 0);
      return 100 + abbrBonus;
    }
    return -1;
  }

  function americanToImplied(a) {
    if (!Number.isFinite(a) || a === 0) return null;
    if (a < 0) return Math.abs(a) / (Math.abs(a) + 100);
    return 100 / (a + 100);
  }

  /**
   * American odds as ¢ from even money. +100/−100 = 0, so
   * +105 → −101 is −6¢ (not −206).
   */
  function americanCentsFromEven(a) {
    if (!Number.isFinite(a)) return null;
    if (a >= 100) return a - 100;
    if (a <= -100) return a + 100;
    return a;
  }

  function americanCentsDelta(open, curr) {
    const o = americanCentsFromEven(open);
    const c = americanCentsFromEven(curr);
    if (o == null || c == null) return null;
    return c - o;
  }

  function normalizeAbbr(abbr, sport) {
    const a = String(abbr || '')
      .toUpperCase()
      .replace(/\./g, '');
    if (sport === 'NFL') {
      if (a === 'JAC') return 'JAX';
      if (a === 'WAS') return 'WSH';
      if (a === 'AZ') return 'ARI';
      return a;
    }
    if (sport === 'WNBA') {
      if (a === 'WSH') return 'WAS';
      if (a === 'GSV') return 'GS';
      if (a === 'LVA') return 'LV';
      if (a === 'NYL') return 'NY';
      if (a === 'CONN') return 'CON';
      if (a === 'PHO') return 'PHX';
      if (a === 'LAS') return 'LA';
      return a;
    }
    if (a === 'AZ') return 'ARI';
    if (a === 'WAS') return 'WSH';
    return a;
  }

  function parsePctRatio(el) {
    if (!el) return null;
    const text = el.textContent || '';
    const m = text.match(/(\d+(?:\.\d+)?)/);
    if (!m) return null;
    const n = parseFloat(m[1]);
    return Number.isFinite(n) ? n : null;
  }

  // --- ZCode scrape ---

  /** tickets_place_1 = red; tickets_place_2 / _23 = yellow */
  function ticketsPlaceHl(node) {
    if (!node) return null;
    const classes = String(node.className || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const has = (n) => classes.indexOf(n) !== -1;
    if (has('tickets_place_1') || has('public_level_2')) return 'red';
    if (has('tickets_place_2') || has('tickets_place_23') || has('public_level_1')) {
      return 'yellow';
    }
    return null;
  }

  function strongerHl(a, b) {
    if (a === 'red' || b === 'red') return 'red';
    return a || b || null;
  }

  /** Popular rank from "ML tickets: N (X)" → X (game-level rank; same on both sides). */
  function mlTicketsPopular(teamRoot) {
    if (!teamRoot) return null;
    const row = teamRoot.querySelector('.public_tickets.tickets.ToML');
    if (!row) return null;
    const info = row.querySelector('.tix_info');
    const text = String((info && info.textContent) || row.textContent || '');
    const m = text.match(/\((\d+)\)/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) && n >= 1 ? n : null;
  }

  /** Prefer either side’s ML popular rank (they should match). */
  function gameMlPopular(team1, team2) {
    const a = mlTicketsPopular(team1);
    const b = mlTicketsPopular(team2);
    if (Number.isFinite(a)) return a;
    if (Number.isFinite(b)) return b;
    return null;
  }

  /** ML tickets line shading (per team) */
  function mlTicketsHighlight(teamRoot) {
    if (!teamRoot) return null;
    return ticketsPlaceHl(teamRoot.querySelector('.public_tickets.tickets.ToML'));
  }

  /** ML tickets difference shading */
  function mlTicketsDiffHighlight(teamRoot) {
    if (!teamRoot) return null;
    return ticketsPlaceHl(teamRoot.querySelector('.public_tix_stats.ToML'));
  }

  /** Spread tickets difference shading */
  function spreadTicketsDiffHighlight(teamRoot) {
    if (!teamRoot) return null;
    return ticketsPlaceHl(
      teamRoot.querySelector('.public_tix_stats.ToSpread, .public_tix_stats.ToSpreadVal')
    );
  }

  function pageZcodeSport() {
    const m = String(location.search || '').match(/[?&]sport=([A-Za-z0-9]+)/i);
    if (!m) return null;
    const s = m[1].toUpperCase();
    return ZCODE_SPORT_KEYS[s] ? s : null;
  }

  function scrapeZcodeGames() {
    const onlySport = pageZcodeSport();
    const sel = onlySport
      ? `.game[data-sport="${onlySport}"]`
      : '.game[data-sport="MLB"], .game[data-sport="NFL"], .game[data-sport="WNBA"]';
    const gameEls = document.querySelectorAll(sel);
    const games = [];

    gameEls.forEach((el) => {
      const sport = (el.getAttribute('data-sport') || '').toUpperCase();
      if (sport !== 'MLB' && sport !== 'NFL' && sport !== 'WNBA') return;
      if (onlySport && sport !== onlySport) return;

      const gid = el.getAttribute('data-game-id') || '';
      const get = (name) => {
        const inp = el.querySelector(`input[name="${name}"]`);
        return inp ? String(inp.value || '').trim() : '';
      };

      const name1 = cleanTeamLabel(get('name1'));
      const name2 = cleanTeamLabel(get('name2'));
      const lc1 = cleanTeamLabel(get('lc1') || name1);
      const lc2 = cleanTeamLabel(get('lc2') || name2);
      if (!lc1 || !lc2) return;

      const ml1 = parseFloat(get('ml1'));
      const ml2 = parseFloat(get('ml2'));
      const strong = parseInt(get('strong_index'), 10) || 0;
      const gdate = get('gdate') || get('status');

      // Ticket public ratio ONLY (e.g. 2.40x). Never use popular-% cells — those
      // appear a beat later and were swapping in the wrong metric.
      let publicRatio1 = null;
      let publicRatio2 = null;
      const pr1 = el.querySelector('.team1 .public_tickets.tickets[class*="ratio_level"] b');
      const pr2 = el.querySelector('.team2 .public_tickets.tickets[class*="ratio_level"] b');
      if (pr1) publicRatio1 = parseFloat((pr1.textContent || '').trim());
      if (pr2) publicRatio2 = parseFloat((pr2.textContent || '').trim());

      let mlPc1 = null;
      let mlPc2 = null;
      try {
        const ppc = JSON.parse(get('ppc') || '{}');
        mlPc1 = ppc.ml_pc1;
        mlPc2 = ppc.ml_pc2;
      } catch (_) {}

      const rankEl = el.querySelector('.zcode-game-ranking');
      const ranking = rankEl ? (rankEl.textContent || '').trim() : '';

      const r1 = publicRatio1;
      const r2 = publicRatio2;

      const team1 = el.querySelector('.team1');
      const team2 = el.querySelector('.team2');
      const mlTixHl1 = mlTicketsHighlight(team1);
      const mlTixHl2 = mlTicketsHighlight(team2);
      const mlTixDiffHl1 = mlTicketsDiffHighlight(team1);
      const mlTixDiffHl2 = mlTicketsDiffHighlight(team2);
      const spreadTixDiffHl1 = spreadTicketsDiffHighlight(team1);
      const spreadTixDiffHl2 = spreadTicketsDiffHighlight(team2);
      const mlPopular1 = mlTicketsPopular(team1);
      const mlPopular2 = mlTicketsPopular(team2);
      const mlPopular = gameMlPopular(team1, team2);

      games.push({
        sport,
        gameId: gid || `${sport}:${lc1}@${lc2}`,
        away: lc1,
        home: lc2,
        name1,
        name2,
        ml1: Number.isFinite(ml1) ? ml1 : null,
        ml2: Number.isFinite(ml2) ? ml2 : null,
        strongIndex: strong,
        gdate,
        ranking,
        publicRatio1: Number.isFinite(r1) ? r1 : null,
        publicRatio2: Number.isFinite(r2) ? r2 : null,
        mlPc1,
        mlPc2,
        mlPopular1,
        mlPopular2,
        mlPopular,
        mlTixHl1,
        mlTixHl2,
        mlTixDiffHl1,
        mlTixDiffHl2,
        spreadTixDiffHl1,
        spreadTixDiffHl2,
        scrapedAt: Date.now(),
      });
    });

    return dedupeZcodeScraped(games);
  }

  function writeZcodeSport(sport, games) {
    const key = ZCODE_SPORT_KEYS[sport];
    if (!key) return;
    GM_setValue(key, Array.isArray(games) ? games : []);
    GM_setValue(ZCODE_TS_KEY, Date.now());
  }

  function readAllZcodeGames() {
    const out = [];
    Object.keys(ZCODE_SPORT_KEYS).forEach((sport) => {
      const rows = GM_getValue(ZCODE_SPORT_KEYS[sport], null);
      if (Array.isArray(rows) && rows.length) {
        rows.forEach((g) => {
          out.push(g && !g.sport ? Object.assign({}, g, { sport }) : g);
        });
      }
    });
    if (out.length) return out;

    const legacy = GM_getValue(ZCODE_KEY_LEGACY, []) || [];
    if (!Array.isArray(legacy) || !legacy.length) return [];
    const bySport = { MLB: [], NFL: [], WNBA: [] };
    legacy.forEach((g) => {
      const sport = (g && g.sport) || 'MLB';
      if (!bySport[sport]) return;
      bySport[sport].push(g);
    });
    Object.keys(bySport).forEach((sport) => {
      if (bySport[sport].length) writeZcodeSport(sport, bySport[sport]);
    });
    try {
      GM_setValue(ZCODE_KEY_LEGACY, []);
    } catch (_) {}
    return readAllZcodeGames();
  }

  function saveZcodeScraped(scraped) {
    const bySport = {};
    (scraped || []).forEach((g) => {
      if (!g || !g.sport || !ZCODE_SPORT_KEYS[g.sport]) return;
      if (!bySport[g.sport]) bySport[g.sport] = [];
      bySport[g.sport].push(g);
    });
    let wrote = 0;
    Object.keys(bySport).forEach((sport) => {
      const next = bySport[sport];
      const prev = GM_getValue(ZCODE_SPORT_KEYS[sport], []) || [];
      const nextOk = next.filter(hasZcodeRatioData).length;
      const prevOk = Array.isArray(prev) ? prev.filter(hasZcodeRatioData).length : 0;
      // ZCode AJAX refreshes briefly leave a thin DOM — don't clobber a full slate
      if (prevOk >= 3 && nextOk < Math.ceil(prevOk * 0.75)) {
        log(
          'Skip partial ZCode scrape',
          sport,
          'kept',
          prevOk,
          'rejected',
          nextOk
        );
        return;
      }
      writeZcodeSport(sport, next);
      wrote += next.length;
    });
    return wrote;
  }

  function writePinnyGames(games) {
    GM_setValue(PINNY_KEY, games);
    GM_setValue(PINNY_TS_KEY, Date.now());
    GM_setValue(PINNY_ERR_KEY, '');
  }

  /** Never wipe a good board — only record the error. */
  function writePinnyError(msg) {
    GM_setValue(PINNY_ERR_KEY, msg || 'Bet105/BMR error');
  }

  function runZcodeLoop() {
    if (!/zcodesystem\.com/i.test(location.hostname)) return;
    if (!/linereversals\.php/i.test(location.pathname + location.search)) return;

    log('ZCode scrape armed');
    const tick = () => {
      try {
        const scraped = scrapeZcodeGames();
        if (scraped.length) {
          const n = saveZcodeScraped(scraped);
          const counts = scraped.reduce((acc, g) => {
            acc[g.sport] = (acc[g.sport] || 0) + 1;
            return acc;
          }, {});
          log('Scraped', JSON.stringify(counts), 'wrote=', n);
        }
      } catch (e) {
        log('ZCode scrape error', e && e.message);
      }
    };
    tick();
    setInterval(tick, ZCODE_SCRAPE_MS);
  }

  // --- Bet105 (Bookmakers Review) true open + current ---

  function cacheBust(url) {
    const sep = url.indexOf('?') >= 0 ? '&' : '?';
    return url + sep + '_=' + Date.now();
  }

  function gmGet(url, headers) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: cacheBust(url),
        headers: Object.assign(
          {
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            Pragma: 'no-cache',
          },
          headers || {}
        ),
        timeout: 30000,
        onload(res) {
          if (res.status >= 200 && res.status < 300) {
            resolve(res.responseText);
          } else {
            reject(
              new Error(
                `HTTP ${res.status}: ${(res.responseText || '').slice(0, 160)}`
              )
            );
          }
        },
        onerror() {
          reject(new Error('network error'));
        },
        ontimeout() {
          reject(new Error('timeout'));
        },
      });
    });
  }

  function extractInitialState(html) {
    const marker = 'window.__INITIAL_STATE__=';
    const i = html.indexOf(marker);
    if (i < 0) throw new Error('BMR page missing INITIAL_STATE');
    const start = i + marker.length;
    const cfg = html.indexOf('window.__config', start);
    if (cfg < 0) throw new Error('BMR page missing __config marker');
    let end = cfg - 1;
    while (end > start && /\s/.test(html[end])) end--;
    if (html[end] !== ';') throw new Error('BMR INITIAL_STATE parse failed');
    return JSON.parse(html.slice(start, end));
  }

  function sportFromBmrLid(lid) {
    const n = Number(lid);
    const sports = Object.keys(BMR_LID_BY_SPORT);
    for (let i = 0; i < sports.length; i++) {
      if (BMR_LID_BY_SPORT[sports[i]] === n) return sports[i];
    }
    return null;
  }

  function parseBmrEventsFromState(state) {
    const map = (state && state.events && state.events.events) || {};
    const bySport = { MLB: [], NFL: [], WNBA: [] };
    Object.keys(map).forEach((eid) => {
      const e = map[eid];
      if (!e || !e.participants) return;
      const sport = sportFromBmrLid(e.lid);
      if (!sport || !bySport[sport]) return;
      let away = null;
      let home = null;
      Object.keys(e.participants).forEach((pid) => {
        const p = e.participants[pid];
        const src = p.source || {};
        const row = {
          partid: Number(p.partid || pid),
          abbr: normalizeAbbr(src.abbr, sport),
          name: src.nn || src.nam || src.abbr || '',
          city: src.cit || src.nam || '',
          ih: !!p.ih,
        };
        if (row.ih) home = row;
        else away = row;
      });
      if (!away || !home) return;
      bySport[sport].push({
        sport,
        eventId: String(e.eid || eid),
        des: e.des || '',
        starts: e.dt || null,
        away,
        home,
      });
    });
    return bySport;
  }

  function readOddsScoresStateFromPage() {
    try {
      if (
        /bookmakersreview\.com/i.test(location.hostname) &&
        /odds-scores/i.test(location.pathname) &&
        window.__INITIAL_STATE__
      ) {
        return window.__INITIAL_STATE__;
      }
    } catch (_) {}
    return null;
  }

  async function fetchOddsScoresEventShells() {
    const live = readOddsScoresStateFromPage();
    if (live) {
      log('Using live odds-scores __INITIAL_STATE__');
      return parseBmrEventsFromState(live);
    }
    const html = await gmGet(BMR_ODDS_SCORES_URL, {
      Accept: 'text/html',
      'User-Agent': 'Mozilla/5.0',
    });
    const state = extractInitialState(html);
    return parseBmrEventsFromState(state);
  }

  async function fetchBet105Lines(eventIds, mtid) {
    if (!eventIds.length) return { openingLines: [], currentLines: [] };
    const eidList = eventIds.join(',');
    const q =
      `{ openingLines(eid:[${eidList}],mtid:[${mtid}],paid:[${BMR_PAID_BET105}])` +
      ` currentLines(eid:[${eidList}],mtid:[${mtid}],paid:[${BMR_PAID_BET105}]) }`;
    const url = `${BMR_ODDS_V2}?query=${encodeURIComponent(q)}`;
    const text = await gmGet(url, { Accept: 'application/json' });
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      throw new Error('Invalid JSON from BMR odds-v2');
    }
    if (data.errors && data.errors.length) {
      const msg =
        (data.errors[0] && data.errors[0].message) || 'BMR GraphQL error';
      throw new Error(msg);
    }
    return {
      openingLines: (data.data && data.data.openingLines) || [],
      currentLines: (data.data && data.data.currentLines) || [],
    };
  }

  function indexLinesByEventPart(lines, market) {
    const map = {};
    (lines || []).forEach((ln) => {
      const eid = String(ln.eid);
      const partid = Number(ln.partid);
      if (!eid || !Number.isFinite(partid)) return;
      const ap = Number(ln.ap);
      if (!Number.isFinite(ap)) return;
      if (!map[eid]) map[eid] = {};
      if (market === 'spread') {
        const adj = Number(ln.adj);
        if (!Number.isFinite(adj)) return;
        map[eid][partid] = { spread: adj, juice: ap };
      } else {
        map[eid][partid] = { am: ap };
      }
    });
    return map;
  }

  function buildPinnyGames(events, openingLines, currentLines, market) {
    const opens = indexLinesByEventPart(openingLines, market);
    const currents = indexLinesByEventPart(currentLines, market);
    const out = [];

    events.forEach((ev) => {
      const o = opens[ev.eventId] || {};
      const c = currents[ev.eventId] || {};
      const oA = o[ev.away.partid];
      const oH = o[ev.home.partid];
      const cA = c[ev.away.partid];
      const cH = c[ev.home.partid];
      if (!oA || !oH || !cA || !cH) return;

      const base = {
        sport: ev.sport || 'MLB',
        market,
        eventId: ev.eventId,
        awayPartid: ev.away.partid,
        homePartid: ev.home.partid,
        home: ev.home.name || ev.home.abbr,
        away: ev.away.name || ev.away.abbr,
        homeAbbr: ev.home.abbr,
        awayAbbr: ev.away.abbr,
        starts: ev.starts,
        source: 'bet105',
      };

      if (market === 'spread') {
        out.push(
          Object.assign({}, base, {
            openAwaySpread: oA.spread,
            openHomeSpread: oH.spread,
            openAwayJuice: oA.juice,
            openHomeJuice: oH.juice,
            awaySpread: cA.spread,
            homeSpread: cH.spread,
            awayJuice: cA.juice,
            homeJuice: cH.juice,
          })
        );
      } else {
        out.push(
          Object.assign({}, base, {
            openAwayAm: oA.am,
            openHomeAm: oH.am,
            awayAm: cA.am,
            homeAm: cH.am,
          })
        );
      }
    });
    return out;
  }

  async function fetchOneSportBoard(sport, eventsBySport) {
    const events =
      (eventsBySport && eventsBySport[sport]) ||
      (await fetchOddsScoresEventShells())[sport] ||
      [];
    if (!events.length) return [];
    const mtid = BMR_MTID_BY_SPORT[sport] || 83;
    const market = MARKET_BY_SPORT[sport] || 'ml';
    const { openingLines, currentLines } = await fetchBet105Lines(
      events.map((e) => e.eventId),
      mtid
    );
    return buildPinnyGames(events, openingLines, currentLines, market);
  }

  async function fetchPinnyBoard() {
    const eventsBySport = await fetchOddsScoresEventShells();
    const sports = Object.keys(BMR_LID_BY_SPORT);
    const chunks = await Promise.all(
      sports.map(async (sport) => {
        try {
          const games = await fetchOneSportBoard(sport, eventsBySport);
          log(`Bet105 ${sport}: ${games.length} games`);
          return games;
        } catch (e) {
          log(`Bet105 ${sport} fail`, e && e.message);
          return [];
        }
      })
    );
    const merged = [].concat.apply([], chunks);
    const present = sports.filter((s, i) => chunks[i].length > 0);
    GM_setValue(SPORTS_KEY, present);
    if (!merged.length) throw new Error('No Bet105 boards (MLB/NFL/WNBA)');
    return merged;
  }

  let pinnyPollSeq = 0;

  async function pollPinnyOdds() {
    const mySeq = ++pinnyPollSeq;
    try {
      const games = await fetchPinnyBoard();
      if (mySeq !== pinnyPollSeq) {
        log('Bet105 poll discarded (newer request in flight)');
        return;
      }
      writePinnyGames(games);
      log(`Bet105 board: ${games.length} games (fresh open + current)`);
      publishSlate();
    } catch (e) {
      if (mySeq !== pinnyPollSeq) return;
      writePinnyError((e && e.message) || 'Bet105/BMR error');
      log('Bet105 poll error', e && e.message);
      publishSlate();
    }
  }

  function runPinnyScheduler() {
    // Only the dashboard polls Bet105. Odds-scores + ZCode tabs used to race and
    // a failed poll wiped the board back to the session-start snapshot.
    if (!isDashboardPage()) return;
    pollPinnyOdds();
    setInterval(() => pollPinnyOdds(), POLL_MS);
  }

  function runOddsScoresWatch() {
    if (!/bookmakersreview\.com/i.test(location.hostname)) return;
    if (!/odds-scores/i.test(location.pathname)) return;
    log('odds-scores tab armed (fresh Bet105 open→current)');
    try {
      if (!document.getElementById('pinny-fade-tm-badge')) {
        const b = document.createElement('div');
        b.id = 'pinny-fade-tm-badge';
        b.textContent = 'Pinny Fade · odds-scores';
        b.style.cssText =
          'position:fixed;bottom:12px;right:12px;z-index:99999;padding:6px 10px;border-radius:8px;background:#2dd4a8;color:#041018;font:600 12px/1.2 Segoe UI,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.35)';
        document.body.appendChild(b);
      }
    } catch (_) {}
  }

  // --- merge + signal ---

  /** ZCode 0.00x (or missing) = no public-ratio data yet — skip. */
  function hasZcodeRatioData(g) {
    const r1 = Number(g.publicRatio1);
    const r2 = Number(g.publicRatio2);
    const ok1 = Number.isFinite(r1) && r1 > 0;
    const ok2 = Number.isFinite(r2) && r2 > 0;
    return ok1 || ok2;
  }

  function findPinnyMatch(zGame, pinnyList) {
    const sport = zGame.sport || 'MLB';
    let best = null;
    for (let i = 0; i < pinnyList.length; i++) {
      const p = pinnyList[i];
      if ((p.sport || 'MLB') !== sport) continue;
      const pAway = p.awayAbbr || p.away;
      const pHome = p.homeAbbr || p.home;
      const direct = pairMatchScore(zGame.away, zGame.home, pAway, pHome, sport);
      const flipped = pairMatchScore(zGame.away, zGame.home, pHome, pAway, sport);
      if (direct >= 0 && (!best || direct > best.score)) {
        best = { pinny: p, flipped: false, score: direct, idx: i };
      }
      if (flipped >= 0 && (!best || flipped > best.score)) {
        best = { pinny: p, flipped: true, score: flipped, idx: i };
      }
    }
    return best;
  }

  /** 1:1 assignment so one Bet105 game can't be claimed by two ZCode rows. */
  function assignPinnyMatches(zGames, pinnyList) {
    const candidates = [];
    (zGames || []).forEach((z, zi) => {
      const sport = z.sport || 'MLB';
      (pinnyList || []).forEach((p, pi) => {
        if ((p.sport || 'MLB') !== sport) return;
        const pAway = p.awayAbbr || p.away;
        const pHome = p.homeAbbr || p.home;
        const direct = pairMatchScore(z.away, z.home, pAway, pHome, sport);
        const flipped = pairMatchScore(z.away, z.home, pHome, pAway, sport);
        if (direct >= 0) {
          candidates.push({ zi, pi, flipped: false, score: direct });
        }
        if (flipped >= 0) {
          candidates.push({ zi, pi, flipped: true, score: flipped });
        }
      });
    });
    candidates.sort((a, b) => b.score - a.score);
    const usedZ = {};
    const usedP = {};
    const byZi = {};
    candidates.forEach((c) => {
      if (usedZ[c.zi] || usedP[c.pi]) return;
      usedZ[c.zi] = true;
      usedP[c.pi] = true;
      byZi[c.zi] = {
        pinny: pinnyList[c.pi],
        flipped: c.flipped,
        score: c.score,
      };
    });
    return byZi;
  }

  function labelToward(towardSide, publicIsAway, fadeIsAway) {
    let pinnyToward = 'unchanged';
    let pinnyTowardTeam = null;
    if (towardSide === 'away') {
      pinnyTowardTeam = 'away';
      if (publicIsAway) pinnyToward = 'public';
      else if (fadeIsAway) pinnyToward = 'fade';
      else pinnyToward = 'away';
    } else if (towardSide === 'home') {
      pinnyTowardTeam = 'home';
      if (!publicIsAway) pinnyToward = 'public';
      else if (!fadeIsAway) pinnyToward = 'fade';
      else pinnyToward = 'home';
    }
    return {
      pinnyToward,
      pinnyTowardTeam,
      towardPublic: pinnyToward === 'public',
      towardFade: pinnyToward === 'fade',
    };
  }

  /** Moneyline: toward via implied prob; move = American ¢ on current fav. */
  function computeMoveMl(openAway, openHome, currAway, currHome, publicIsAway, fadeIsAway) {
    if (
      [openAway, openHome, currAway, currHome].some((x) => !Number.isFinite(x))
    ) {
      return {
        centsMoved: null,
        pinnyToward: 'unknown',
        pinnyTowardTeam: null,
        towardPublic: false,
        towardFade: false,
      };
    }

    const dAway = americanToImplied(currAway) - americanToImplied(openAway);
    const dHome = americanToImplied(currHome) - americanToImplied(openHome);

    let towardSide = 'unchanged';
    if (Math.abs(dAway - dHome) < 0.002) towardSide = 'unchanged';
    else if (dAway > dHome) towardSide = 'away';
    else towardSide = 'home';

    const currFavIsAway = currAway < currHome;
    const openOnFavSide = currFavIsAway ? openAway : openHome;
    const currOnFavSide = currFavIsAway ? currAway : currHome;
    const centsMoved = americanCentsDelta(openOnFavSide, currOnFavSide);

    return Object.assign({ centsMoved }, labelToward(towardSide, publicIsAway, fadeIsAway));
  }
  function computeMoveSpread(
    openAway,
    openHome,
    currAway,
    currHome,
    publicIsAway,
    fadeIsAway
  ) {
    if (
      [openAway, openHome, currAway, currHome].some((x) => !Number.isFinite(x))
    ) {
      return {
        centsMoved: null,
        pinnyToward: 'unknown',
        pinnyTowardTeam: null,
        towardPublic: false,
        towardFade: false,
      };
    }

    const dAway = currAway - openAway;
    const dHome = currHome - openHome;

    let towardSide = 'unchanged';
    if (Math.abs(dAway - dHome) < 0.05) towardSide = 'unchanged';
    else if (dAway < dHome) towardSide = 'away';
    else towardSide = 'home';

    const currFavIsAway = currAway < currHome;
    const openOnFavSide = currFavIsAway ? openAway : openHome;
    const currOnFavSide = currFavIsAway ? currAway : currHome;
    const centsMoved = currOnFavSide - openOnFavSide;

    return Object.assign({ centsMoved }, labelToward(towardSide, publicIsAway, fadeIsAway));
  }

  function computeMove(market, openAway, openHome, currAway, currHome, publicIsAway, fadeIsAway) {
    if (market === 'spread') {
      return computeMoveSpread(
        openAway,
        openHome,
        currAway,
        currHome,
        publicIsAway,
        fadeIsAway
      );
    }
    return computeMoveMl(openAway, openHome, currAway, currHome, publicIsAway, fadeIsAway);
  }

  /** Same start time + identical slate fields ⇒ duplicate (e.g. ATL@MIL listed twice). */
  function gameExactDedupeKey(g) {
    return [
      g.sport || '',
      String(g.gdate || '').trim(),
      canon(g.away || ''),
      canon(g.home || ''),
      g.publicRatio1,
      g.publicRatio2,
      g.publicRatio,
      g.favRatio,
      g.popularNumber,
      canon(g.publicTeam || ''),
      canon(g.fadeTeam || ''),
      g.openAway,
      g.openHome,
      g.currAway,
      g.currHome,
      g.openAwayJuice,
      g.openHomeJuice,
      g.currAwayJuice,
      g.currHomeJuice,
      g.pinnyToward,
      g.notRespected ? 1 : 0,
    ].join('\t');
  }

  function dedupeExactGames(games) {
    const seen = {};
    const out = [];
    (games || []).forEach((g) => {
      const start = String(g.gdate || '').trim();
      if (!start) {
        out.push(g);
        return;
      }
      const key = gameExactDedupeKey(g);
      if (seen[key]) return;
      seen[key] = true;
      out.push(g);
    });
    return out;
  }

  /** ZCode scrape: drop identical rows (same start + same teams/ratios). */
  function dedupeZcodeScraped(games) {
    const seen = {};
    const out = [];
    (games || []).forEach((g) => {
      const start = String(g.gdate || '').trim();
      const key = [
        g.sport || '',
        start,
        canon(g.away || ''),
        canon(g.home || ''),
        g.publicRatio1,
        g.publicRatio2,
        g.mlPopular,
        g.mlPopular1,
        g.mlPopular2,
      ].join('\t');
      if (start && seen[key]) return;
      if (start) seen[key] = true;
      out.push(g);
    });
    return out;
  }

  function matchScoreToGame(g, scores) {
    const sport = g.sport || 'MLB';
    for (let i = 0; i < (scores || []).length; i++) {
      const f = scores[i];
      if (f.sport !== sport) continue;
      const direct =
        (teamsMatch(g.away, f.away, sport) ||
          teamsMatch(g.awayAbbr, f.awayAbbr, sport)) &&
        (teamsMatch(g.home, f.home, sport) ||
          teamsMatch(g.homeAbbr, f.homeAbbr, sport));
      const flipped =
        (teamsMatch(g.away, f.home, sport) ||
          teamsMatch(g.awayAbbr, f.homeAbbr, sport)) &&
        (teamsMatch(g.home, f.away, sport) ||
          teamsMatch(g.homeAbbr, f.awayAbbr, sport));
      if (direct) {
        return {
          scoreAway: f.scoreAway,
          scoreHome: f.scoreHome,
          scoreStatus: f.scoreStatus,
          scoreDetail: f.scoreDetail || null,
        };
      }
      if (flipped) {
        return {
          scoreAway: f.scoreHome,
          scoreHome: f.scoreAway,
          scoreStatus: f.scoreStatus,
          scoreDetail: f.scoreDetail || null,
        };
      }
    }
    return null;
  }

  function attachScoreToGame(g) {
    const scores = GM_getValue(SCORE_KEY, []) || [];
    const m = matchScoreToGame(g, scores);
    if (!m) return g;
    const out = Object.assign({}, g, {
      scoreAway: m.scoreAway,
      scoreHome: m.scoreHome,
      scoreStatus: m.scoreStatus || null,
      scoreDetail: m.scoreDetail || null,
    });
    if (m.scoreStatus === 'final') {
      out.finalAway = m.scoreAway;
      out.finalHome = m.scoreHome;
    }
    return out;
  }

  function buildSlate() {
    const zGames = readAllZcodeGames()
      .filter(hasZcodeRatioData)
      .map((z) =>
        Object.assign({}, z, {
          away: cleanTeamLabel(z.away),
          home: cleanTeamLabel(z.home),
        })
      );
    const pinnyGames = GM_getValue(PINNY_KEY, []) || [];
    const pinnyError = GM_getValue(PINNY_ERR_KEY, '') || '';
    const pinnyByZ = assignPinnyMatches(zGames, pinnyGames);

    const games = zGames.map((z, zi) => {
      const r1 = z.publicRatio1;
      const r2 = z.publicRatio2;
      let publicTeam = null;
      let fadeTeam = null;
      let publicRatio = null;
      let publicIsAway = null;

      if (Number.isFinite(r1) && Number.isFinite(r2)) {
        if (r1 >= r2) {
          publicTeam = z.away;
          fadeTeam = z.home;
          publicRatio = r1;
          publicIsAway = true;
        } else {
          publicTeam = z.home;
          fadeTeam = z.away;
          publicRatio = r2;
          publicIsAway = false;
        }
      } else if (Number.isFinite(r1) || Number.isFinite(r2)) {
        if ((r1 || 0) >= (r2 || 0)) {
          publicTeam = z.away;
          fadeTeam = z.home;
          publicRatio = r1;
          publicIsAway = true;
        } else {
          publicTeam = z.home;
          fadeTeam = z.away;
          publicRatio = r2;
          publicIsAway = false;
        }
      }

      const match = pinnyByZ[zi] || null;
      let pinnyMatched = false;
      let market = MARKET_BY_SPORT[z.sport] || 'ml';
      let openAway = null;
      let openHome = null;
      let currAway = null;
      let currHome = null;
      let openAwayJuice = null;
      let openHomeJuice = null;
      let currAwayJuice = null;
      let currHomeJuice = null;
      let move = {
        centsMoved: null,
        pinnyToward: 'unknown',
        pinnyTowardTeam: null,
      };
      let pinnyTowardLabel = null;

      if (match) {
        pinnyMatched = true;
        const p = match.pinny;
        market = p.market || market;

        if (market === 'spread') {
          if (match.flipped) {
            currAway = p.homeSpread;
            currHome = p.awaySpread;
            openAway = p.openHomeSpread;
            openHome = p.openAwaySpread;
            currAwayJuice = p.homeJuice;
            currHomeJuice = p.awayJuice;
            openAwayJuice = p.openHomeJuice;
            openHomeJuice = p.openAwayJuice;
          } else {
            currAway = p.awaySpread;
            currHome = p.homeSpread;
            openAway = p.openAwaySpread;
            openHome = p.openHomeSpread;
            currAwayJuice = p.awayJuice;
            currHomeJuice = p.homeJuice;
            openAwayJuice = p.openAwayJuice;
            openHomeJuice = p.openHomeJuice;
          }
        } else if (match.flipped) {
          currAway = p.homeAm;
          currHome = p.awayAm;
          openAway = p.openHomeAm;
          openHome = p.openAwayAm;
        } else {
          currAway = p.awayAm;
          currHome = p.homeAm;
          openAway = p.openAwayAm;
          openHome = p.openHomeAm;
        }

        const fadeIsAway = fadeTeam === z.away;
        move = computeMove(
          market,
          openAway,
          openHome,
          currAway,
          currHome,
          publicIsAway,
          fadeIsAway
        );

        if (move.pinnyTowardTeam === 'away') pinnyTowardLabel = z.away;
        else if (move.pinnyTowardTeam === 'home') pinnyTowardLabel = z.home;
        else if (move.pinnyToward === 'unchanged') pinnyTowardLabel = 'Flat';
      }

      const notRespected = pinnyMatched && move.pinnyToward === 'fade';

      // Favorite % ratio (lower American / more negative spread = fav)
      let favRatio = null;
      const aLine = Number.isFinite(currAway) ? currAway : openAway;
      const hLine = Number.isFinite(currHome) ? currHome : openHome;
      if (Number.isFinite(aLine) && Number.isFinite(hLine) && aLine !== hLine) {
        favRatio = aLine < hLine ? r1 : r2;
        if (!Number.isFinite(favRatio)) favRatio = null;
      }

      const sport = z.sport || 'MLB';
      const awayName = z.away;
      const homeName = z.home;
      let awayAbbr = teamId(awayName, sport) || '';
      let homeAbbr = teamId(homeName, sport) || '';
      if (match) {
        const p = match.pinny;
        if (match.flipped) {
          awayAbbr = p.homeAbbr || awayAbbr;
          homeAbbr = p.awayAbbr || homeAbbr;
        } else {
          awayAbbr = p.awayAbbr || awayAbbr;
          homeAbbr = p.homeAbbr || homeAbbr;
        }
      }
      // Bad / missing abbr → first 3 letters of name (no spaces)
      const abbrOk = (a) =>
        a && String(a).length <= 4 && !/\s/.test(String(a)) && String(a).toUpperCase() !== 'W';
      if (!abbrOk(awayAbbr)) awayAbbr = fallbackAbbr(awayName);
      if (!abbrOk(homeAbbr)) homeAbbr = fallbackAbbr(homeName);

      // Prefer public side's ML ticket shade; else other side if game is shaded
      const hlAway = z.mlTixHl1 || null;
      const hlHome = z.mlTixHl2 || null;
      let mlTicketsHl = null;
      if (publicIsAway === true) mlTicketsHl = hlAway || hlHome;
      else if (publicIsAway === false) mlTicketsHl = hlHome || hlAway;
      else mlTicketsHl = strongerHl(hlAway, hlHome);

      // ML tickets popular rank "(X)" — game-level (same on both sides)
      let popularNumber = null;
      if (Number.isFinite(z.mlPopular) && z.mlPopular >= 1) {
        popularNumber = z.mlPopular;
      } else if (publicIsAway === true && Number.isFinite(z.mlPopular1) && z.mlPopular1 >= 1) {
        popularNumber = z.mlPopular1;
      } else if (publicIsAway === false && Number.isFinite(z.mlPopular2) && z.mlPopular2 >= 1) {
        popularNumber = z.mlPopular2;
      } else if (Number.isFinite(z.mlPopular1) && z.mlPopular1 >= 1) {
        popularNumber = z.mlPopular1;
      } else if (Number.isFinite(z.mlPopular2) && z.mlPopular2 >= 1) {
        popularNumber = z.mlPopular2;
      }

      // ML / spread tickets *difference* shade (usually same under both teams)
      const tixDiffHl = strongerHl(
        strongerHl(z.mlTixDiffHl1, z.mlTixDiffHl2),
        strongerHl(z.spreadTixDiffHl1, z.spreadTixDiffHl2)
      );

      return {
        sport,
        market,
        gameId: z.gameId,
        eventId: match ? match.pinny.eventId || null : null,
        awayPartid: match
          ? match.flipped
            ? match.pinny.homePartid
            : match.pinny.awayPartid
          : null,
        homePartid: match
          ? match.flipped
            ? match.pinny.awayPartid
            : match.pinny.homePartid
          : null,
        away: awayName,
        home: homeName,
        awayAbbr,
        homeAbbr,
        gdate: z.gdate,
        ranking: z.ranking,
        publicTeam,
        fadeTeam,
        publicRatio,
        publicRatio1: r1,
        publicRatio2: r2,
        favRatio,
        popularNumber,
        mlTicketsHl,
        tixDiffHl,
        pinnyMatched,
        openAway,
        openHome,
        currAway,
        currHome,
        openAwayJuice,
        openHomeJuice,
        currAwayJuice,
        currHomeJuice,
        centsMoved: move.centsMoved,
        pinnyToward: move.pinnyToward,
        pinnyTowardTeam: pinnyTowardLabel,
        notRespected,
        scoreAway: null,
        scoreHome: null,
        scoreStatus: null,
        scoreDetail: null,
        finalAway: null,
        finalHome: null,
      };
    });

    const deduped = dedupeExactGames(games).map((g) => attachScoreToGame(g));
    const slams = (GM_getValue(SLAMS_KEY, []) || []).slice().sort((a, b) => {
      return (a.slamTime || 0) - (b.slamTime || 0);
    });

    return {
      updatedAt: GM_getValue(ZCODE_TS_KEY, 0) || Date.now(),
      pinnyUpdatedAt: GM_getValue(PINNY_TS_KEY, 0) || null,
      scoresUpdatedAt: GM_getValue(SCORE_TS_KEY, 0) || null,
      pinnyError,
      sportsPresent: resolveSportsPresent(zGames, pinnyGames),
      games: deduped,
      slams,
    };
  }

  function resolveSportsPresent(zGames, pinnyGames) {
    const set = {};
    (zGames || []).forEach((g) => {
      if (g.sport) set[g.sport] = true;
    });
    (pinnyGames || []).forEach((g) => {
      if (g.sport) set[g.sport] = true;
    });
    const stored = GM_getValue(SPORTS_KEY, []) || [];
    stored.forEach((s) => {
      set[s] = true;
    });
    return Object.keys(set).filter((s) => ZCODE_URLS[s]).sort();
  }

  function openZcodeTabsForSports(sports) {
    try {
      GM_openInTab(BMR_ODDS_SCORES_URL, {
        active: false,
        insert: true,
        setParent: true,
      });
      log('Opened BMR odds-scores');
    } catch (e) {
      try {
        window.open(BMR_ODDS_SCORES_URL, '_blank');
      } catch (_) {}
      log('open odds-scores fail', e && e.message);
    }
    const list = sports && sports.length ? sports : Object.keys(ZCODE_URLS);
    list.forEach((sport) => {
      const url = ZCODE_URLS[sport];
      if (!url) return;
      try {
        GM_openInTab(url, { active: false, insert: true, setParent: true });
        log('Opened ZCode', sport);
      } catch (e) {
        try {
          window.open(url, '_blank');
        } catch (_) {}
        log('open tab fail', sport, e && e.message);
      }
    });
  }

  function publishSlate() {
    if (!isDashboardPage()) return;
    const slate = buildSlate();
    try {
      window.__PINNY_FADE_SLATE__ = slate;
      window.dispatchEvent(new CustomEvent('pinny-fade-slate', { detail: slate }));
    } catch (e) {
      log('Dashboard push failed', e && e.message);
    }
    if (slate.games && slate.games.length) scheduleAutoBackup();
  }

  let autoBackupTimer = null;
  function scheduleAutoBackup() {
    if (!isDashboardPage()) return;
    if (autoBackupTimer) clearTimeout(autoBackupTimer);
    autoBackupTimer = setTimeout(() => {
      autoBackupTimer = null;
      backupHistoryNow(false);
    }, BACKUP_DEBOUNCE_MS);
  }

  function isDashboardPage() {
    if (!document.getElementById('slateTable')) return false;
    const path = (location.pathname || '').toLowerCase();
    if (path.indexOf('history.html') >= 0) return false;
    return true;
  }

  function clearDashboardSessionStale() {
    // Clear odds only — ZCode tabs own ratio IPC; wiping them caused partial
    // re-scrapes to look like “correct then wrong/missing”.
    GM_setValue(PINNY_KEY, []);
    GM_setValue(PINNY_ERR_KEY, '');
    GM_setValue(PINNY_TS_KEY, 0);
  }

  function runDashboardBridge() {
    if (!isDashboardPage()) return;
    log('Dashboard bridge active');

    clearDashboardSessionStale();

    const push = () => publishSlate();
    push();
    setInterval(push, DASHBOARD_PUSH_MS);

    window.addEventListener('pinny-fade-request-refresh', () => {
      pollPinnyOdds().then(() => {
        try {
          backupHistoryNow(false);
        } catch (_) {}
      });
    });

    window.addEventListener('pinny-fade-open-zcode', (e) => {
      const sports =
        (e && e.detail && e.detail.sports) ||
        GM_getValue(SPORTS_KEY, []) ||
        Object.keys(ZCODE_URLS);
      openZcodeTabsForSports(sports);
    });

    window.addEventListener('pinny-fade-request-backup', () => {
      backupHistoryNow(true);
    });

    try {
      if (typeof GM_addValueChangeListener === 'function') {
        Object.keys(ZCODE_SPORT_KEYS).forEach((sport) => {
          GM_addValueChangeListener(ZCODE_SPORT_KEYS[sport], () => publishSlate());
        });
        GM_addValueChangeListener(PINNY_KEY, () => publishSlate());
        GM_addValueChangeListener(PINNY_ERR_KEY, () => publishSlate());
      }
    } catch (e) {
      log('GM_addValueChangeListener unavailable', e && e.message);
    }

    try {
      if (!document.getElementById('pinny-fade-tm-badge')) {
        const b = document.createElement('div');
        b.id = 'pinny-fade-tm-badge';
        b.textContent = 'TM companion connected';
        b.style.cssText =
          'position:fixed;bottom:12px;right:12px;z-index:99999;padding:6px 10px;border-radius:8px;background:#2dd4a8;color:#041018;font:600 12px/1.2 Segoe UI,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.35)';
        document.body.appendChild(b);
      }
    } catch (_) {}

    runHistoryScheduler();
  }

  // --- GitHub history backup + W/P/L ---

  function nyDateKey(ms) {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(ms || Date.now()));
    } catch (_) {
      return new Date(ms || Date.now()).toISOString().slice(0, 10);
    }
  }

  function emitBackupStatus(ok, message, meta) {
    if (!isDashboardPage()) return;
    try {
      window.dispatchEvent(
        new CustomEvent('pinny-fade-backup-status', {
          detail: { ok: !!ok, message: message || '', meta: meta || '' },
        })
      );
    } catch (_) {}
  }

  function getGithubConfig() {
    const token = String(GM_getValue(GH_TOKEN_KEY, '') || '').trim();
    const repo = String(GM_getValue(GH_REPO_KEY, '') || '').trim();
    const branch = String(GM_getValue(GH_BRANCH_KEY, 'main') || 'main').trim() || 'main';
    return { token, repo, branch };
  }

  function promptGithubToken() {
    const cur = GM_getValue(GH_TOKEN_KEY, '') || '';
    const next = window.prompt(
      'GitHub PAT (repo scope) for continual history backups:',
      cur
    );
    if (next == null) return;
    GM_setValue(GH_TOKEN_KEY, String(next).trim());
    log('GitHub token saved');
  }

  function promptGithubRepo() {
    const cur = GM_getValue(GH_REPO_KEY, '') || '';
    const next = window.prompt('GitHub repo as owner/name:', cur);
    if (next == null) return;
    GM_setValue(GH_REPO_KEY, String(next).trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, ''));
    const br = window.prompt('Branch:', GM_getValue(GH_BRANCH_KEY, 'main') || 'main');
    if (br != null) GM_setValue(GH_BRANCH_KEY, String(br).trim() || 'main');
    log('GitHub repo saved', GM_getValue(GH_REPO_KEY, ''));
  }

  function utf8ToBase64(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }

  function base64ToUtf8(b64) {
    return decodeURIComponent(escape(atob(b64)));
  }

  function gmRequest(opts) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: opts.method || 'GET',
        url: opts.url,
        headers: opts.headers || {},
        data: opts.data,
        timeout: opts.timeout || 45000,
        onload(res) {
          resolve(res);
        },
        onerror() {
          reject(new Error('network error'));
        },
        ontimeout() {
          reject(new Error('timeout'));
        },
      });
    });
  }

  async function githubGetContent(path) {
    const { token, repo, branch } = getGithubConfig();
    if (!token || !repo) throw new Error('Set GitHub token + repo in Tampermonkey menu');
    const url =
      `https://api.github.com/repos/${repo}/contents/${path}` +
      `?ref=${encodeURIComponent(branch)}`;
    const res = await gmRequest({
      method: 'GET',
      url,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (res.status === 404) return { sha: null, json: null, raw: null };
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`GitHub GET ${res.status}: ${(res.responseText || '').slice(0, 160)}`);
    }
    const body = JSON.parse(res.responseText);
    let raw = '';
    if (body.content) {
      raw = base64ToUtf8(String(body.content).replace(/\n/g, ''));
    }
    let json = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch (_) {
      json = null;
    }
    return { sha: body.sha || null, json, raw };
  }

  async function githubPutContent(path, obj, sha, message) {
    const { token, repo, branch } = getGithubConfig();
    if (!token || !repo) throw new Error('Set GitHub token + repo in Tampermonkey menu');
    const content = utf8ToBase64(JSON.stringify(obj, null, 2) + '\n');
    const payload = {
      message: message || `pinny-fade: update ${path}`,
      content,
      branch,
    };
    if (sha) payload.sha = sha;
    const res = await gmRequest({
      method: 'PUT',
      url: `https://api.github.com/repos/${repo}/contents/${path}`,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      data: JSON.stringify(payload),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`GitHub PUT ${res.status}: ${(res.responseText || '').slice(0, 200)}`);
    }
    return JSON.parse(res.responseText);
  }

  function gameKey(g) {
    return [
      g.sport || '',
      g.gameId || '',
      canon(g.away || ''),
      canon(g.home || ''),
    ].join('|');
  }

  function buildHistoryPayload(slate, prior) {
    const date = nyDateKey(Date.now());
    const priorByKey = {};
    ((prior && prior.games) || []).forEach((g) => {
      priorByKey[gameKey(g)] = g;
    });
    const seen = {};
    const games = [];

    ((slate && slate.games) || []).forEach((g) => {
      const key = gameKey(g);
      seen[key] = true;
      const prev = priorByKey[key] || {};
      const graded =
        prev.result === 'W' || prev.result === 'L' || prev.result === 'P';
      games.push(
        Object.assign({}, g, {
          finalAway:
            graded && prev.finalAway != null
              ? prev.finalAway
              : g.finalAway != null
                ? g.finalAway
                : prev.finalAway != null
                  ? prev.finalAway
                  : null,
          finalHome:
            graded && prev.finalHome != null
              ? prev.finalHome
              : g.finalHome != null
                ? g.finalHome
                : prev.finalHome != null
                  ? prev.finalHome
                  : null,
          result: graded
            ? prev.result
            : prev.result && prev.result !== 'pending'
              ? prev.result
              : 'pending',
          resultNote: graded
            ? prev.resultNote || ''
            : prev.resultNote || g.resultNote || '',
          scoreAway: g.scoreAway != null ? g.scoreAway : prev.scoreAway,
          scoreHome: g.scoreHome != null ? g.scoreHome : prev.scoreHome,
          scoreStatus: g.scoreStatus || prev.scoreStatus || null,
          scoreDetail: g.scoreDetail || prev.scoreDetail || null,
        })
      );
    });

    // Preserve finished / dropped games that left the live ZCode slate
    ((prior && prior.games) || []).forEach((g) => {
      const key = gameKey(g);
      if (seen[key]) return;
      games.push(g);
    });

    const sportsSet = {};
    games.forEach((g) => {
      if (g.sport) sportsSet[g.sport] = true;
    });
    ((slate && slate.sportsPresent) || []).forEach((s) => {
      sportsSet[s] = true;
    });

    return {
      date,
      exportedAt: Date.now(),
      sportsPresent: Object.keys(sportsSet).sort(),
      games,
      slams: mergeSlams((prior && prior.slams) || [], (slate && slate.slams) || []),
    };
  }

  function slamDedupeKey(s) {
    const books = (s.books || []).slice().sort().join(',');
    const windowBucket = Math.floor((s.slamTime || 0) / (SLAM_WINDOW_MS / 2));
    return [
      s.sport || '',
      s.eventId || '',
      canon(s.away || ''),
      canon(s.home || ''),
      canon(s.towardTeam || ''),
      books,
      windowBucket,
    ].join('|');
  }

  function mergeSlams(prior, next) {
    const byKey = {};
    (prior || []).concat(next || []).forEach((s) => {
      if (!s || !s.slamTime) return;
      const key = s.id || slamDedupeKey(s);
      const prev = byKey[key];
      if (!prev || (s.slamTime || 0) >= (prev.slamTime || 0)) {
        byKey[key] = s;
      }
    });
    return Object.keys(byKey)
      .map((k) => byKey[k])
      .sort((a, b) => (a.slamTime || 0) - (b.slamTime || 0));
  }

  function takeIsAway(g) {
    const take = g.fadeTeam || '';
    if (!take) return null;
    if (teamsMatch(take, g.away, g.sport || 'MLB')) return true;
    if (teamsMatch(take, g.home, g.sport || 'MLB')) return false;
    const t = canon(take);
    if (t && t === canon(g.away)) return true;
    if (t && t === canon(g.home)) return false;
    return null;
  }

  function gradeTake(g, finalAway, finalHome) {
    if (!Number.isFinite(finalAway) || !Number.isFinite(finalHome)) {
      return { result: 'pending', resultNote: 'awaiting final', finalAway, finalHome };
    }
    const side = takeIsAway(g);
    if (side == null) {
      return {
        result: 'pending',
        resultNote: 'cannot resolve Take side',
        finalAway,
        finalHome,
      };
    }
    const market = g.market || MARKET_BY_SPORT[g.sport] || 'ml';
    if (market === 'ml') {
      if (finalAway === finalHome) {
        return { result: 'P', resultNote: 'tie', finalAway, finalHome };
      }
      const takeWon = side ? finalAway > finalHome : finalHome > finalAway;
      return {
        result: takeWon ? 'W' : 'L',
        resultNote: takeWon ? 'Take ML won' : 'Take ML lost',
        finalAway,
        finalHome,
      };
    }
    const takeSpread = side ? Number(g.currAway) : Number(g.currHome);
    if (!Number.isFinite(takeSpread)) {
      return {
        result: 'pending',
        resultNote: 'missing Take spread',
        finalAway,
        finalHome,
      };
    }
    const takeScore = side ? finalAway : finalHome;
    const oppScore = side ? finalHome : finalAway;
    const margin = takeScore - oppScore;
    const cover = margin + takeSpread;
    if (Math.abs(cover) < 1e-9) {
      return { result: 'P', resultNote: 'ATS push', finalAway, finalHome };
    }
    return {
      result: cover > 0 ? 'W' : 'L',
      resultNote: cover > 0 ? 'Take covered' : 'Take did not cover',
      finalAway,
      finalHome,
    };
  }

  async function fetchMlbScores(date) {
    const url =
      `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${encodeURIComponent(date)}` +
      `&hydrate=linescore`;
    const text = await gmGet(url, { Accept: 'application/json' });
    const data = JSON.parse(text);
    const out = [];
    ((data.dates || [])[0] && (data.dates || [])[0].games
      ? (data.dates || [])[0].games
      : []
    ).forEach((game) => {
      const abstract = ((game.status && game.status.abstractGameState) || '').toLowerCase();
      const detailed = ((game.status && game.status.detailedState) || '').toLowerCase();
      const away = game.teams && game.teams.away;
      const home = game.teams && game.teams.home;
      const awayName =
        (away && away.team && (away.team.teamName || away.team.name)) || '';
      const homeName =
        (home && home.team && (home.team.teamName || home.team.name)) || '';
      const awayAbbr = (away && away.team && away.team.abbreviation) || '';
      const homeAbbr = (home && home.team && home.team.abbreviation) || '';
      const coded = game.status && String(game.status.codedGameState || '');
      const isFinal =
        abstract === 'final' ||
        abstract === 'completed' ||
        coded === 'F' ||
        detailed.indexOf('final') >= 0;
      const isLive = abstract === 'live' || coded === 'I' || detailed.indexOf('in progress') >= 0;
      if (!isFinal && !isLive) return;
      const aScore = away && away.score;
      const hScore = home && home.score;
      if (!Number.isFinite(Number(aScore)) || !Number.isFinite(Number(hScore))) return;
      let scoreDetail = null;
      const ls = game.linescore || {};
      if (isLive) {
        const inn = ls.currentInningOrdinal || ls.currentInning || '';
        const half = (ls.inningState || '').slice(0, 3);
        scoreDetail = [half, inn].filter(Boolean).join(' ') || 'Live';
      } else {
        scoreDetail = 'F';
      }
      const row = {
        sport: 'MLB',
        away: awayName,
        home: homeName,
        awayAbbr,
        homeAbbr,
        scoreAway: Number(aScore),
        scoreHome: Number(hScore),
        scoreStatus: isFinal ? 'final' : 'live',
        scoreDetail,
      };
      if (isFinal) {
        row.finalAway = row.scoreAway;
        row.finalHome = row.scoreHome;
      }
      out.push(row);
    });
    return out;
  }

  /** Finals-only wrapper for history grading. */
  async function fetchMlbFinals(date) {
    return (await fetchMlbScores(date)).filter((s) => s.scoreStatus === 'final');
  }

  async function fetchEspnScores(sport, date) {
    const path =
      sport === 'NFL'
        ? 'football/nfl'
        : sport === 'WNBA'
          ? 'basketball/wnba'
          : null;
    if (!path) return [];
    const ymd = String(date).replace(/-/g, '');
    const url = `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${ymd}`;
    const text = await gmGet(url, { Accept: 'application/json' });
    const data = JSON.parse(text);
    const out = [];
    (data.events || []).forEach((ev) => {
      const comp = (ev.competitions && ev.competitions[0]) || null;
      if (!comp) return;
      const st = (comp.status && comp.status.type) || {};
      const state = String(st.state || '').toLowerCase();
      const completed = state === 'post' || !!st.completed;
      const isLive = state === 'in';
      if (!completed && !isLive) return;
      const competitors = comp.competitors || [];
      let away = null;
      let home = null;
      competitors.forEach((c) => {
        if (c.homeAway === 'away') away = c;
        if (c.homeAway === 'home') home = c;
      });
      if (!away || !home) return;
      const aScore = Number(away.score);
      const hScore = Number(home.score);
      if (!Number.isFinite(aScore) || !Number.isFinite(hScore)) return;
      let scoreDetail = null;
      if (completed) {
        scoreDetail = 'F';
      } else {
        const period = st.shortDetail || st.detail || st.description || 'Live';
        scoreDetail = String(period);
      }
      const row = {
        sport,
        away: (away.team && (away.team.shortDisplayName || away.team.displayName)) || '',
        home: (home.team && (home.team.shortDisplayName || home.team.displayName)) || '',
        awayAbbr: (away.team && away.team.abbreviation) || '',
        homeAbbr: (home.team && home.team.abbreviation) || '',
        scoreAway: aScore,
        scoreHome: hScore,
        scoreStatus: completed ? 'final' : 'live',
        scoreDetail,
      };
      if (completed) {
        row.finalAway = aScore;
        row.finalHome = hScore;
      }
      out.push(row);
    });
    return out;
  }

  async function fetchEspnFinals(sport, date) {
    return (await fetchEspnScores(sport, date)).filter((s) => s.scoreStatus === 'final');
  }

  function matchFinalToGame(g, finals) {
    const sport = g.sport || 'MLB';
    for (let i = 0; i < finals.length; i++) {
      const f = finals[i];
      if (f.sport !== sport) continue;
      const fa = f.finalAway != null ? f.finalAway : f.scoreAway;
      const fh = f.finalHome != null ? f.finalHome : f.scoreHome;
      const direct =
        (teamsMatch(g.away, f.away, sport) || teamsMatch(g.awayAbbr, f.awayAbbr, sport)) &&
        (teamsMatch(g.home, f.home, sport) || teamsMatch(g.homeAbbr, f.homeAbbr, sport));
      const flipped =
        (teamsMatch(g.away, f.home, sport) || teamsMatch(g.awayAbbr, f.homeAbbr, sport)) &&
        (teamsMatch(g.home, f.away, sport) || teamsMatch(g.homeAbbr, f.awayAbbr, sport));
      if (direct) return { finalAway: fa, finalHome: fh };
      if (flipped) return { finalAway: fh, finalHome: fa };
    }
    return null;
  }

  async function pollLiveScores() {
    if (!isDashboardPage()) return;
    const date = nyDateKey(Date.now());
    const slate = buildSlate();
    const sports = {};
    (slate.games || []).forEach((g) => {
      if (g.sport) sports[g.sport] = true;
    });
    if (!Object.keys(sports).length) {
      sports.MLB = true;
    }
    let scores = [];
    try {
      if (sports.MLB) scores = scores.concat(await fetchMlbScores(date));
    } catch (e) {
      log('MLB scores fail', e && e.message);
    }
    try {
      if (sports.NFL) scores = scores.concat(await fetchEspnScores('NFL', date));
    } catch (e) {
      log('NFL scores fail', e && e.message);
    }
    try {
      if (sports.WNBA) scores = scores.concat(await fetchEspnScores('WNBA', date));
    } catch (e) {
      log('WNBA scores fail', e && e.message);
    }
    GM_setValue(SCORE_KEY, scores);
    GM_setValue(SCORE_TS_KEY, Date.now());
    log('Scores updated', scores.length);
    publishSlate();
  }

  async function applyResultsToPayload(payload) {
    if (!payload || !Array.isArray(payload.games)) return payload;
    const date = payload.date || nyDateKey(Date.now());
    const sports = {};
    payload.games.forEach((g) => {
      if (g.sport) sports[g.sport] = true;
    });
    let finals = [];
    try {
      if (sports.MLB) finals = finals.concat(await fetchMlbFinals(date));
    } catch (e) {
      log('MLB finals fail', e && e.message);
    }
    try {
      if (sports.NFL) finals = finals.concat(await fetchEspnFinals('NFL', date));
    } catch (e) {
      log('NFL finals fail', e && e.message);
    }
    try {
      if (sports.WNBA) finals = finals.concat(await fetchEspnFinals('WNBA', date));
    } catch (e) {
      log('WNBA finals fail', e && e.message);
    }

    payload.games = payload.games.map((g) => {
      if (g.result === 'W' || g.result === 'L' || g.result === 'P') {
        if (g.finalAway != null && g.finalHome != null) return g;
      }
      const m = matchFinalToGame(g, finals);
      if (!m) {
        return Object.assign({}, g, {
          result: g.result || 'pending',
          resultNote: g.resultNote || 'awaiting final',
        });
      }
      const graded = gradeTake(g, m.finalAway, m.finalHome);
      return Object.assign({}, g, graded, {
        scoreAway: m.finalAway,
        scoreHome: m.finalHome,
        scoreStatus: 'final',
        scoreDetail: 'F',
      });
    });
    payload.resultsUpdatedAt = Date.now();
    return payload;
  }

  // --- Coordinated multi-book slam detection (BMR lineHistory) ---

  function historyTimMs(tim) {
    const n = Number(tim);
    if (!Number.isFinite(n) || n <= 0) return null;
    // SBR uses unix seconds (sometimes fractional)
    return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  }

  function parseHistoryLinesPayload(lines) {
    const arr = Array.isArray(lines) ? lines : [];
    const byPart = {};
    arr.forEach((ln) => {
      if (!ln || typeof ln !== 'object') return;
      const partid = Number(ln.partid);
      if (!Number.isFinite(partid)) return;
      const ap = Number(ln.ap);
      const adj = Number(ln.adj);
      byPart[partid] = {
        am: Number.isFinite(ap) ? ap : null,
        spread: Number.isFinite(adj) ? adj : null,
      };
    });
    return byPart;
  }

  async function fetchLineHistory(eid, mtid, paid, partids) {
    const parts = (partids || []).filter((p) => Number.isFinite(Number(p)));
    const partidArg = parts.length ? `partid:[${parts.join(',')}]` : '';
    const q =
      `{ lineHistory(eid:${Number(eid)},mtid:${Number(mtid)},paid:${Number(paid)}` +
      (partidArg ? `,${partidArg}` : '') +
      `){ tim lines } }`;
    const url = `${BMR_ODDS_V2}?query=${encodeURIComponent(q)}`;
    const text = await gmGet(url, { Accept: 'application/json' });
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      throw new Error('Invalid JSON from BMR lineHistory');
    }
    if (data.errors && data.errors.length) {
      const msg =
        (data.errors[0] && data.errors[0].message) || 'BMR lineHistory error';
      throw new Error(msg);
    }
    return (data.data && data.data.lineHistory) || [];
  }

  function extractBookMoves(history, market, awayPartid, homePartid, awayName, homeName) {
    const rowsRaw = (history || [])
      .map((h) => ({
        ts: historyTimMs(h.tim),
        parts: parseHistoryLinesPayload(h.lines),
      }))
      .filter((r) => r.ts != null)
      .sort((a, b) => a.ts - b.ts);

    // Forward-fill each side so one-sided ticks still yield a full A/H pair
    let lastA = null;
    let lastH = null;
    const rows = [];
    rowsRaw.forEach((r) => {
      if (r.parts[awayPartid]) lastA = r.parts[awayPartid];
      if (r.parts[homePartid]) lastH = r.parts[homePartid];
      if (!lastA || !lastH) return;
      rows.push({
        ts: r.ts,
        parts: {
          [awayPartid]: lastA,
          [homePartid]: lastH,
        },
      });
    });

    const moves = [];
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const curr = rows[i];
      const pA = prev.parts[awayPartid];
      const pH = prev.parts[homePartid];
      const cA = curr.parts[awayPartid];
      const cH = curr.parts[homePartid];
      if (!pA || !pH || !cA || !cH) continue;

      if (market === 'spread') {
        if (
          !Number.isFinite(pA.spread) ||
          !Number.isFinite(pH.spread) ||
          !Number.isFinite(cA.spread) ||
          !Number.isFinite(cH.spread)
        ) {
          continue;
        }
        const dAway = cA.spread - pA.spread;
        const dHome = cH.spread - pH.spread;
        // Line move only — ignore juice-only
        if (Math.abs(dAway) < SLAM_MIN_SPREAD - 1e-9 && Math.abs(dHome) < SLAM_MIN_SPREAD - 1e-9) {
          continue;
        }
        if (Math.abs(dAway - dHome) < 0.05) continue;
        // More negative spread = toward that side
        let towardTeam = null;
        let from = null;
        let to = null;
        let pts = null;
        if (dAway < dHome) {
          towardTeam = awayName;
          from = pA.spread;
          to = cA.spread;
          pts = Math.abs(dAway);
        } else {
          towardTeam = homeName;
          from = pH.spread;
          to = cH.spread;
          pts = Math.abs(dHome);
        }
        if (pts < SLAM_MIN_SPREAD - 1e-9) continue;
        moves.push({
          ts: curr.ts,
          towardTeam,
          from,
          to,
          magnitude: pts,
          market: 'spread',
        });
      } else {
        if (
          !Number.isFinite(pA.am) ||
          !Number.isFinite(pH.am) ||
          !Number.isFinite(cA.am) ||
          !Number.isFinite(cH.am)
        ) {
          continue;
        }
        const iA0 = americanToImplied(pA.am);
        const iH0 = americanToImplied(pH.am);
        const iA1 = americanToImplied(cA.am);
        const iH1 = americanToImplied(cH.am);
        if ([iA0, iH0, iA1, iH1].some((x) => x == null)) continue;
        const dA = iA1 - iA0;
        const dH = iH1 - iH0;
        if (Math.abs(dA - dH) < 0.002) continue;
        let towardTeam = null;
        let from = null;
        let to = null;
        let cents = null;
        if (dA > dH) {
          towardTeam = awayName;
          from = pA.am;
          to = cA.am;
          cents = Math.abs(americanCentsDelta(pA.am, cA.am));
        } else {
          towardTeam = homeName;
          from = pH.am;
          to = cH.am;
          cents = Math.abs(americanCentsDelta(pH.am, cH.am));
        }
        if (!Number.isFinite(cents) || cents < SLAM_MIN_CENTS) continue;
        moves.push({
          ts: curr.ts,
          towardTeam,
          from,
          to,
          magnitude: cents,
          market: 'ml',
        });
      }
    }
    return moves;
  }

  function pickSlamBatch(candidates) {
    if (!candidates.length) return [];
    // Round-robin across sports so NFL/WNBA aren't starved by MLB volume
    const bySport = {};
    candidates.forEach((g) => {
      const s = g.sport || 'MLB';
      if (!bySport[s]) bySport[s] = [];
      bySport[s].push(g);
    });
    const sports = Object.keys(bySport).sort();
    const cursor = Number(GM_getValue(SLAM_CURSOR_KEY, 0)) || 0;
    const indices = {};
    sports.forEach((s) => {
      indices[s] = 0;
    });
    const out = [];
    let i = 0;
    while (out.length < SLAM_BATCH && i < candidates.length * 2) {
      const sport = sports[(cursor + i) % sports.length];
      i++;
      const bucket = bySport[sport];
      if (!bucket || !bucket.length) continue;
      const idx = indices[sport] % bucket.length;
      indices[sport]++;
      const g = bucket[idx];
      if (out.some((x) => x === g)) continue;
      out.push(g);
    }
    GM_setValue(SLAM_CURSOR_KEY, cursor + 1);
    return out;
  }

  function clusterSlamMoves(game, bookMoves) {
    // bookMoves: [{ book, moves: [...] }]
    const flat = [];
    bookMoves.forEach((bm) => {
      (bm.moves || []).forEach((m) => {
        flat.push(Object.assign({}, m, { book: bm.book }));
      });
    });
    if (flat.length < 2) return [];

    flat.sort((a, b) => a.ts - b.ts);
    const clusters = [];
    const used = {};

    for (let i = 0; i < flat.length; i++) {
      if (used[i]) continue;
      const seed = flat[i];
      const group = [seed];
      const groupIdx = [i];
      for (let j = i + 1; j < flat.length; j++) {
        if (used[j]) continue;
        const other = flat[j];
        if (Math.abs(other.ts - seed.ts) > SLAM_WINDOW_MS) continue;
        if (canon(other.towardTeam) !== canon(seed.towardTeam)) continue;
        if (group.some((g) => g.book === other.book)) continue;
        group.push(other);
        groupIdx.push(j);
      }
      if (group.length < 2) continue;
      groupIdx.forEach((idx) => {
        used[idx] = true;
      });
      const books = group.map((g) => g.book).sort();
      const slamTime = Math.max.apply(
        null,
        group.map((g) => g.ts)
      );
      const earliest = Math.min.apply(
        null,
        group.map((g) => g.ts)
      );
      const id = slamDedupeKey({
        sport: game.sport,
        eventId: game.eventId,
        away: game.away,
        home: game.home,
        towardTeam: seed.towardTeam,
        books,
        slamTime,
      });
      clusters.push({
        id,
        slamTime,
        spanMs: slamTime - earliest,
        sport: game.sport,
        market: game.market || MARKET_BY_SPORT[game.sport] || 'ml',
        eventId: game.eventId || null,
        away: game.away,
        home: game.home,
        awayAbbr: game.awayAbbr,
        homeAbbr: game.homeAbbr,
        towardTeam: seed.towardTeam,
        books,
        moves: group.map((g) => ({
          book: g.book,
          ts: g.ts,
          from: g.from,
          to: g.to,
          magnitude: g.magnitude,
          market: g.market,
        })),
      });
    }
    return clusters;
  }

  let slamPollInFlight = false;

  async function pollSlams() {
    if (!isDashboardPage()) return;
    if (slamPollInFlight) return;
    slamPollInFlight = true;
    try {
      const slate = buildSlate();
      const candidates = (slate.games || []).filter(
        (g) =>
          g.eventId &&
          Number.isFinite(Number(g.awayPartid)) &&
          Number.isFinite(Number(g.homePartid))
      );
      if (!candidates.length) return;

      const batch = pickSlamBatch(candidates);
      const found = [];

      for (let gi = 0; gi < batch.length; gi++) {
        const g = batch[gi];
        const mtid = BMR_MTID_BY_SPORT[g.sport] || 83;
        const market = g.market || MARKET_BY_SPORT[g.sport] || 'ml';
        const bookMoves = [];
        for (let bi = 0; bi < SLAM_BOOKS.length; bi++) {
          const book = SLAM_BOOKS[bi];
          try {
            const hist = await fetchLineHistory(
              g.eventId,
              mtid,
              book.paid,
              [g.awayPartid, g.homePartid]
            );
            const moves = extractBookMoves(
              hist,
              market,
              Number(g.awayPartid),
              Number(g.homePartid),
              g.away,
              g.home
            );
            if (moves.length) bookMoves.push({ book: book.name, moves });
          } catch (e) {
            log('lineHistory', book.name, g.eventId, e && e.message);
          }
        }
        found.push.apply(found, clusterSlamMoves(g, bookMoves));
      }

      const prior = GM_getValue(SLAMS_KEY, []) || [];
      const merged = mergeSlams(prior, found);
      GM_setValue(SLAMS_KEY, merged.slice(0, 200));
      if (found.length) log('Slams detected', found.length, 'total', merged.length);
      publishSlate();
      if (found.length) scheduleAutoBackup();
    } catch (e) {
      log('Slam poll fail', e && e.message);
    } finally {
      slamPollInFlight = false;
    }
  }

  let backupInFlight = false;

  async function backupHistoryNow(force) {
    if (!isDashboardPage()) return;
    if (backupInFlight) return;
    const cfg = getGithubConfig();
    if (!cfg.token || !cfg.repo) {
      if (force) {
        emitBackupStatus(
          false,
          'GitHub backup not configured',
          'Tampermonkey menu → Set GitHub token / repo'
        );
      }
      return;
    }
    const slate = buildSlate();
    if (!slate.games || !slate.games.length) {
      if (force) emitBackupStatus(false, 'No games to backup yet', '');
      return;
    }

    backupInFlight = true;
    try {
      const date = nyDateKey(Date.now());
      const dayPath = `history/${date}.json`;
      const existing = await githubGetContent(dayPath);
      let payload = buildHistoryPayload(slate, existing.json);
      payload = await applyResultsToPayload(payload);
      await githubPutContent(
        dayPath,
        payload,
        existing.sha,
        `pinny-fade: archive ${date} (${payload.games.length} games)`
      );

      const indexPath = 'history/index.json';
      const indexFile = await githubGetContent(indexPath);
      const days = Array.isArray(indexFile.json && indexFile.json.days)
        ? indexFile.json.days.slice()
        : [];
      const filtered = days.filter((d) => d && d !== date);
      filtered.unshift(date);
      await githubPutContent(
        indexPath,
        { days: filtered },
        indexFile.sha,
        `pinny-fade: index ${date}`
      );

      log('GitHub backup ok', date, payload.games.length);
      emitBackupStatus(
        true,
        `Backed up ${payload.games.length} games`,
        `${date} → ${cfg.repo}`
      );
    } catch (e) {
      log('GitHub backup fail', e && e.message);
      emitBackupStatus(false, 'GitHub backup failed', (e && e.message) || '');
    } finally {
      backupInFlight = false;
    }
  }

  async function updateRecentResults() {
    const cfg = getGithubConfig();
    if (!cfg.token || !cfg.repo) {
      emitBackupStatus(false, 'GitHub not configured', 'Set token + repo first');
      return;
    }
    try {
      const indexFile = await githubGetContent('history/index.json');
      const days = ((indexFile.json && indexFile.json.days) || []).slice(0, 5);
      for (let i = 0; i < days.length; i++) {
        const date = days[i];
        const dayPath = `history/${date}.json`;
        const existing = await githubGetContent(dayPath);
        if (!existing.json) continue;
        const updated = await applyResultsToPayload(existing.json);
        await githubPutContent(
          dayPath,
          updated,
          existing.sha,
          `pinny-fade: results ${date}`
        );
        log('Results updated', date);
      }
      emitBackupStatus(true, 'Results updated', days.join(', '));
    } catch (e) {
      emitBackupStatus(false, 'Results update failed', e && e.message);
    }
  }

  function runHistoryScheduler() {
    if (!isDashboardPage()) return;
    // First backup as soon as slate exists; then every minute + on each slate push
    setTimeout(() => backupHistoryNow(false), 4000);
    setInterval(() => backupHistoryNow(false), BACKUP_MS);
    setTimeout(() => updateRecentResults(), 20000);
    setInterval(() => updateRecentResults(), RESULTS_MS);
    setTimeout(() => pollLiveScores(), 6000);
    setInterval(() => pollLiveScores(), SCORE_MS);
    setTimeout(() => pollSlams(), 12000);
    setInterval(() => pollSlams(), SLAM_MS);

    const cfg = getGithubConfig();
    if (!cfg.token || !cfg.repo) {
      setTimeout(() => {
        emitBackupStatus(
          false,
          'GitHub backup not configured',
          'TM menu → Set GitHub token / repo (needed for History)'
        );
      }, 2500);
    }
  }

  try {
    GM_registerMenuCommand('Poll Bet105 / Pinny now', () => {
      if (isDashboardPage()) pollPinnyOdds();
      else log('Open the dashboard tab to poll Bet105');
    });
    GM_registerMenuCommand('Poll live scores now', () => {
      if (isDashboardPage()) pollLiveScores();
      else log('Open the dashboard tab to poll scores');
    });
    GM_registerMenuCommand('Poll coordinated slams now', () => {
      if (isDashboardPage()) pollSlams();
      else log('Open the dashboard tab to poll slams');
    });
    GM_registerMenuCommand('Open odds-scores + ZCode tabs', () =>
      openZcodeTabsForSports(Object.keys(ZCODE_URLS))
    );
    GM_registerMenuCommand('Set GitHub token (history backup)', promptGithubToken);
    GM_registerMenuCommand('Set GitHub repo / branch', promptGithubRepo);
    GM_registerMenuCommand('Backup history now', () => backupHistoryNow(true));
    GM_registerMenuCommand('Update recent W/P/L results', () => updateRecentResults());
  } catch (_) {}

  runZcodeLoop();
  runPinnyScheduler();
  runDashboardBridge();
  runOddsScoresWatch();
  log('Ready (MLB + NFL + WNBA · scores + slams v1.7.1)');
})();
