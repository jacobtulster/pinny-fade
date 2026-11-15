// ==UserScript==
// @name         4C Odds — TDRs only
// @namespace    https://github.com/local/pinny-fade
// @version      3.11.0
// @description  Board TDR ranks; My Line Take from Book League + Best-col; agree% = share of vote weight; OTC; ZCode (multi-sport / Open Zcode); glow; Take+ratio rec panel (O→C steam boost) with record /10 vs whole league; Book League ATS/ML cover grades (GitHub global store; NCAAB + NBA Cup→NBA).
// @author       You
// @match        https://4codds.com/*
// @match        https://www.4codds.com/*
// @match        https://m.4codds.com/*
// @match        https://zcodesystem.com/linereversals.php*
// @match        https://www.zcodesystem.com/linereversals.php*
// @match        http://localhost/*
// @match        http://127.0.0.1/*
// @match        https://jacobtulster.github.io/pinny-fade/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      api.github.com
// @connect      raw.githubusercontent.com
// @connect      site.api.espn.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const STYLE_ID = 'pinny-tdr-style';
  const ZCODE_LIVE_KEY = '4cConsZcodeLive';
  const ZCODE_SPORT_WANT_KEY = '4cConsZcodeSportWant';
  /** Roster for multi-tab ZCode: surplus tabs close when board sports shrink. */
  const ZCODE_TAB_ROSTER_KEY = '4cConsZcodeTabRoster';
  let zcodeWantSettleTimer = 0;
  /** Min books with a fav price to snap. Was 12; NBA boards often only quote ~10–11. */
  const BOOK_LEAGUE_MIN_Y = 8;
  const BOOK_LEAGUE_UI_ID = 'pc-book-league-sync';
  const TAKE_REC_UI_ID = 'pc-take-rec';
  /** Take picks: sort-boost by how far Pinny O→C is from favoring the take. */
  const TAKE_REC_AGAINST_KEY = 'pcTakeRecMovedAgainst';
  let takeRecSteamBoost = false;
  try {
    takeRecSteamBoost = !!GM_getValue(TAKE_REC_AGAINST_KEY, false);
  } catch (_) {}
  const BOOK_LEAGUE_PATH = 'book-league/book-league-data.js';
  const BOOK_LEAGUE_LOCAL_KEY = 'bookLeagueLocalData';
  const BOOK_LEAGUE_SYNC_MS = 45000;
  /** Cross-tab lock so 4codds + book-league.html (or two boards) don't race Git refs. */
  const BOOK_LEAGUE_LOCK_KEY = 'bookLeagueSyncLock';
  const BOOK_LEAGUE_LOCK_MS = 180000;
  /** Rolling gap: after a snap at 19:56, next for that game/market is 20:56 — not the next UTC hour. */
  const BOOK_LEAGUE_GAP_MS = 3600000;
  /** Only snap games whose start is within this window (skip day+ boards like next week's NFL). */
  const BOOK_LEAGUE_MAX_START_AHEAD_MS = 18 * 3600000;
  const GH_TOKEN_KEY = 'bookLeagueGithubToken';
  const GH_REPO_KEY = 'bookLeagueGithubRepo';
  const GH_BRANCH_KEY = 'bookLeagueGithubBranch';
  const DEFAULT_GH_REPO = 'jacobtulster/pinny-fade';
  const IS_ZCODE = /zcodesystem\.com$/i.test(location.hostname);
  const IS_4C = /4codds\.com$/i.test(location.hostname);
  const IS_BOOK_LEAGUE_PAGE =
    /(?:^|\/)book-league\.html(?:[?#]|$)/i.test(location.pathname || '') ||
    /(?:^|\/)book-league\.html(?:[?#]|$)/i.test(location.href || '');

  /** ZCode URL uses uppercase (?sport=MLB). */
  const FOURC_LEAGUE_TO_ZCODE = {
    MLB: 'MLB',
    NFL: 'NFL',
    NCAAF: 'NCAAF',
    CFB: 'NCAAF',
    NHL: 'NHL',
    NBA: 'NBA',
    WNBA: 'WNBA',
    NCAAB: 'NCAAB',
    CBB: 'NCAAB',
  };

  let paintTimer = 0;
  let painting = false;
  let lastMarketSportKey = '';
  let marketUserOverride = false;
  let marketAutoClick = false;
  let lastMarketEnsureAt = 0;
  let lastFairEnsureAt = 0;
  let lastBasketballAllEnsureAt = 0;
  let zcodeLiveCache = null;
  let zcodeLiveCacheAt = 0;
  let zcodeLiveFpSeen = '';
  let bookLeagueLastMsg = '';
  let bookLeagueSyncing = false;
  let bookLeagueLockId = '';
  /** Cache: { updatedAt, bySport: { NFL: { rows, bestCode, worstCode, rankIndexByCode, nameByCode } } } */
  let blStandingsCache = { updatedAt: null, bySport: {} };
  const TAKE_MIN_BL_BOOKS = 1;
  /** Always paint a Take; confidence % is informational only. */
  const TAKE_MIN_CONFIDENCE = 0;

  function log() {
    try {
      console.log.apply(console, ['[4C TDR]'].concat([].slice.call(arguments)));
    } catch (_) {}
  }

  // --- ZCode live bridge (local GM only; no network) ---

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

  // College aliases (shared). NFL/NBA/NHL abbrevs are sport-scoped — MIN/MIA/etc. collide.
  const TEAM_ALIASES = {
    // --- NCAAF (4codds abbrevs ↔ ZCode school names) ---
    misst: 'mississippi state',
    msst: 'mississippi state',
    missst: 'mississippi state',
    'miss state': 'mississippi state',
    lsu: 'lsu',
    'louisiana state': 'lsu',
    tcu: 'texas christian',
    'texas christian university': 'texas christian',
    smu: 'southern methodist',
    'southern methodist university': 'southern methodist',
    utsa: 'texas san antonio',
    'texas san antonio': 'texas san antonio',
    byu: 'brigham young',
    'brigham young university': 'brigham young',
    usf: 'south florida',
    sfl: 'south florida',
    fau: 'florida atlantic',
    fiu: 'florida international',
    'florida intl': 'florida international',
    'fla international': 'florida international',
    mtsu: 'middle tennessee',
    'middle tennessee state': 'middle tennessee',
    'middle tenn': 'middle tennessee',
    'middle tn': 'middle tennessee',
    lib: 'liberty',
    liberty: 'liberty',
    ken: 'kennesaw state',
    kennesaw: 'kennesaw state',
    'kennesaw st': 'kennesaw state',
    'kennesaw state': 'kennesaw state',
    uconn: 'connecticut',
    conn: 'connecticut',
    connecticut: 'connecticut',
    usc: 'southern california',
    'southern cal': 'southern california',
    'ole miss': 'mississippi',
    miss: 'mississippi',
    pitt: 'pittsburgh',
    ucf: 'ucf',
    'central florida': 'ucf',
    'texas am': 'texas a m',
    'texas a and m': 'texas a m',
    tamu: 'texas a m',
    txam: 'texas a m',
    bc: 'boston college',
    'boston coll': 'boston college',
    unlv: 'nevada las vegas',
    'nevada las vegas': 'nevada las vegas',
    washst: 'washington state',
    washstate: 'washington state',
    wazzou: 'washington state',
    'washington st': 'washington state',
    wsu: 'washington state',
    'ark st': 'arkansas state',
    arkst: 'arkansas state',
    arst: 'arkansas state',
    'arkansas st': 'arkansas state',
    'ark.st': 'arkansas state',
    unm: 'new mexico',
    'new mexico': 'new mexico',
    nmsu: 'new mexico state',
    'new mexico st': 'new mexico state',
    'new mexico state': 'new mexico state',
    oregst: 'oregon state',
    orst: 'oregon state',
    'oregon st': 'oregon state',
    mass: 'massachusetts',
    umass: 'massachusetts',
    'u mass': 'massachusetts',
    massachusetts: 'massachusetts',
    syr: 'syracuse',
    wake: 'wake forest',
    cal: 'california',
    sdst: 'san diego state',
    sdsu: 'san diego state',
    fres: 'fresno state',
    fresno: 'fresno state',
    neb: 'nebraska',
    stan: 'stanford',
    jmu: 'james madison',
    'james madison university': 'james madison',
    gast: 'georgia state',
    'ga state': 'georgia state',
    appst: 'appalachian state',
    app: 'appalachian state',
    'miami fl': 'miami',
    'miami florida': 'miami',
    'miami oh': 'miami ohio',
    'miami of ohio': 'miami ohio',
    mioh: 'miami ohio',
    miaoh: 'miami ohio',
    niu: 'northern illinois',
    emu: 'eastern michigan',
    wmu: 'western michigan',
    cmu: 'central michigan',
    ballst: 'ball state',
    ball: 'ball state',
    bgsu: 'bowling green',
    bgreen: 'bowling green',
    'bowling green state': 'bowling green',
    kentst: 'kent state',
    kent: 'kent state',
    arkst: 'arkansas state',
    usm: 'southern mississippi',
    somiss: 'southern mississippi',
    smiss: 'southern mississippi',
    'southern miss': 'southern mississippi',
    latech: 'louisiana tech',
    'la tech': 'louisiana tech',
    lt: 'louisiana tech',
    utep: 'texas el paso',
    'texas el paso': 'texas el paso',
    sjsu: 'san jose state',
    'san jose state': 'san jose state',
    sanjose: 'san jose state',
    ndsu: 'north dakota state',
    sacst: 'sacramento state',
    // Do NOT map bare "sac" here — NBA Sacramento Kings shares that abbrev.
    'sacramento state': 'sacramento state',
    ull: 'ul lafayette',
    'ul lafayette': 'ul lafayette',
    'louisiana lafayette': 'ul lafayette',
    ulm: 'ul monroe',
    'ul monroe': 'ul monroe',
    'louisiana monroe': 'ul monroe',
    asu: 'arizona state',
    'arizona st': 'arizona state',
    psu: 'penn state',
    'penn st': 'penn state',
    'nc state': 'north carolina state',
    'n carolina state': 'north carolina state',
    'north carolina st': 'north carolina state',
    ncst: 'north carolina state',
    ncsu: 'north carolina state',
    vtech: 'virginia tech',
    'virginia tech': 'virginia tech',
    gtech: 'georgia tech',
    'georgia tech': 'georgia tech',
    ttu: 'texas tech',
    okst: 'oklahoma state',
    'oklahoma st': 'oklahoma state',
    ksu: 'kansas state',
    'kansas st': 'kansas state',
    msu: 'michigan state',
    'michigan st': 'michigan state',
    'ohio st': 'ohio state',
    fsu: 'florida state',
    'florida st': 'florida state',
    wvu: 'west virginia',
    'west va': 'west virginia',
    'w virginia': 'west virginia',
    'army west point': 'army',
    airforce: 'air force',
    'char southern': 'charleston southern',
    chso: 'charleston southern',
    // Legacy NFL full-name renames (safe across sports — not abbrevs)
    'st louis rams': 'los angeles rams',
    'st. louis rams': 'los angeles rams',
    // normTeam maps \bst\b → state, so "St. Louis Rams" becomes this key
    'state louis rams': 'los angeles rams',
    'oakland raiders': 'las vegas raiders',
    'san diego chargers': 'los angeles chargers',
    'washington redskins': 'washington commanders',
    'washington football team': 'washington commanders',
  };

  // NFL-only abbrevs (do not put in TEAM_ALIASES — MIN/MIA/etc. collide with NBA/NHL)
  const TEAM_ALIASES_NFL = {
    ari: 'arizona cardinals',
    atl: 'atlanta falcons',
    bal: 'baltimore ravens',
    buf: 'buffalo bills',
    car: 'carolina panthers',
    chi: 'chicago bears',
    cin: 'cincinnati bengals',
    cle: 'cleveland browns',
    dal: 'dallas cowboys',
    den: 'denver broncos',
    det: 'detroit lions',
    gb: 'green bay packers',
    hou: 'houston texans',
    ind: 'indianapolis colts',
    jax: 'jacksonville jaguars',
    jac: 'jacksonville jaguars',
    kc: 'kansas city chiefs',
    lac: 'los angeles chargers',
    lar: 'los angeles rams',
    lv: 'las vegas raiders',
    mia: 'miami dolphins',
    min: 'minnesota vikings',
    ne: 'new england patriots',
    no: 'new orleans saints',
    nyg: 'new york giants',
    nyj: 'new york jets',
    phi: 'philadelphia eagles',
    pit: 'pittsburgh steelers',
    sea: 'seattle seahawks',
    sf: 'san francisco 49ers',
    tb: 'tampa bay buccaneers',
    ten: 'tennessee titans',
    was: 'washington commanders',
    wsh: 'washington commanders',
  };

  // NBA / ZCode board abbrevs + nicknames (MIN≠Vikings, MIA≠Dolphins, LAC≠Chargers)
  const TEAM_ALIASES_NBA = {
    atl: 'atlanta hawks',
    hawks: 'atlanta hawks',
    bos: 'boston celtics',
    celtics: 'boston celtics',
    bkn: 'brooklyn nets',
    bro: 'brooklyn nets',
    bn: 'brooklyn nets',
    nets: 'brooklyn nets',
    cha: 'charlotte hornets',
    cho: 'charlotte hornets',
    hornets: 'charlotte hornets',
    chi: 'chicago bulls',
    bulls: 'chicago bulls',
    cle: 'cleveland cavaliers',
    cavaliers: 'cleveland cavaliers',
    cavs: 'cleveland cavaliers',
    dal: 'dallas mavericks',
    mavericks: 'dallas mavericks',
    mavs: 'dallas mavericks',
    den: 'denver nuggets',
    nuggets: 'denver nuggets',
    det: 'detroit pistons',
    pistons: 'detroit pistons',
    gsw: 'golden state warriors',
    gs: 'golden state warriors',
    warriors: 'golden state warriors',
    hou: 'houston rockets',
    rockets: 'houston rockets',
    ind: 'indiana pacers',
    pacers: 'indiana pacers',
    lac: 'la clippers',
    clippers: 'la clippers',
    'la clippers': 'la clippers',
    'los angeles clippers': 'la clippers',
    lal: 'los angeles lakers',
    lakers: 'los angeles lakers',
    'la lakers': 'los angeles lakers',
    mem: 'memphis grizzlies',
    grizzlies: 'memphis grizzlies',
    grizz: 'memphis grizzlies',
    mia: 'miami heat',
    miami: 'miami heat',
    heat: 'miami heat',
    'miami heat': 'miami heat',
    mil: 'milwaukee bucks',
    bucks: 'milwaukee bucks',
    min: 'minnesota timberwolves',
    minnesota: 'minnesota timberwolves',
    timberwolves: 'minnesota timberwolves',
    wolves: 'minnesota timberwolves',
    'minnesota timberwolves': 'minnesota timberwolves',
    nop: 'new orleans pelicans',
    no: 'new orleans pelicans',
    pelicans: 'new orleans pelicans',
    nyk: 'new york knicks',
    ny: 'new york knicks',
    knicks: 'new york knicks',
    okc: 'oklahoma city thunder',
    thunder: 'oklahoma city thunder',
    orl: 'orlando magic',
    magic: 'orlando magic',
    phi: 'philadelphia 76ers',
    '76ers': 'philadelphia 76ers',
    sixers: 'philadelphia 76ers',
    phx: 'phoenix suns',
    pho: 'phoenix suns',
    suns: 'phoenix suns',
    por: 'portland trail blazers',
    blazers: 'portland trail blazers',
    'trail blazers': 'portland trail blazers',
    sac: 'sacramento kings',
    kings: 'sacramento kings',
    sas: 'san antonio spurs',
    sa: 'san antonio spurs',
    spurs: 'san antonio spurs',
    tor: 'toronto raptors',
    raptors: 'toronto raptors',
    uta: 'utah jazz',
    utah: 'utah jazz',
    jazz: 'utah jazz',
    was: 'washington wizards',
    wsh: 'washington wizards',
    wizards: 'washington wizards',
  };

  function canonTeam(s, sportHint) {
    const n = normTeam(s);
    if (!n) return '';
    const sport = String(sportHint || '').toUpperCase();
    const basketball =
      sport === 'NBA' || sport === 'WNBA' || sport === 'BASKETBALL';
    if (basketball && TEAM_ALIASES_NBA[n]) return TEAM_ALIASES_NBA[n];
    if (sport === 'NFL' && TEAM_ALIASES_NFL[n]) return TEAM_ALIASES_NFL[n];
    if (TEAM_ALIASES[n]) return TEAM_ALIASES[n];
    // No sport hint: never guess NFL/NBA for shared abbrevs (MIN/MIA/ATL/…).
    return n;
  }

  function teamsMatch(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    // Avoid Ole Miss ↔ Miss State; Miami (FL/Heat) ↔ Miami Ohio via naive includes
    if (a + ' state' === b || b + ' state' === a) return false;
    const miamiOhio = (x) => x === 'miami ohio' || x === 'miami of ohio';
    const miamiFlish = (x) =>
      x === 'miami' || x === 'miami heat' || x === 'miami fl' || x === 'miami florida';
    if ((miamiFlish(a) && miamiOhio(b)) || (miamiFlish(b) && miamiOhio(a))) return false;
    if (a.length >= 5 && b.length >= 5 && (a.includes(b) || b.includes(a))) return true;
    const ta = a.split(' ').filter(Boolean);
    const tb = b.split(' ').filter(Boolean);
    // Nickname last-token: "la clippers" ↔ "los angeles clippers"
    if (ta.length && tb.length) {
      const la = ta[ta.length - 1];
      const lb = tb[tb.length - 1];
      if (la && la === lb && la.length >= 4 && (ta.length >= 2 || tb.length >= 2)) return true;
    }
    if (ta.length >= 2 && tb.length >= 2) {
      const setB = new Set(tb);
      let hit = 0;
      for (let i = 0; i < ta.length; i++) if (setB.has(ta[i])) hit++;
      if (hit >= Math.min(2, ta.length, tb.length) && hit / Math.max(ta.length, tb.length) >= 0.6) {
        return true;
      }
    }
    return false;
  }

  function looksLikeTeamAbbrev(label) {
    const t = String(label || '').trim();
    if (!t) return true;
    if (/\s/.test(t)) return false;
    // UMASS / UCONN / MTSU-style board codes (≤5) + any known alias key
    if (t.length <= 5) return true;
    const n = normTeam(t);
    if (TEAM_ALIASES[n] && TEAM_ALIASES[n] !== n) return true;
    if (TEAM_ALIASES_NFL[n] || TEAM_ALIASES_NBA[n]) return true;
    return false;
  }

  // Prefer full names from img[alt] / OTC title when the board shows HOU/JAX-style abbrevs.
  function tradTeamLabel(teamEl) {
    if (!teamEl) return '';
    const board = String(
      (teamEl.querySelector('a.tName') && teamEl.querySelector('a.tName').textContent) ||
        teamEl.textContent ||
        ''
    )
      .replace(/\s+/g, ' ')
      .trim();
    if (board && !looksLikeTeamAbbrev(board)) return board;
    const img = teamEl.querySelector('img[alt]');
    const alt = String((img && img.getAttribute('alt')) || '').replace(/\s+/g, ' ').trim();
    if (alt) return alt;
    const a = teamEl.querySelector('a.tName[data-pc-otc-title], a.tName[title]');
    const tip = String(
      (a && (a.getAttribute('data-pc-otc-title') || a.getAttribute('title'))) || ''
    )
      .replace(/\s+/g, ' ')
      .trim();
    const tipName = tip.replace(/:.*$/, '').trim();
    if (tipName && !/^(otc|take|o\s*->\s*c)\b/i.test(tipName)) return tipName;
    return board;
  }

  function readZcodePublicRatio(teamRoot) {
    if (!teamRoot) return null;
    const nodes = teamRoot.querySelectorAll(
      '.public_tickets.tickets[class*="ratio_level"], .public_tickets.tickets'
    );
    for (let i = 0; i < nodes.length; i++) {
      const text = String(nodes[i].textContent || '');
      if (!/public\s*ratio/i.test(text)) continue;
      if (/%\s*ratio/i.test(text)) continue;
      const b = nodes[i].querySelector('b');
      const n = parseFloat(String((b && b.textContent) || text).replace(/[^\d.]/g, ''));
      if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
  }

  function scrapeZcodeLiveGames() {
    const gameEls = document.querySelectorAll('.GamesList .game, .game[data-sport], .game');
    const games = [];
    const seen = Object.create(null);

    gameEls.forEach((el) => {
      const get = (name) => {
        const inp = el.querySelector(`input[name="${name}"]`);
        return inp ? String(inp.value || '').trim() : '';
      };
      // Prefer display_caption (modern names) over name1/name2 (often legacy: St. Louis Rams, etc.)
      let name1 = get('display_caption1') || get('name1');
      let name2 = get('display_caption2') || get('name2');
      if (!name1) {
        const t = el.querySelector('.team1 .team, .team1');
        name1 = t ? String(t.textContent || '').replace(/\s+/g, ' ').trim() : '';
      }
      if (!name2) {
        const t = el.querySelector('.team2 .team, .team2');
        name2 = t ? String(t.textContent || '').replace(/\s+/g, ' ').trim() : '';
      }
      name1 = name1.replace(/\s+W$/i, '').trim();
      name2 = name2.replace(/\s+W$/i, '').trim();
      if (!name1 || !name2) return;

      let sport = String(el.getAttribute('data-sport') || get('sport') || '').toUpperCase();
      if (!sport) {
        try {
          sport = String(currentZcodeSportFromUrl() || '').toUpperCase();
        } catch (_) {}
      }
      const r1 = readZcodePublicRatio(el.querySelector('.team1'));
      const r2 = readZcodePublicRatio(el.querySelector('.team2'));
      if (!(Number.isFinite(r1) && r1 > 0) && !(Number.isFinite(r2) && r2 > 0)) return;

      const n1 = canonTeam(name1, sport);
      const n2 = canonTeam(name2, sport);
      const key = (sport || 'X') + '|' + n1 + '|' + n2;
      if (seen[key]) return;
      seen[key] = 1;

      games.push({
        sport: sport || null,
        name1,
        name2,
        n1,
        n2,
        r1: Number.isFinite(r1) && r1 > 0 ? r1 : null,
        r2: Number.isFinite(r2) && r2 > 0 ? r2 : null,
      });
    });

    return games;
  }

  function zcodeGamesFingerprint(games) {
    if (!games || !games.length) return '';
    return games
      .map((g) => (g.n1 || '') + '>' + (g.n2 || '') + '=' + (g.r1 == null ? '' : g.r1) + '/' + (g.r2 == null ? '' : g.r2))
      .join('|');
  }

  /** Merge this tab's scrape into GM so NBA + NCAAB ZCode tabs don't wipe each other. */
  function mergeZcodeLiveGames(scraped, sport, prevGames) {
    const mine = Array.isArray(scraped) ? scraped : [];
    const prev = Array.isArray(prevGames) ? prevGames : [];
    const sp = String(sport || '').toUpperCase();
    if (!sp) return mine.length ? mine : prev;
    if (!mine.length) return prev;
    const kept = prev.filter((g) => {
      const gs = String((g && g.sport) || '').toUpperCase();
      return gs && gs !== sp;
    });
    return kept.concat(mine);
  }

  /** Write GM only when ratios/teams change; heartbeat keeps freshness for stale check. */
  function publishZcodeLive(force) {
    if (typeof GM_setValue !== 'function') return 0;
    const scraped = scrapeZcodeLiveGames();
    const sport = currentZcodeSportFromUrl() || '';
    const now = Date.now();
    let prev = null;
    try {
      prev = GM_getValue(ZCODE_LIVE_KEY, null);
    } catch (_) {}
    const prevGames = prev && Array.isArray(prev.games) ? prev.games : [];
    const games = mergeZcodeLiveGames(scraped, sport, prevGames);
    const fp = zcodeGamesFingerprint(games);
    const prevFp = prev && prev.fp != null ? String(prev.fp) : '';
    const age = prev && prev.updatedAt ? now - Number(prev.updatedAt) : Infinity;
    const changed = force || fp !== prevFp;
    const heartbeat = age > 45000;
    if (!changed && !heartbeat) return games.length;
    const payload = {
      updatedAt: now,
      gameCount: games.length,
      games,
      fp,
      sports: Array.from(
        new Set(
          games
            .map((g) => String((g && g.sport) || '').toUpperCase())
            .filter(Boolean)
        )
      ),
    };
    try {
      GM_setValue(ZCODE_LIVE_KEY, payload);
    } catch (_) {}
    return games.length;
  }

  function readZcodeLive(bypassCache) {
    const now = Date.now();
    if (!bypassCache && zcodeLiveCache && now - zcodeLiveCacheAt < 250) return zcodeLiveCache;
    let payload = null;
    try {
      if (typeof GM_getValue === 'function') payload = GM_getValue(ZCODE_LIVE_KEY, null);
    } catch (_) {}
    zcodeLiveCache = payload && Array.isArray(payload.games) ? payload : null;
    zcodeLiveCacheAt = now;
    return zcodeLiveCache;
  }

  /** Chip-only refresh (no TDR/OTC wipe) when ZCode GM payload changes. */
  function refreshZcodeRatioChipsFromGm() {
    zcodeLiveCache = null;
    zcodeLiveCacheAt = 0;
    const live = readZcodeLive(true);
    const fp = live && live.fp != null ? String(live.fp) : zcodeGamesFingerprint(live && live.games);
    if (fp === zcodeLiveFpSeen && live && live.games && live.games.length) {
      if (live.updatedAt && Date.now() - live.updatedAt > 15 * 60 * 1000) {
        clearZcodeRatioChips();
        zcodeLiveFpSeen = '';
      }
      return false;
    }
    const wasPainting = painting;
    painting = true;
    try {
      // In-place update only — do not wipe chips first
      markZcodeRatioChips();
      refreshTakeRecPanel();
    } finally {
      painting = wasPainting;
    }
    return true;
  }

  function fmtRatioChip(n) {
    if (n == null || !Number.isFinite(n)) return '';
    if (n >= 100) return String(Math.round(n));
    if (n >= 10) return String(Math.round(n * 10) / 10);
    return String(Math.round(n * 100) / 100);
  }

  function zcodeGameKey(g) {
    if (!g) return '';
    const s = String(g.sport || '').toUpperCase();
    return s + '|' + (g.n1 || g.name1 || '') + '|' + (g.n2 || g.name2 || '');
  }

  /**
   * Match a 4codds row to a ZCode game only when BOTH teams match.
   * One-side fallback used to paint tomorrow's LAK@CHI with today's LAK@NYR ratios
   * (same team, different opponent not on ZCode yet).
   * opts.used: Set of zcodeGameKey already claimed (1:1 board↔ZCode).
   */
  function zcodeSportsCompatible(boardSport, rawSport) {
    const want = String(boardSport || '').toUpperCase();
    const got = String(rawSport || '').toUpperCase();
    if (!want || !got) return true;
    if (want === got) return true;
    if (got === 'BASKETBALL' && (want === 'NBA' || want === 'WNBA' || want === 'NCAAB')) {
      return true;
    }
    if (want === 'NCAAB' && (got === 'CBB' || got === 'BASKETBALL')) return true;
    if (want === 'NCAAF' && (got === 'CFB' || got === 'FOOTBALL')) return true;
    return false;
  }

  function findZcodeRatiosForTeams(t0, t1, games, opts) {
    if (!games || !games.length) return null;
    const used = opts && opts.used;
    const boardSport =
      (opts && opts.sport && String(opts.sport).toUpperCase()) || fourCToZcodeSport();
    const a = canonTeam(t0, boardSport);
    const b = canonTeam(t1, boardSport);
    if (!a || !b) return null;
    let best = null;
    let bestScore = 0;
    for (let i = 0; i < games.length; i++) {
      const g = games[i];
      const key = zcodeGameKey(g);
      if (used && key && used.has(key)) continue;
      const rawSport = String(g.sport || '').toUpperCase();
      // ZCode may tag basketball as NBA / NCAAB / BASKETBALL.
      let gSport = rawSport || boardSport || '';
      if (
        gSport === 'BASKETBALL' &&
        (boardSport === 'NBA' || boardSport === 'WNBA' || boardSport === 'NCAAB')
      ) {
        gSport = boardSport;
      }
      if (boardSport && rawSport && !zcodeSportsCompatible(boardSport, rawSport)) continue;
      // Always re-canon from raw names with board sport — never trust stale n1/n2
      // (older scrapes mapped MIN→vikings / MIA→dolphins into GM storage).
      const g1 = canonTeam(g.name1 || g.n1, gSport || boardSport);
      const g2 = canonTeam(g.name2 || g.n2, gSport || boardSport);
      let score = 0;
      let map = null;
      if (teamsMatch(a, g1) && teamsMatch(b, g2)) {
        score = (a === g1 ? 2 : 1) + (b === g2 ? 2 : 1);
        map = { r0: g.r1, r1: g.r2, g, key };
      } else if (teamsMatch(a, g2) && teamsMatch(b, g1)) {
        score = (a === g2 ? 2 : 1) + (b === g1 ? 2 : 1);
        map = { r0: g.r2, r1: g.r1, g, key };
      }
      if (map && score > bestScore) {
        bestScore = score;
        best = map;
      }
    }
    // Both sides must match (score ≥ 2). No single-team fallback.
    if (bestScore >= 2) return best;
    return null;
  }

  const ZCODE_NAME_TIER_CLASSES = [
    'pc-zcode-name',
    'pc-zr-lo',
    'pc-zr-mid',
    'pc-zr-hi',
    'pc-zr-soft',
  ];

  function clearZcodeNameTier(teamEl) {
    if (!teamEl || !teamEl.classList) return;
    ZCODE_NAME_TIER_CLASSES.forEach((c) => teamEl.classList.remove(c));
  }

  function clearZcodeRatioChips() {
    document.querySelectorAll('.pc-zcode-ratio').forEach((n) => n.remove());
    document.querySelectorAll('.team.pc-zcode-host, .team.pc-zcode-name').forEach((el) => {
      el.classList.remove('pc-zcode-host');
      clearZcodeNameTier(el);
    });
  }

  /** Fav-only alert colors: <1 green · 2–4.99 yellow · 5+ red · 1–1.99 muted */
  function ratioTierClass(r) {
    if (r == null || !Number.isFinite(r)) return 'tier-soft';
    if (r < 1) return 'tier-lo';
    if (r >= 5) return 'tier-hi';
    if (r >= 2) return 'tier-mid';
    return 'tier-soft';
  }

  function attachZcodeRatioChip(nameEl, ratio, meta, role) {
    if (!nameEl || ratio == null || !Number.isFinite(ratio)) return;
    const teamEl = nameEl.closest('.team') || nameEl.parentElement;
    if (!teamEl) return;
    teamEl.classList.add('pc-zcode-host');
    let chip = teamEl.querySelector(':scope > .pc-zcode-ratio');
    if (!chip) {
      chip = document.createElement('span');
      chip.className = 'pc-zcode-ratio';
      // Append (absolute CSS) — never insert beside tName in flex flow
      teamEl.appendChild(chip);
    }
    const txt = fmtRatioChip(ratio);
    // Green/yellow/red only on the fav; dog stays muted
    const tier = role === 'fav' ? ratioTierClass(ratio) : 'tier-soft';
    const nextClass = 'pc-zcode-ratio ' + tier + (role === 'fav' ? ' role-fav' : ' role-dog');
    if (chip.className !== nextClass) chip.className = nextClass;
    if (chip.textContent !== txt) chip.textContent = txt;
    const title =
      'ZCode Public Ratio ' +
      txt +
      (role === 'fav' ? ' (fav)' : role === 'dog' ? ' (dog)' : '') +
      (meta && meta.updatedAt
        ? ' · ' + Math.max(0, Math.round((Date.now() - meta.updatedAt) / 1000)) + 's ago'
        : '');
    if (chip.title !== title) chip.title = title;

    // Fav team name badge uses same tier colors; dog name untouched (OTC O->C badge kept)
    clearZcodeNameTier(teamEl);
    if (role === 'fav') {
      const nameTier =
        tier === 'tier-lo'
          ? 'pc-zr-lo'
          : tier === 'tier-mid'
            ? 'pc-zr-mid'
            : tier === 'tier-hi'
              ? 'pc-zr-hi'
              : 'pc-zr-soft';
      teamEl.classList.add('pc-zcode-name', nameTier);
    }
  }

  function markZcodeRatioChips() {
    const live = readZcodeLive(true);
    if (!live || !live.games || !live.games.length) {
      clearZcodeRatioChips();
      return;
    }
    // Stale > 15 min → hide (ZCode tab closed / not refreshing)
    if (live.updatedAt && Date.now() - live.updatedAt > 15 * 60 * 1000) {
      clearZcodeRatioChips();
      return;
    }
    zcodeLiveFpSeen =
      live.fp != null ? String(live.fp) : zcodeGamesFingerprint(live.games);

    const keep = new Set();
    const usedZcode = new Set();
    tradBoardGames().forEach((gameEl) => {
      const teams = gameEl.querySelectorAll(
        ':scope > .cGame .teams .team, :scope > .cGame .team'
      );
      if (teams.length < 2) return;
      const names = [];
      const nameEls = [];
      for (let i = 0; i < 2; i++) {
        const nameEl = teams[i].querySelector('a.tName, .tName');
        names.push(tradTeamLabel(teams[i]));
        nameEls.push(nameEl);
      }
      const hit = findZcodeRatiosForTeams(names[0], names[1], live.games, {
        used: usedZcode,
        sport: takeSportKeyForGame(gameEl),
      });
      if (!hit) return;
      if (hit.key) usedZcode.add(hit.key);
      const nOut = tradOutcomeCount(gameEl);
      const favSide = tradFavSideIndex(gameEl);
      const favTeamIdx = outcomeToTeamIndex(favSide, nOut);
      const role0 = favTeamIdx === 0 ? 'fav' : favTeamIdx === 1 ? 'dog' : null;
      const role1 = favTeamIdx === 1 ? 'fav' : favTeamIdx === 0 ? 'dog' : null;
      attachZcodeRatioChip(nameEls[0], hit.r0, live, role0);
      attachZcodeRatioChip(nameEls[1], hit.r1, live, role1);
      for (let si = 0; si < 2; si++) {
        const ne = nameEls[si];
        if (!ne) continue;
        const host = ne.closest('.team') || ne.parentElement;
        const c = host && host.querySelector(':scope > .pc-zcode-ratio');
        if (c) keep.add(c);
      }
    });
    // Drop orphans only — never wipe+recreate all chips (avoids name flicker)
    document.querySelectorAll('.pc-zcode-ratio').forEach((n) => {
      if (!keep.has(n)) {
        const host = n.parentElement;
        n.remove();
        if (host && host.classList && !host.querySelector('.pc-zcode-ratio')) {
          host.classList.remove('pc-zcode-host');
          clearZcodeNameTier(host);
        }
      }
    });
  }

  /** Map current 4codds board → ZCode ?sport= code (or null if unknown/hot). */
  function fourCToZcodeSport() {
    const path = String(location.pathname || '').toLowerCase();
    // Direct path match first (handles /baseball with no league segment)
    if (/\/baseball(\/|$)/.test(path) || /\/mlb(\/|$)/.test(path)) return 'MLB';
    if (/\/hockey(\/|$)/.test(path) || /\/nhl(\/|$)/.test(path)) return 'NHL';
    if (/\/football\/ncaaf(\/|$)/.test(path) || /\/ncaaf(\/|$)/.test(path)) return 'NCAAF';
    if (/\/football(\/|$)/.test(path) || /\/nfl(\/|$)/.test(path)) return 'NFL';
    if (/\/basketball\/wnba(\/|$)/.test(path) || /\/wnba(\/|$)/.test(path)) return 'WNBA';
    if (/\/basketball\/ncaab(\/|$)/.test(path) || /\/ncaab(\/|$)/.test(path)) return 'NCAAB';
    if (/\/basketball(\/|$)/.test(path) || /\/nba(\/|$)/.test(path)) return 'NBA';

    const info = routeInfo();
    const league = String(info.league || '').toUpperCase();
    if (FOURC_LEAGUE_TO_ZCODE[league]) return FOURC_LEAGUE_TO_ZCODE[league];
    const board = String(info.sport || info.board || '').toLowerCase();
    if (board === 'baseball' || board === 'mlb') return 'MLB';
    if (board === 'hockey' || board === 'nhl' || board === 'icehockey' || board === 'ice-hockey') {
      return 'NHL';
    }
    if (board === 'football' || board === 'nfl') return 'NFL';
    if (board === 'ncaaf' || board === 'cfb') return 'NCAAF';
    if (board === 'basketball' || board === 'nba') return 'NBA';
    if (board === 'wnba') return 'WNBA';
    if (board === 'ncaab' || board === 'cbb') return 'NCAAB';
    return null;
  }

  /** ZCode sports present on the current 4codds board (per-game .lg, else route). */
  function boardZcodeSportsNeeded() {
    const order = ['NFL', 'NCAAF', 'NHL', 'MLB', 'NBA', 'WNBA', 'NCAAB'];
    const set = new Set();
    try {
      tradBoardGames().forEach((gameEl) => {
        const k = takeSportKeyForGame(gameEl);
        if (k) set.add(String(k).toUpperCase());
      });
    } catch (_) {}
    if (!set.size) {
      const one = fourCToZcodeSport();
      if (one) set.add(one);
    }
    const ordered = order.filter((k) => set.has(k));
    Array.from(set)
      .filter((k) => !order.includes(k))
      .sort()
      .forEach((k) => ordered.push(k));
    return ordered;
  }

  function publishFourCSportWant(force) {
    if (typeof GM_setValue !== 'function') return null;
    const sports = boardZcodeSportsNeeded();
    const sport = sports[0] || fourCToZcodeSport();
    if (!sport) {
      log('ZCode sport want: no map for', location.pathname);
      return null;
    }
    const path = String(location.pathname || '');
    let prev = null;
    try {
      prev = GM_getValue(ZCODE_SPORT_WANT_KEY, null);
    } catch (_) {}
    const prevSport = prev && prev.sport ? String(prev.sport).toUpperCase() : '';
    const prevPath = prev && prev.path != null ? String(prev.path) : '';
    const prevSports = Array.isArray(prev && prev.sports)
      ? prev.sports.map((s) => String(s || '').toUpperCase()).join(',')
      : '';
    const nextSports = sports.join(',');
    if (!force && prevSport === sport && prevPath === path && prevSports === nextSports) {
      return sport;
    }
    try {
      GM_setValue(ZCODE_SPORT_WANT_KEY, {
        sport,
        sports,
        updatedAt: Date.now(),
        path,
      });
      log('ZCode sport want →', sports.join('+') || sport, path);
    } catch (e) {
      log('ZCode sport want write failed', e && e.message);
    }
    return sport;
  }

  function currentZcodeSportFromUrl() {
    const m = String(location.search || '').match(/[?&]sport=([A-Za-z0-9]+)/i);
    return m ? String(m[1]).toUpperCase() : null;
  }

  function normalizeWantSports(payload) {
    const want = payload && payload.sport ? String(payload.sport).toUpperCase() : '';
    const sports = Array.isArray(payload && payload.sports)
      ? payload.sports.map((s) => String(s || '').toUpperCase()).filter(Boolean)
      : [];
    if (sports.length) return sports;
    return want ? [want] : [];
  }

  /** Keep a stable pc-zcode-* window name so Open Zcode / election can target tabs. */
  function ensureZcodeWindowName() {
    if (window.name && /^pc-zcode-[A-Za-z0-9]+$/i.test(window.name)) {
      return window.name;
    }
    const cur = currentZcodeSportFromUrl() || 'X';
    window.name = 'pc-zcode-' + cur;
    return window.name;
  }

  function navigateZcodeToSport(target) {
    const sp = String(target || '').toUpperCase();
    if (!sp) return false;
    const cur = currentZcodeSportFromUrl();
    if (cur === sp) {
      window.name = 'pc-zcode-' + sp;
      return false;
    }
    window.name = 'pc-zcode-' + sp;
    try {
      const url = new URL(location.href);
      url.searchParams.set('sport', sp);
      log('ZCode → sport=' + sp + ' (was ' + (cur || 'none') + ')');
      location.assign(url.pathname + url.search + url.hash);
      return true;
    } catch (_) {
      location.search = '?sport=' + encodeURIComponent(sp);
      return true;
    }
  }

  function registerZcodeTabRoster(wantAt, tabName, sport) {
    let roster = null;
    try {
      roster = GM_getValue(ZCODE_TAB_ROSTER_KEY, null);
    } catch (_) {}
    if (!roster || Number(roster.wantAt) !== Number(wantAt)) {
      roster = { wantAt: Number(wantAt) || 0, tabs: {} };
    }
    if (!roster.tabs) roster.tabs = {};
    roster.tabs[tabName] = { sport: sport || null, at: Date.now() };
    try {
      GM_setValue(ZCODE_TAB_ROSTER_KEY, roster);
    } catch (_) {}
    return roster;
  }

  /**
   * When board sports shrink (NBA+NCAAB → NHL), one obsolete tab navigates to the
   * missing sport; surplus obsolete tabs close instead of all jumping to NHL.
   */
  function settleZcodeTabForWant(payload) {
    const sports = normalizeWantSports(payload);
    if (!sports.length) return false;
    const wantAt = Number(payload && payload.updatedAt) || Date.now();
    const cur = currentZcodeSportFromUrl();
    const myName = ensureZcodeWindowName();

    if (cur && sports.indexOf(cur) >= 0) {
      window.name = 'pc-zcode-' + cur;
      registerZcodeTabRoster(wantAt, window.name, cur);
      return false;
    }

    registerZcodeTabRoster(wantAt, myName, cur);

    setTimeout(() => {
      try {
        const stillCur = currentZcodeSportFromUrl();
        const stillName = ensureZcodeWindowName();
        if (stillCur && sports.indexOf(stillCur) >= 0) {
          window.name = 'pc-zcode-' + stillCur;
          return;
        }
        registerZcodeTabRoster(wantAt, stillName, stillCur);
        let roster = null;
        try {
          roster = GM_getValue(ZCODE_TAB_ROSTER_KEY, null);
        } catch (_) {}
        if (!roster || Number(roster.wantAt) !== wantAt) return;

        const tabIds = Object.keys(roster.tabs || {}).sort();
        const covered = Object.create(null);
        tabIds.forEach((id) => {
          const sp = String((roster.tabs[id] && roster.tabs[id].sport) || '').toUpperCase();
          if (sp && sports.indexOf(sp) >= 0 && !covered[sp]) covered[sp] = id;
        });
        const missing = sports.filter((sp) => !covered[sp]);
        const obsolete = tabIds.filter((id) => {
          const sp = String((roster.tabs[id] && roster.tabs[id].sport) || '').toUpperCase();
          return !sp || sports.indexOf(sp) < 0;
        });

        const myRank = obsolete.indexOf(stillName);
        if (myRank < 0) return;

        if (myRank < missing.length) {
          navigateZcodeToSport(missing[myRank]);
          return;
        }

        log('ZCode closing surplus tab', stillName, stillCur || '', '→ want', sports.join('+'));
        try {
          window.close();
        } catch (_) {}
      } catch (e) {
        log('ZCode settle failed', e && e.message);
      }
    }, 220);

    return false;
  }

  /** Follow 4codds board sport want — multi-tab aware (close extras, don't clone NHL). */
  function applyZcodeSportFromWant(payload) {
    if (!payload) return false;
    const sports = normalizeWantSports(payload);
    if (!sports.length) return false;
    const cur = currentZcodeSportFromUrl();
    if (cur && sports.indexOf(cur) >= 0) {
      window.name = 'pc-zcode-' + cur;
      return false;
    }
    if (zcodeWantSettleTimer) clearTimeout(zcodeWantSettleTimer);
    zcodeWantSettleTimer = setTimeout(() => {
      zcodeWantSettleTimer = 0;
      settleZcodeTabForWant(payload);
    }, 80);
    return false;
  }

  function zcodeUrlForSport(sport) {
    const sp = String(sport || '').toUpperCase();
    return 'https://zcodesystem.com/linereversals.php?sport=' + encodeURIComponent(sp);
  }

  /** Open one ZCode tab per needed sport (named windows so re-tap focuses). */
  function openNeededZcodeTabs() {
    const sports = boardZcodeSportsNeeded();
    if (!sports.length) {
      log('Open Zcode: no board sports');
      return [];
    }
    publishFourCSportWant(true);
    sports.forEach((sp, i) => {
      const openOne = () => {
        try {
          window.open(zcodeUrlForSport(sp), 'pc-zcode-' + sp);
        } catch (e) {
          log('Open Zcode failed', sp, e && e.message);
        }
      };
      if (i === 0) openOne();
      else setTimeout(openOne, i * 450);
    });
    log('Open Zcode →', sports.join('+'));
    return sports;
  }

  /** 4codds SPA: publish sport whenever the path changes (pushState / clicks). */
  function watchFourCSportRoute() {
    let last = location.pathname + location.search;
    const bump = () => {
      const key = location.pathname + location.search;
      if (key === last) {
        publishFourCSportWant(false);
        return;
      }
      last = key;
      publishFourCSportWant(true);
    };
    try {
      const wrap = (fn) =>
        function () {
          const ret = fn.apply(this, arguments);
          setTimeout(bump, 0);
          setTimeout(bump, 200);
          return ret;
        };
      history.pushState = wrap(history.pushState.bind(history));
      history.replaceState = wrap(history.replaceState.bind(history));
    } catch (_) {}
    window.addEventListener('popstate', () => setTimeout(bump, 0));
    document.addEventListener(
      'click',
      (e) => {
        const a = e && e.target && e.target.closest && e.target.closest('a[href]');
        if (!a) return;
        const href = String(a.getAttribute('href') || '');
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
        const internal =
          href.startsWith('/') || /4codds\.com/i.test(href) || !/^[a-z]+:/i.test(href);
        if (!internal) return;
        setTimeout(bump, 50);
        setTimeout(bump, 400);
      },
      true
    );
    setInterval(bump, 1000);
    publishFourCSportWant(true);
  }

  function bootZcodeBridge() {
    // Follow 4codds board → ?sport= before scraping
    try {
      const want = typeof GM_getValue === 'function' ? GM_getValue(ZCODE_SPORT_WANT_KEY, null) : null;
      log('ZCode sport want on boot', want && want.sport, 'url', currentZcodeSportFromUrl());
      if (applyZcodeSportFromWant(want)) return; // navigating away
    } catch (_) {}

    try {
      if (typeof GM_addValueChangeListener === 'function') {
        GM_addValueChangeListener(ZCODE_SPORT_WANT_KEY, (_n, _o, v, remote) => {
          log('ZCode sport want event', v && v.sport, remote ? 'remote' : 'local');
          applyZcodeSportFromWant(v);
        });
      }
    } catch (_) {}
    setInterval(() => {
      try {
        const want =
          typeof GM_getValue === 'function' ? GM_getValue(ZCODE_SPORT_WANT_KEY, null) : null;
        applyZcodeSportFromWant(want);
      } catch (_) {}
    }, 800);

    let lastFp = '';
    const tick = (force) => {
      const n = publishZcodeLive(!!force);
      let fp = '';
      try {
        const payload = GM_getValue(ZCODE_LIVE_KEY, null);
        fp = payload && payload.fp != null ? String(payload.fp) : '';
      } catch (_) {}
      if (fp && fp !== lastFp) {
        lastFp = fp;
        log('ZCode live published', n, 'games (ratios changed)');
        try {
          const b = document.getElementById('pc-zcode-bridge-badge');
          const sp = currentZcodeSportFromUrl() || '?';
          if (b) b.textContent = '4C bridge · ' + sp + ' · ' + n + ' ratios';
        } catch (_) {}
      }
    };
    tick(true);
    setInterval(() => tick(false), 2500);
    try {
      let moTimer = 0;
      const mo = new MutationObserver(() => {
        if (moTimer) clearTimeout(moTimer);
        moTimer = setTimeout(() => {
          moTimer = 0;
          tick(false);
        }, 200);
      });
      const root =
        document.querySelector('.GamesList, .main, #app, main') || document.body;
      if (root) {
        // characterData: catch in-place <b> ratio text updates
        mo.observe(root, { childList: true, subtree: true, characterData: true });
      }
    } catch (_) {}
    try {
      if (!document.getElementById('pc-zcode-bridge-badge')) {
        const b = document.createElement('div');
        b.id = 'pc-zcode-bridge-badge';
        const sp = currentZcodeSportFromUrl() || '?';
        b.textContent = '4C bridge · ' + sp;
        b.style.cssText =
          'position:fixed;bottom:12px;right:12px;z-index:99999;padding:6px 10px;border-radius:8px;background:#1e3a4c;color:#9ed0ff;font:600 11px/1.2 Sora,Segoe UI,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.35);pointer-events:none';
        document.documentElement.appendChild(b);
      }
    } catch (_) {}
    log('ZCode → 4C bridge armed (live Public Ratio + sport sync · v3.2.1)');
  }

  function toProb(a) {
    if (a == null || !Number.isFinite(a) || a === 0) return null;
    return a > 0 ? 100 / (a + 100) : Math.abs(a) / (Math.abs(a) + 100);
  }

  function probToAm(p) {
    if (p == null || !Number.isFinite(p) || p <= 0 || p >= 1) return null;
    if (p >= 0.5) return -Math.round((p / (1 - p)) * 100);
    return Math.round(((1 - p) / p) * 100);
  }

  function parseAmText(t) {
    const m = String(t || '')
      .trim()
      .replace(/,/g, '')
      .match(/^([+-]?\d+)$/);
    return m ? parseInt(m[1], 10) : null;
  }

  /** Cover-prob value of one half-point step (football keys 3 / 7 heavier). */
  function halfPointCoverProb(fromLine, toLine) {
    const a = Math.abs(fromLine);
    const b = Math.abs(toLine);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    // Half that reaches/crosses 3 or 7
    if ((lo < 3 && hi >= 3) || (lo < 7 && hi >= 7)) return 0.025;
    return 0.012;
  }

  /**
   * Net cover-prob shift moving a side's number from `line` → `refLine`.
   * Higher algebraic line is better for that side (dog +3 > +2.5; fav −2.5 > −3).
   */
  function spreadCoverProbShift(line, refLine) {
    if (line == null || refLine == null || line === refLine) return 0;
    const step = line < refLine ? 0.5 : -0.5;
    let cur = line;
    let shift = 0;
    let guard = 0;
    while (Math.abs(cur - refLine) > 1e-9 && guard++ < 80) {
      const next = Math.abs(cur + step - refLine) < Math.abs(cur - refLine) ? cur + step : refLine;
      const hp = halfPointCoverProb(cur, next);
      // Moving up algebraically improves cover odds for this side
      shift += next > cur ? hp : -hp;
      cur = next;
    }
    return shift;
  }

  /**
   * Equivalent American at the board's main number (mode of posted lines).
   * Alt +2.5 +101 vs main +3 → juice stepped down across the key.
   */
  function equivAmAtRefLine(line, am, refLine) {
    if (am == null || !Number.isFinite(am)) return null;
    if (
      line == null ||
      refLine == null ||
      !Number.isFinite(line) ||
      !Number.isFinite(refLine) ||
      line === refLine
    ) {
      return am;
    }
    const p = toProb(am);
    if (p == null) return am;
    // Better number at ref → same EV needs worse juice (higher break-even)
    const equivP = Math.min(
      0.99,
      Math.max(0.01, p + spreadCoverProbShift(line, refLine))
    );
    const out = probToAm(equivP);
    return out != null ? out : am;
  }

  /** Most common half-point line on the side (board consensus number). */
  function modeLine(nums) {
    const counts = new Map();
    for (let i = 0; i < nums.length; i++) {
      const n = nums[i];
      if (n == null || !Number.isFinite(n)) continue;
      const k = Math.round(n * 2) / 2;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    let best = null;
    let bestC = 0;
    counts.forEach((c, k) => {
      if (c > bestC || (c === bestC && best != null && Math.abs(k) < Math.abs(best))) {
        best = k;
        bestC = c;
      }
    });
    return best;
  }

  function routeInfo() {
    const parts = location.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
    const live = parts[0] === 'live';
    const base = live ? parts.slice(1) : parts;
    if (!base.length || base[0] === 'faq' || base[0] === 'hot') {
      return { board: 'hot', league: null, live: false, sport: null };
    }
    return {
      board: base[0],
      league: base[1] && base[1] !== 'props' ? String(base[1]).toUpperCase() : null,
      live,
      sport: base[0],
    };
  }

  /** Only fix the broken /baseball/mlb path. */
  function fixBrokenBoardRoute() {
    const path = String(location.pathname || '').replace(/\/+$/, '');
    const m = path.match(/^\/(live\/)?baseball\/mlb(\/.*)?$/i);
    if (!m) return false;
    const next =
      '/' + (m[1] || '') + 'baseball' + (m[2] || '') + location.search + location.hash;
    location.replace(next);
    return true;
  }

  /**
   * Basketball: keep league nav on All so NBA + NCAAB share one board.
   * Skips props / outrights / game pages. Does not open Zcode.
   */
  function ensureBasketballAllChip() {
    const path = String(location.pathname || '').toLowerCase().replace(/\/+$/, '') || '/';
    if (!/(^|\/)basketball(\/|$)/.test(path)) return false;
    if (/\/(props|outrights|game)(\/|$)/.test(path)) return false;

    const nav =
      document.querySelector('nav.leagueNav') ||
      document.querySelector('.leagueNav') ||
      document.querySelector('.scrollRow.leagues');
    if (!nav) return false;

    const chips = Array.from(nav.querySelectorAll('a.chip, button.chip'));
    const allChip = chips.find((el) => {
      const label = String(el.textContent || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (/^All\b/i.test(label)) return true;
      const href = String(el.getAttribute('href') || '')
        .toLowerCase()
        .replace(/\/+$/, '');
      return href === '/basketball' || href.endsWith('/basketball');
    });
    if (!allChip) return false;

    const on =
      allChip.classList.contains('on') ||
      allChip.getAttribute('aria-current') === 'page' ||
      allChip.classList.contains('router-link-exact-active');
    if (on) return false;

    const now = Date.now();
    if (now - lastBasketballAllEnsureAt < 1500) return false;
    lastBasketballAllEnsureAt = now;

    try {
      allChip.click();
      log('Basketball → All (include NCAAB)');
      return true;
    } catch (_) {
      const href = allChip.getAttribute('href');
      if (href) {
        location.assign(href);
        return true;
      }
    }
    return false;
  }

  function scrubUnknownView() {
    document
      .querySelectorAll('.board .state.err, .boardPane .state.err, section.board .state.err')
      .forEach((el) => {
        if (/unknown_view/i.test((el.textContent || '').trim())) el.remove();
      });
  }

  function ensureStyle() {
    let s = document.getElementById(STYLE_ID);
    if (!s) {
      s = document.createElement('style');
      s.id = STYLE_ID;
      document.documentElement.appendChild(s);
    }
    const css = `
.gRow.gGame .cell.cBook .px{position:relative;display:inline-flex!important;flex-direction:column;align-items:center;justify-content:center;gap:1px;line-height:1.15}
.pc-price-rank{display:inline-block;margin-top:1px;padding:0 4px;border-radius:4px;font:800 9px/1.2 Sora,system-ui,sans-serif;font-variant-numeric:tabular-nums;color:#000!important;letter-spacing:0;pointer-events:none;white-space:nowrap;background:#7ecbff}
.pc-price-rank.role-dog{background:#ff8a8a}
.pc-price-rank.role-draw{background:#ffa500}
.pc-price-rank.tier-best{background:#ffeb3b}
.pc-price-rank.tier-green{background:#a6ff4d}
.pc-price-rank.tier-deep{background:#4a9eff}
/* My Line: inset border + glow when Vertex is board best — Take FAV green / DOG orange */
.gRow.gGame .cell.cFair.pc-vertex-best{
  border-radius:5px!important;
}
.gRow.gGame .cell.cFair.pc-vertex-best.role-fav{
  box-shadow:
    inset 0 0 0 1.5px rgba(57,255,20,.95),
    inset 0 0 10px rgba(57,255,20,.45),
    inset 0 0 18px rgba(57,255,20,.25)!important;
}
.gRow.gGame .cell.cFair.pc-vertex-best.role-dog{
  box-shadow:
    inset 0 0 0 1.5px rgba(255,106,0,.95),
    inset 0 0 10px rgba(255,106,0,.45),
    inset 0 0 18px rgba(255,106,0,.25)!important;
}
.gRow.gGame .cell.cFair.pc-circa-take{position:relative}
.gRow.gGame .cell.cFair.pc-circa-take > .px{visibility:hidden!important;pointer-events:none}
.gRow.gGame .cell.cFair .pc-circa-take-msg{position:absolute;inset:2px 3px;display:flex;align-items:center;justify-content:center;text-align:center;font:800 9px/1.15 Sora,system-ui,sans-serif;pointer-events:none;z-index:2;overflow:hidden;hyphens:auto}
.gRow.gGame .cell.cFair .pc-circa-take-msg.role-fav{color:#39ff14;text-shadow:0 0 10px rgba(57,255,20,.7),0 0 2px #000}
.gRow.gGame .cell.cFair .pc-circa-take-msg.role-dog{color:#ff6a00;text-shadow:0 0 10px rgba(255,106,0,.7),0 0 2px #000}
.gRow.gGame .team .pc-otc-badge{display:inline-block;margin-right:5px;vertical-align:middle;font:900 11px/1 Sora,system-ui,sans-serif;letter-spacing:-0.01em;pointer-events:none;white-space:nowrap;flex-shrink:0}
.gRow.gGame .team .pc-otc-badge.role-fav{color:#39ff14;text-shadow:0 0 8px rgba(57,255,20,.55),0 0 1px #000}
.gRow.gGame .team .pc-otc-badge.role-dog{color:#ff9800;text-shadow:0 0 8px rgba(255,152,0,.45),0 0 1px #000}
.gRow.gGame .team.pc-zcode-host{position:relative!important}
.gRow.gGame .team .pc-zcode-ratio{position:absolute;right:0;top:50%;transform:translateY(-50%);margin:0;padding:2px 7px;border-radius:5px;font:800 12px/1.2 Sora,system-ui,sans-serif;font-variant-numeric:tabular-nums;letter-spacing:0;pointer-events:none;white-space:nowrap;z-index:3;background:#1e3a4c;color:#9ed0ff;border:1px solid rgba(158,208,255,.28);box-shadow:0 1px 3px rgba(0,0,0,.3)}
.gRow.gGame .team .pc-zcode-ratio.tier-lo{background:#2e7d32;color:#e8ffe9;border-color:rgba(165,214,167,.55)}
.gRow.gGame .team .pc-zcode-ratio.tier-soft{background:#1e3a4c;color:#9ed0ff;border-color:rgba(158,208,255,.28)}
.gRow.gGame .team .pc-zcode-ratio.tier-mid{background:#f0c419;color:#1a1400;border-color:rgba(240,196,25,.7)}
.gRow.gGame .team .pc-zcode-ratio.tier-hi{background:#d32f2f;color:#fff;border-color:rgba(255,180,180,.55)}
.gRow.gGame .team .pc-zcode-ratio.role-dog{background:#1e3a4c!important;color:#9ed0ff!important;border-color:rgba(158,208,255,.28)!important}
/* Name highlight on .team only — never pad/border .tName (triggers 4C abbr flicker) */
.gRow.gGame .team.pc-zcode-name{border-radius:6px;box-shadow:inset 0 0 0 1px transparent}
.gRow.gGame .team.pc-zcode-name.pc-zr-lo{background:rgba(46,125,50,.55);box-shadow:inset 0 0 0 1px rgba(165,214,167,.55)}
.gRow.gGame .team.pc-zcode-name.pc-zr-soft{background:rgba(30,58,76,.65);box-shadow:inset 0 0 0 1px rgba(158,208,255,.28)}
.gRow.gGame .team.pc-zcode-name.pc-zr-mid{background:rgba(240,196,25,.55);box-shadow:inset 0 0 0 1px rgba(240,196,25,.7)}
.gRow.gGame .team.pc-zcode-name.pc-zr-hi{background:rgba(211,47,47,.55);box-shadow:inset 0 0 0 1px rgba(255,180,180,.55)}
.gRow.gGame .team.pc-zcode-name .tName{font-weight:800}
.board .state.err,.boardPane .state.err,section.board .state.err{display:none!important}
#pc-book-league-sync{position:fixed;right:14px;bottom:calc(14px + env(safe-area-inset-bottom,0px));z-index:99999;max-width:260px;padding:8px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:rgba(18,26,38,.92);color:#c8d4e6;font:650 11px/1.35 Sora,system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.35);pointer-events:none}
#pc-book-league-sync .pc-bl-title{font:800 11px/1.2 Sora,system-ui,sans-serif;color:#e8eef8;margin:0 0 2px}
#pc-book-league-sync.warn{border-color:rgba(252,165,165,.35);color:#fecaca}
#pc-take-rec{position:fixed;right:max(14px,env(safe-area-inset-right,0px));top:max(58px,env(safe-area-inset-top,0px));z-index:100000;width:min(320px,calc(100vw - 28px));max-height:min(42vh,420px);overflow:auto;-webkit-overflow-scrolling:touch;padding:10px 12px;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:rgba(12,18,28,.94);color:#c8d4e6;font:650 11px/1.35 Sora,system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.4);backdrop-filter:blur(8px);touch-action:manipulation;-webkit-text-size-adjust:100%}
#pc-take-rec .pc-tr-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 8px;cursor:pointer;-webkit-user-select:none;user-select:none}
#pc-take-rec .pc-tr-head-text{min-width:0;flex:1}
#pc-take-rec .pc-tr-title{font:800 12px/1.2 Sora,system-ui,sans-serif;color:#e8eef8;letter-spacing:-0.01em}
#pc-take-rec .pc-tr-sub{font:650 9px/1.2 Sora,system-ui,sans-serif;color:#8a97ad}
#pc-take-rec .pc-tr-tog{flex-shrink:0;width:32px;height:32px;border:1px solid rgba(255,255,255,.16);border-radius:8px;background:rgba(255,255,255,.06);color:#e8eef8;font:800 14px/1 Sora,system-ui,sans-serif;cursor:pointer;touch-action:manipulation}
#pc-take-rec.pc-tr-collapsed{max-height:none;overflow:hidden}
#pc-take-rec.pc-tr-collapsed .pc-tr-body{display:none}
#pc-take-rec.pc-tr-collapsed .pc-tr-tog{transform:rotate(-90deg)}
@media (max-width:900px),(pointer:coarse){
  #pc-take-rec{
    top:auto;
    right:max(10px,env(safe-area-inset-right,0px));
    left:max(10px,env(safe-area-inset-left,0px));
    bottom:calc(52px + env(safe-area-inset-bottom,0px));
    width:auto;
    max-height:min(46vh,380px);
    z-index:100001;
  }
  #pc-take-rec.pc-tr-collapsed{
    left:auto;
    width:auto;
    max-width:calc(100vw - 24px);
    padding:8px 10px;
  }
  #pc-book-league-sync{
    right:auto;
    left:max(10px,env(safe-area-inset-left,0px));
    bottom:calc(8px + env(safe-area-inset-bottom,0px));
    max-width:min(220px,calc(100vw - 24px));
    font-size:10px;
    padding:6px 9px;
  }
  #pc-take-rec .pc-tr-row{min-height:44px;padding:7px 8px}
  #pc-take-rec .pc-tr-agree{display:none}
}
#pc-take-rec .pc-tr-sec{margin:0 0 8px}
#pc-take-rec .pc-tr-sec:last-child{margin-bottom:0}
#pc-take-rec .pc-tr-lbl{font:800 9px/1.2 Sora,system-ui,sans-serif;letter-spacing:0.04em;text-transform:uppercase;margin:0 0 4px}
#pc-take-rec .pc-tr-lbl.role-fav{color:#39ff14;text-shadow:0 0 8px rgba(57,255,20,.35)}
#pc-take-rec .pc-tr-lbl.role-dog{color:#ff6a00;text-shadow:0 0 8px rgba(255,106,0,.35)}
#pc-take-rec .pc-tr-empty{color:#6b7a90;font:650 10px/1.3 Sora,system-ui,sans-serif;padding:2px 0 4px}
#pc-take-rec .pc-tr-row{display:flex;align-items:center;gap:6px;width:100%;margin:0 0 3px;padding:5px 7px;border:1px solid rgba(255,255,255,.08);border-radius:8px;background:rgba(255,255,255,.03);color:inherit;font:inherit;text-align:left;cursor:pointer}
#pc-take-rec .pc-tr-row:hover{background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.16)}
#pc-take-rec .pc-tr-row.role-fav{
  border-color:rgba(57,255,20,.55);
  box-shadow:
    inset 0 0 0 1px rgba(57,255,20,.85),
    inset 0 0 10px rgba(57,255,20,.35),
    0 0 12px rgba(57,255,20,.18);
}
#pc-take-rec .pc-tr-row.role-dog{
  border-color:rgba(255,106,0,.55);
  box-shadow:
    inset 0 0 0 1px rgba(255,106,0,.85),
    inset 0 0 10px rgba(255,106,0,.35),
    0 0 12px rgba(255,106,0,.18);
}
#pc-take-rec .pc-tr-row.role-fav:hover{
  background:rgba(57,255,20,.08);
  border-color:rgba(57,255,20,.75);
}
#pc-take-rec .pc-tr-row.role-dog:hover{
  background:rgba(255,106,0,.08);
  border-color:rgba(255,106,0,.75);
}
#pc-take-rec .pc-tr-when{flex-shrink:0;display:flex;flex-direction:column;align-items:flex-start;gap:1px;min-width:3.4em;line-height:1.05}
#pc-take-rec .pc-tr-day{font:800 8px/1 Sora,system-ui,sans-serif;color:#7b879c;letter-spacing:0.02em;text-transform:uppercase}
#pc-take-rec .pc-tr-time{font:800 10px/1 Sora,system-ui,sans-serif;font-variant-numeric:tabular-nums;color:#9aa8bd;letter-spacing:-0.02em}
#pc-take-rec .pc-tr-str{flex-shrink:0;display:flex;align-items:baseline;justify-content:center;gap:1px;min-width:2.35em;padding:3px 5px;border-radius:5px;background:rgba(255,255,255,.07);font:800 12px/1 Sora,system-ui,sans-serif;font-variant-numeric:tabular-nums;color:#e8eef8;letter-spacing:-0.02em}
#pc-take-rec .pc-tr-str .pc-tr-str-den{font:650 8px/1 Sora,system-ui,sans-serif;color:#8a97ad}
#pc-take-rec .pc-tr-str.hi{background:rgba(57,255,20,.16);color:#9dff8a}
#pc-take-rec .pc-tr-str.mid{background:rgba(240,196,25,.16);color:#f5d76e}
#pc-take-rec .pc-tr-str.lo{background:rgba(211,47,47,.18);color:#ff8a80}
#pc-take-rec .pc-tr-str.na{opacity:.45;font-weight:700}
#pc-take-rec .pc-tr-row.role-fav .pc-tr-day{color:#6dbf5c}
#pc-take-rec .pc-tr-row.role-dog .pc-tr-day{color:#c67a3a}
#pc-take-rec .pc-tr-row.role-fav .pc-tr-time{color:#9dff8a;text-shadow:0 0 8px rgba(57,255,20,.45)}
#pc-take-rec .pc-tr-row.role-dog .pc-tr-time{color:#ffb078;text-shadow:0 0 8px rgba(255,106,0,.45)}
#pc-take-rec .pc-tr-teams{flex:1;min-width:0;display:flex;flex-direction:column;align-items:flex-start;gap:1px;overflow:hidden}
#pc-take-rec .pc-tr-take{font:800 11px/1.15 Sora,system-ui,sans-serif;color:#fff;text-shadow:0 0 1px #000;margin-right:4px;flex-shrink:0}
#pc-take-rec .pc-tr-pick{display:flex;align-items:baseline;max-width:100%;overflow:hidden}
#pc-take-rec .pc-tr-team{min-width:0;font:800 11px/1.15 Sora,system-ui,sans-serif;color:#e8eef8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#pc-take-rec .pc-tr-opp{max-width:100%;font:650 9px/1.15 Sora,system-ui,sans-serif;color:#8a97ad;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#pc-take-rec .pc-tr-row.role-fav .pc-tr-team{color:#39ff14;text-shadow:0 0 10px rgba(57,255,20,.55),0 0 2px #000}
#pc-take-rec .pc-tr-row.role-dog .pc-tr-team{color:#ff6a00;text-shadow:0 0 10px rgba(255,106,0,.55),0 0 2px #000}
#pc-take-rec .pc-tr-ratio{flex-shrink:0;font:800 11px/1 Sora,system-ui,sans-serif;font-variant-numeric:tabular-nums;padding:2px 6px;border-radius:5px}
#pc-take-rec .pc-tr-ratio.lo{background:#2e7d32;color:#e8ffe9}
#pc-take-rec .pc-tr-ratio.mid{background:#f0c419;color:#1a1400}
#pc-take-rec .pc-tr-ratio.hi{background:#d32f2f;color:#fff}
#pc-take-rec .pc-tr-agree{flex-shrink:0;font:650 9px/1 Sora,system-ui,sans-serif;color:#8a97ad;font-variant-numeric:tabular-nums}
#pc-take-rec .pc-tr-tools{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px}
#pc-take-rec .pc-tr-zcode-btn,#pc-take-rec .pc-tr-against-btn{flex:1;min-width:0;margin:0;padding:6px 8px;border:1px solid rgba(255,255,255,.14);border-radius:8px;background:rgba(255,255,255,.05);color:#9aa8bd;font:750 10px/1.2 Sora,system-ui,sans-serif;cursor:pointer;text-align:left;touch-action:manipulation}
#pc-take-rec .pc-tr-zcode-head{flex:0 0 auto;min-height:36px;min-width:5.6em;padding:7px 11px;border:1px solid rgba(158,208,255,.4);border-radius:9px;background:rgba(30,58,76,.95);color:#9ed0ff;font:800 11px/1.1 Sora,system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.28);white-space:nowrap}
#pc-take-rec .pc-tr-zcode-btn:hover,#pc-take-rec .pc-tr-zcode-head:hover{border-color:rgba(158,208,255,.7);color:#dff0ff;background:rgba(40,78,102,.98)}
#pc-take-rec .pc-tr-against-btn.on{border-color:rgba(255,152,0,.55);background:rgba(255,106,0,.16);color:#ffb078;box-shadow:inset 0 0 0 1px rgba(255,106,0,.35)}
#pc-take-rec .pc-tr-against-btn:hover{border-color:rgba(255,255,255,.28);color:#e8eef8}
@media (max-width:900px),(pointer:coarse){
  #pc-take-rec .pc-tr-zcode-head{min-height:44px;padding:10px 14px;font-size:13px}
  #pc-take-rec .pc-tr-zcode-btn,#pc-take-rec .pc-tr-against-btn{min-height:44px;padding:10px 12px;font-size:12px}
}
#pc-take-rec .pc-tr-move{flex-shrink:0;font:800 9px/1 Sora,system-ui,sans-serif;font-variant-numeric:tabular-nums;padding:2px 5px;border-radius:4px;background:rgba(255,152,0,.2);color:#ffb078;white-space:nowrap}
#pc-take-rec .pc-tr-move.with{background:rgba(100,120,150,.22);color:#9aa8bd}
#pc-take-rec .pc-tr-move.vs{background:rgba(255,106,0,.22);color:#ffb078}
#pc-take-rec .pc-tr-row.role-fav .pc-tr-move.vs{background:rgba(57,255,20,.16);color:#9dff8a}
.gRow.gGame.pc-tr-flash{outline:2px solid rgba(57,255,20,.85);outline-offset:-2px;border-radius:6px}
`;
    if (s.textContent !== css) s.textContent = css;
  }

  function tradBoardGames() {
    return document.querySelectorAll(
      [
        '.gTable .gRow.gGame[data-game]',
        '.gTable .gRow.gGame[id^="g-"]',
        'section.trad .gRow.gGame[data-game]',
        '.boardPane .gRow.gGame[data-game]',
        '.board .gRow.gGame[data-game]',
        '.gScroll .gRow.gGame[data-game]',
        '.gRow.gGame[data-game]',
      ].join(', ')
    );
  }

  function tradFairCell(gameEl) {
    if (!gameEl) return null;
    return (
      gameEl.querySelector(':scope > .cell.cFair') ||
      gameEl.querySelector('.cell.cFair')
    );
  }

  function tradBookHeaderEls() {
    const head =
      document.querySelector('.gTable .gRow.gHead') ||
      document.querySelector('section.trad .gRow.gHead') ||
      document.querySelector('.boardPane .gRow.gHead');
    if (!head) return [];
    return Array.from(head.querySelectorAll('.hCell.hBook[data-code]'));
  }

  function tradBookHeaderCodes() {
    return tradBookHeaderEls().map((el) => String(el.getAttribute('data-code') || '').toUpperCase());
  }

  function tradPxAmerican(el) {
    if (!el || el.classList.contains('none') || el.disabled) return null;
    const pr = el.querySelector(':scope > .pr');
    if (pr) {
      const j = parseAmText(String(pr.textContent || '').trim());
      if (j != null) return j;
    }
    const bestPrice = el.classList.contains('bestPrice')
      ? el
      : el.querySelector(':scope > .bestPrice, .bestPrice');
    if (bestPrice) {
      const aria = String(bestPrice.getAttribute('aria-label') || '');
      const juiceAria = aria.match(/([+-]\d{2,4})(?:\s*,|\s*$)/);
      if (juiceAria) return parseInt(juiceAria[1], 10);
      const b = bestPrice.querySelector('b');
      if (b) {
        const j = parseAmText(String(b.textContent || '').trim());
        if (j != null) return j;
      }
    }
    const aria = String(el.getAttribute('aria-label') || '');
    const juiceAria = aria.match(/([+-]\d{2,4})(?:\s*,|\s*$)/);
    if (juiceAria) return parseInt(juiceAria[1], 10);
    const fromAria = aria.match(/(?:^|\s)([+-]\d{2,4})(?:\s|,|$)/);
    if (fromAria) return parseInt(fromAria[1], 10);
    let t = '';
    for (let i = 0; i < el.childNodes.length; i++) {
      const n = el.childNodes[i];
      if (n.nodeType === 3) t += n.textContent || '';
      else if (
        n.nodeType === 1 &&
        n.classList &&
        !n.classList.contains('pc-price-rank') &&
        !n.classList.contains('pc-circa-take-msg') &&
        !n.classList.contains('mark') &&
        !n.classList.contains('num') &&
        !n.classList.contains('lp')
      ) {
        t += n.textContent || '';
      }
    }
    return parseAmText(t.trim());
  }

  function tradPxLine(el) {
    if (!el) return null;
    const num = el.querySelector('small.num, :scope > .num, .lp .trigger');
    if (num) {
      const m = String(num.textContent || '')
        .trim()
        .match(/^([+-]?\d+(?:\.\d+)?)/);
      if (m) return parseFloat(m[1]);
    }
    const ariaHost = el.getAttribute('aria-label')
      ? el
      : el.querySelector('.bestPrice, [aria-label]');
    const aria = ariaHost ? String(ariaHost.getAttribute('aria-label') || '') : '';
    const m2 = aria.match(/([+-]?\d+(?:\.\d+)?)\s+[+-]\d{2,4}/);
    return m2 ? parseFloat(m2[1]) : null;
  }

  function tradCellSidePrices(cell) {
    if (!cell) return [];
    const pxs = cell.querySelectorAll(':scope > .px, :scope > button.px, :scope > span.px');
    const n = pxs.length >= 3 ? 3 : Math.min(2, pxs.length);
    const out = [];
    for (let i = 0; i < n; i++) out.push(tradPxAmerican(pxs[i]));
    return out;
  }

  function tradCellSideLines(cell) {
    if (!cell) return [];
    const pxs = cell.querySelectorAll(':scope > .px, :scope > button.px, :scope > span.px');
    const n = pxs.length >= 3 ? 3 : Math.min(2, pxs.length);
    const out = [];
    for (let i = 0; i < n; i++) out.push(tradPxLine(pxs[i]));
    return out;
  }

  function tradCellSideEls(cell) {
    if (!cell) return [];
    const pxs = cell.querySelectorAll(':scope > .px, :scope > button.px, :scope > span.px');
    const n = pxs.length >= 3 ? 3 : Math.min(2, pxs.length);
    const out = [];
    for (let i = 0; i < n; i++) out.push(pxs[i] || null);
    return out;
  }

  function tradOutcomeCount(gameEl) {
    const cells = [
      gameEl.querySelector(':scope > .cell.cFair'),
      gameEl.querySelector(':scope > .cell.cBest'),
    ].concat(Array.from(gameEl.querySelectorAll(':scope > .cell.cBook')));
    let max = 2;
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      if (!cell) continue;
      const n = cell.querySelectorAll(':scope > .px, :scope > button.px, :scope > span.px').length;
      if (n >= 3) return 3;
      if (n > max) max = n;
    }
    return max;
  }

  function tradFavSideIndex(gameEl) {
    const nOut = tradOutcomeCount(gameEl);
    const fair = tradFairCell(gameEl);
    const best =
      gameEl.querySelector(':scope > .cell.cBest') || gameEl.querySelector('.cell.cBest');
    const open =
      gameEl.querySelector(':scope > .cell.cOpen') || gameEl.querySelector('.cell.cOpen');
    const homeIdx = nOut >= 3 ? 2 : 1;
    const linePairs = [tradCellSideLines(fair), tradCellSideLines(best)];
    const books = gameEl.querySelectorAll(':scope > .cell.cBook');
    for (let i = 0; i < books.length && linePairs.length < 8; i++) {
      linePairs.push(tradCellSideLines(books[i]));
    }
    for (let p = 0; p < linePairs.length; p++) {
      const a = linePairs[p][0];
      const h = linePairs[p][homeIdx];
      if (a == null || h == null || a === h) continue;
      return a < h ? 0 : homeIdx;
    }
    const pricePairs = [
      tradCellSidePrices(best),
      tradCellSidePrices(open),
      tradCellSidePrices(fair),
    ];
    for (let i = 0; i < books.length && pricePairs.length < 14; i++) {
      pricePairs.push(tradCellSidePrices(books[i]));
    }
    for (let p = 0; p < pricePairs.length; p++) {
      const a = pricePairs[p][0];
      const h = pricePairs[p][homeIdx];
      if (a == null || h == null) continue;
      const p0 = toProb(a);
      const pH = toProb(h);
      if (p0 == null || pH == null || p0 === pH) continue;
      return p0 > pH ? 0 : homeIdx;
    }
    return null;
  }

  function tradGameBothSidesNegative(gameEl) {
    if (!gameEl) return false;
    const nOut = tradOutcomeCount(gameEl);
    const homeIdx = nOut >= 3 ? 2 : 1;
    const cells = [
      gameEl.querySelector(':scope > .cell.cBest'),
      gameEl.querySelector(':scope > .cell.cOpen'),
      gameEl.querySelector(':scope > .cell.cFair'),
    ].concat(Array.from(gameEl.querySelectorAll(':scope > .cell.cBook')));
    for (let i = 0; i < cells.length; i++) {
      const prices = tradCellSidePrices(cells[i]);
      const a = prices[0];
      const h = prices[homeIdx];
      if (a == null || h == null) continue;
      return a < 0 && h < 0;
    }
    return false;
  }

  /** Score = American juice moved onto the side's consensus number (alts normalized). */
  function assignTdrScores(entries) {
    const list = entries.filter((e) => e && e.el && e.price != null && Number.isFinite(e.price));
    const ref = modeLine(list.map((e) => e.line));
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      e.score = ref != null ? equivAmAtRefLine(e.line, e.price, ref) : e.price;
    }
    return list.filter((e) => e.score != null && Number.isFinite(e.score));
  }

  function tdrScoreKey(score) {
    return Math.round(Number(score));
  }

  function competitionRankMap(entries, useImplied) {
    const scored = assignTdrScores(entries);
    const useScore = scored.length >= 2 && scored.every((e) => e.score != null);
    const ranked = scored.slice().sort((a, b) => {
      if (useScore) {
        const d = b.score - a.score;
        if (d !== 0) return d;
        return (b.price || 0) - (a.price || 0);
      }
      if (useImplied) {
        const pa = toProb(a.price);
        const pb = toProb(b.price);
        if (pa != null && pb != null && pa !== pb) return pa - pb;
      }
      return b.price - a.price;
    });
    const y = ranked.length;
    const map = new Map();
    let i = 0;
    while (i < ranked.length) {
      let j = i + 1;
      const key = useScore ? tdrScoreKey(ranked[i].score) : ranked[i].price;
      while (
        j < ranked.length &&
        (useScore ? tdrScoreKey(ranked[j].score) === key : ranked[j].price === key)
      ) {
        j++;
      }
      const rank = i + 1;
      const joint = j - i > 1;
      for (let k = i; k < j; k++) {
        map.set(ranked[k].el, { rank: rank, y: y, joint: joint });
      }
      i = j;
    }
    return map;
  }

  function priceRankTierClass(rank) {
    if (rank === 1) return 'tier-best';
    if (rank >= 2 && rank <= 4) return 'tier-green';
    if (rank >= 10) return 'tier-deep';
    return '';
  }

  function attachPriceRankBadge(el, rank, y, role, joint) {
    if (!el || !rank || !y) return;
    const existing = el.querySelector(':scope > .pc-price-rank');
    if (existing) existing.remove();
    const badge = document.createElement('span');
    const tier = priceRankTierClass(rank);
    badge.className =
      'pc-price-rank' +
      (role === 'dog' ? ' role-dog' : '') +
      (role === 'draw' ? ' role-draw' : '') +
      (tier ? ' ' + tier : '') +
      (joint ? ' is-joint' : '');
    const label = (joint ? 'J' : '') + rank + '/' + y;
    badge.textContent = label;
    badge.title =
      (joint ? 'joint ' : '') + role + ' ' + rank + ' of ' + y;
    el.appendChild(badge);
  }

  function clearTdrMarks() {
    document.querySelectorAll('.pc-price-rank').forEach((n) => n.remove());
    document.querySelectorAll('.pc-otc-badge').forEach((n) => n.remove());
    // Keep ZCode chips in place across paints — update in markZcodeRatioChips (no flicker)
    document.querySelectorAll('.team.pc-otc-fav, .team.pc-otc-dog').forEach((el) => {
      el.classList.remove('pc-otc-fav', 'pc-otc-dog');
      const name = el.querySelector('a.tName, .tName');
      if (name && name.dataset.pcOtcTitle != null) {
        if (name.dataset.pcOtcTitle) name.setAttribute('title', name.dataset.pcOtcTitle);
        else name.removeAttribute('title');
        delete name.dataset.pcOtcTitle;
      }
    });
    tradBoardGames().forEach((gameEl) => restoreCircaTakeOnGame(gameEl));
  }

  function fmtAmShort(a) {
    if (a == null || !Number.isFinite(a)) return '?';
    a = Math.round(a);
    if (a === -100) return '+100';
    return a > 0 ? '+' + a : String(a);
  }

  function pinnacleBookCell(gameEl, codes, bookCells) {
    let idx = codes.indexOf('PINNACLE');
    if (idx < 0) idx = codes.findIndex((c) => /PINN/i.test(c));
    if (idx < 0 || idx >= bookCells.length) return null;
    return bookCells[idx];
  }

  function bookCellByCode(codes, bookCells, exact, re) {
    let idx = exact ? codes.indexOf(exact) : -1;
    if (idx < 0 && re) idx = codes.findIndex((c) => re.test(c));
    if (idx < 0 || idx >= bookCells.length) return null;
    return bookCells[idx];
  }

  function vertexBookCell(codes, bookCells) {
    return bookCellByCode(codes, bookCells, 'VERTEX', /VERTEX/i);
  }

  function pxSideTdr(cell, sideIdx) {
    if (!cell || sideIdx == null) return null;
    const els = tradCellSideEls(cell);
    return pxTdrInfo(els[sideIdx] || null);
  }

  function tradTeamNames(gameEl) {
    // Prefer .teams .team only — a broad `.team` selector can re-hit the same nodes.
    let teams = gameEl.querySelectorAll(':scope > .cGame .teams .team');
    if (!teams.length) {
      teams = gameEl.querySelectorAll(':scope > .cGame .team');
    }
    const out = [];
    const seen = new Set();
    for (let i = 0; i < teams.length; i++) {
      const label = tradTeamLabel(teams[i]);
      if (!label) continue;
      const key = normTeam(label);
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      out.push(label);
      if (out.length >= 2) break;
    }
    return out;
  }

  /** Short call-sign for My Line column width. */
  function teamCallSign(full) {
    const n = String(full || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!n) return '';
    const parts = n.split(' ');
    if (parts.length >= 2) {
      const last2 = parts.slice(-2).join(' ');
      if (
        /^(red wings|blue jackets|golden knights|maple leafs|trail blazers|white sox|red sox|blue jays)$/i.test(
          last2
        )
      ) {
        return last2;
      }
      return parts[parts.length - 1];
    }
    return n;
  }

  /** TDR badge on a px: { rank, joint, label } or null. */
  function pxTdrInfo(pxEl) {
    if (!pxEl || pxEl.classList.contains('none') || pxEl.disabled) return null;
    const badge = pxEl.querySelector(':scope > .pc-price-rank');
    if (badge) {
      const m = String(badge.textContent || '').match(/^J?(\d+)\s*\/\s*(\d+)/i);
      if (m) {
        return {
          rank: parseInt(m[1], 10),
          joint: badge.classList.contains('is-joint') || /^J/i.test(badge.textContent || ''),
          label: String(badge.textContent || '').trim(),
        };
      }
    }
    // Site “best” class before badges land
    if (pxEl.classList.contains('best') || pxEl.querySelector(':scope > .pc-price-rank.tier-best')) {
      return { rank: 1, joint: false, label: 'best' };
    }
    return null;
  }

  function restoreCircaTakeOnGame(gameEl) {
    if (!gameEl) return;
    const fairCell = tradFairCell(gameEl);
    if (!fairCell) return;
    fairCell.querySelectorAll(':scope > .pc-circa-take-msg').forEach((n) => n.remove());
    if (fairCell.classList.contains('pc-circa-take')) {
      if (fairCell.dataset.pcFairTitle != null) {
        if (fairCell.dataset.pcFairTitle) {
          fairCell.setAttribute('title', fairCell.dataset.pcFairTitle);
        } else {
          fairCell.removeAttribute('title');
        }
        delete fairCell.dataset.pcFairTitle;
      }
      fairCell.classList.remove('pc-circa-take');
    }
  }

  /** Inset glow when Vertex is in the Best column (any number). */
  function markVertexBestGlow(gameEl) {
    if (!gameEl) return;
    const fairCell = tradFairCell(gameEl);
    if (!fairCell) return;
    fairCell.classList.remove('pc-vertex-best', 'role-fav', 'role-dog');
    const nOut = tradOutcomeCount(gameEl);
    const favIdx = tradFavSideIndex(gameEl);
    if (favIdx == null) return;
    const homeIdx = nOut >= 3 ? 2 : 1;
    const dogIdx = favIdx === 0 ? homeIdx : 0;
    const vxBestDog = vertexInBestColumn(gameEl, dogIdx);
    const vxBestFav = vertexInBestColumn(gameEl, favIdx);
    let role = null;
    if (vxBestDog && !vxBestFav) role = 'fav';
    else if (vxBestFav && !vxBestDog) role = 'dog';
    if (!role) return;
    fairCell.classList.add('pc-vertex-best', 'role-' + role);
  }

  /** Vertex logo / aria in Best column for a side. */
  function vertexInBestColumn(gameEl, sideIdx) {
    const bestCell = gameEl.querySelector(':scope > .cell.cBest');
    if (!bestCell || sideIdx == null) return false;
    const els = tradCellSideEls(bestCell);
    const side = els[sideIdx];
    if (!side) return false;
    const imgs = side.querySelectorAll('img.logo, .mark img');
    for (let i = 0; i < imgs.length; i++) {
      const a = imgs[i].getAttribute('alt') || '';
      if (/vertex/i.test(a)) return true;
    }
    const btn = side.querySelector('.bestPrice, button.bestPrice');
    if (btn && /vertex/i.test(btn.getAttribute('aria-label') || '')) return true;
    return false;
  }

  function blMidRank(y) {
    const n = Number(y);
    if (!Number.isFinite(n) || n < 1) return null;
    return Math.ceil(n / 2);
  }

  function blPointsForBook(favRank, y, favWon) {
    if (favRank == null || !Number.isFinite(favRank)) return null;
    const mid = blMidRank(y);
    if (mid == null) return null;
    const base = mid - favRank;
    return favWon ? -base : base;
  }

  function blIsMoneylineMarket(s) {
    return /money\s*line|^ml$/i.test(String((s && s.market) || ''));
  }

  function blFavTeamIndex(s) {
    const teams = Array.isArray(s && s.teams) ? s.teams : [];
    if (s && s.favTeam) {
      const i = teams.findIndex((t) => t === s.favTeam);
      if (i === 0 || i === 1) return i;
    }
    if (s && (s.favSide === 0 || s.favSide === 1)) return s.favSide;
    return null;
  }

  function blSnapSpread(s) {
    const n = Number(s && s.spread);
    return Number.isFinite(n) ? n : null;
  }

  /** ATS (spread) or ML cover for the favorite. Push / draw → void. */
  function blComputeCoverResult(s, score0, score1) {
    const favIdx = blFavTeamIndex(s);
    if (favIdx == null || !Number.isFinite(score0) || !Number.isFinite(score1)) return null;
    const dogIdx = favIdx === 0 ? 1 : 0;
    const favScore = favIdx === 0 ? score0 : score1;
    const dogScore = dogIdx === 0 ? score0 : score1;
    const margin = favScore - dogScore;
    if (blIsMoneylineMarket(s)) {
      if (margin === 0) {
        return { coverTeamIdx: 'void', gradeKind: 'ml', favCovered: null };
      }
      return {
        coverTeamIdx: margin > 0 ? favIdx : dogIdx,
        gradeKind: 'ml',
        favCovered: margin > 0,
      };
    }
    const spread = blSnapSpread(s);
    if (spread == null) return null;
    const ats = margin + spread;
    if (Math.abs(ats) < 1e-9) {
      return { coverTeamIdx: 'void', gradeKind: 'ats', favCovered: null };
    }
    return {
      coverTeamIdx: ats > 0 ? favIdx : dogIdx,
      gradeKind: 'ats',
      favCovered: ats > 0,
    };
  }

  function blApplyCoverGrade(s, awayScore, homeScore, orient) {
    const score0 = orient === 'ha' ? homeScore : awayScore;
    const score1 = orient === 'ha' ? awayScore : homeScore;
    const cover = blComputeCoverResult(s, score0, score1);
    if (!cover) return false;
    s.coverTeamIdx = cover.coverTeamIdx;
    s.gradeKind = cover.gradeKind;
    s.favCovered = cover.favCovered;
    return true;
  }

  function blSnapIsGraded(s) {
    return !!(s && s.coverTeamIdx != null && s.coverTeamIdx !== '');
  }

  /** true = fav covered (ATS) / won ML; false = dog; null = push/ungraded. */
  function blFavWonSnap(s) {
    if (!s) return null;
    if (s.coverTeamIdx === 'void') return null;
    if (s.favCovered === true || s.favCovered === false) return s.favCovered;
    if (s.coverTeamIdx === 0 || s.coverTeamIdx === 1) {
      const favIdx = blFavTeamIndex(s);
      if (favIdx == null) return null;
      return Number(s.coverTeamIdx) === favIdx;
    }
    return null;
  }

  /**
   * Sport standings from local Book League (same pts formula as book-league.js).
   * Returns null if fewer than TAKE_MIN_BL_BOOKS graded books.
   */
  function aggregateBookLeagueStandings(sportKey) {
    if (!sportKey) return null;
    const local = readLocalBookLeague();
    const updatedAt = local.updatedAt || '';
    if (blStandingsCache.updatedAt !== updatedAt) {
      blStandingsCache = { updatedAt: updatedAt, bySport: {} };
    }
    if (blStandingsCache.bySport[sportKey]) return blStandingsCache.bySport[sportKey];

    const map = new Map();
    (local.snaps || []).forEach((s) => {
      if (sportKeyFromSnap(s) !== sportKey) return;
      const won = blFavWonSnap(s);
      if (won == null) return;
      const books = s && s.books && typeof s.books === 'object' ? s.books : {};
      Object.keys(books).forEach((code) => {
        const b = books[code] || {};
        if (b.favRank == null) return;
        const pts = blPointsForBook(b.favRank, s.y, won);
        if (pts == null) return;
        const key = String(code || '').toUpperCase();
        if (!key) return;
        let row = map.get(key);
        if (!row) {
          row = { code: key, name: b.name || key, games: 0, pts: 0 };
          map.set(key, row);
        }
        row.games += 1;
        row.pts += pts;
        if (b.name) row.name = b.name;
      });
    });

    const rows = Array.from(map.values()).sort((a, b) => {
      if (b.pts !== a.pts) return b.pts - a.pts;
      const avgA = a.games ? a.pts / a.games : 0;
      const avgB = b.games ? b.pts / b.games : 0;
      if (avgB !== avgA) return avgB - avgA;
      return b.games - a.games || String(a.name).localeCompare(String(b.name));
    });

    if (rows.length < TAKE_MIN_BL_BOOKS) {
      blStandingsCache.bySport[sportKey] = null;
      return null;
    }

    const rankIndexByCode = {};
    const nameByCode = {};
    rows.forEach((r, i) => {
      rankIndexByCode[r.code] = i;
      nameByCode[r.code] = r.name || r.code;
    });

    const result = {
      rows: rows,
      bestCode: rows[0].code,
      worstCode: rows[rows.length - 1].code,
      rankIndexByCode: rankIndexByCode,
      nameByCode: nameByCode,
      n: rows.length,
    };
    blStandingsCache.bySport[sportKey] = result;
    return result;
  }

  /** Per-game .lg first (All boards mix NBA+NCAAB); else route sport. */
  function takeSportKeyForGame(gameEl) {
    const league = gameLeagueLabel(gameEl);
    if (league) {
      const fromGame = sportKeyFromSnap({ league: league, sport: '' });
      if (fromGame) return fromGame;
    }
    const fromRoute = fourCToZcodeSport();
    if (fromRoute) return fromRoute;
    const info = routeInfo();
    return sportKeyFromSnap({
      league: league || '',
      sport: (info && (info.sport || info.board)) || '',
    });
  }

  function resolveBookCode(label, codes, names) {
    const want = String(label || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    if (!want) return null;
    const list = codes || [];
    const nameList = names || [];
    for (let i = 0; i < list.length; i++) {
      if (String(list[i] || '').toLowerCase() === want) return list[i];
    }
    for (let i = 0; i < nameList.length; i++) {
      const n = String(nameList[i] || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      if (n && n === want) return list[i];
    }
    for (let i = 0; i < nameList.length; i++) {
      const n = String(nameList[i] || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      if (!n) continue;
      if (n.indexOf(want) === 0 || want.indexOf(n) === 0) return list[i];
    }
    const compact = want.replace(/[^a-z0-9]/g, '');
    if (!compact) return null;
    for (let i = 0; i < list.length; i++) {
      const c = String(list[i] || '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
      if (c && c === compact) return list[i];
      const n = String(nameList[i] || '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
      if (n && n === compact) return list[i];
    }
    return null;
  }

  /** Lead Best-col book for a side: { book, price, code } or null. */
  function bestSideLeadBook(gameEl, sideIdx, codes, names) {
    const meta = bestSideMeta(gameEl, sideIdx);
    if (!meta || !meta.book) return null;
    return {
      book: meta.book,
      price: meta.price,
      code: resolveBookCode(meta.book, codes, names),
    };
  }

  /**
   * TDR lean: fav | dog | null.
   * Hard thresholds (old Vertex path), then soft: fade the sharper side
   * (lower rank → lean the other side).
   */
  function tdrLeanFromSides(favTdr, dogTdr) {
    const dogRank = dogTdr && dogTdr.rank ? dogTdr.rank : null;
    const favRank = favTdr && favTdr.rank ? favTdr.rank : null;
    const dogSharp = dogRank != null && dogRank <= 4;
    const favGe5 = favRank != null && favRank >= 5;
    const favLe5 = favRank != null && favRank <= 5;
    const favGe11 = favRank != null && favRank >= 11;
    if (dogSharp && favGe5) return 'fav';
    if (favLe5 && !dogSharp) return 'dog';
    if (favGe11) return 'fav';
    // Soft: lean away from the sharper TDR so every book can vote
    if (favRank != null && dogRank != null) {
      if (dogRank < favRank) return 'fav';
      if (favRank < dogRank) return 'dog';
    } else if (dogRank != null && favRank == null) {
      return dogRank <= 4 ? 'fav' : 'dog';
    } else if (favRank != null && dogRank == null) {
      return favRank <= 5 ? 'dog' : 'fav';
    }
    return null;
  }

  function flipLean(lean) {
    if (lean === 'fav') return 'dog';
    if (lean === 'dog') return 'fav';
    return null;
  }

  function applyFollowFade(lean, follow) {
    if (!lean) return null;
    return follow ? lean : flipLean(lean);
  }

  function bestColVoteWeight(rankIndex, n) {
    if (n <= 1) return 1;
    return 0.5 + 0.5 * (1 - rankIndex / (n - 1));
  }

  function blBookDisplayName(standings, code, fallback) {
    if (standings && standings.nameByCode && standings.nameByCode[code]) {
      return standings.nameByCode[code];
    }
    return fallback || code || '?';
  }

  /**
   * My Line Take from Book League + Best column (every game gets a suggestion):
   * 1) Best BL book TDRs → follow lean
   * 2) Worst BL book TDRs → fade lean
   * 3–4) Best-col: top-half BL books FADE their Best side; bottom-half FOLLOW
   *    (trusted book Best on dog → lean FAV; soft book Best on dog → lean DOG)
   * agree% = winning side's share of vote weight (not a win probability).
   * Neon green = FAV, neon orange = DOG.
   */
  function applyCircaTakeToMyLine(gameEl, codes, bookCells, nOut, favIdx) {
    restoreCircaTakeOnGame(gameEl);
    const fairCell = tradFairCell(gameEl);
    if (!fairCell) return;
    if (favIdx == null) return;

    const teams = tradTeamNames(gameEl);
    if (teams.length < 2) return;

    const homeIdx = nOut >= 3 ? 2 : 1;
    const dogIdx = favIdx === 0 ? homeIdx : 0;
    const names = tradBookHeaderNames();
    const sportKey = takeSportKeyForGame(gameEl);
    const standings = aggregateBookLeagueStandings(sportKey);
    const votes = [];

    function pushVote(src, lean, weight, detail) {
      if (!lean || !(weight > 0)) return;
      votes.push({ src: src, lean: lean, weight: weight, detail: detail || '' });
    }

    if (standings) {
      // 1) Best BL book — follow TDR lean
      const bestCell = bookCellByCode(codes, bookCells, standings.bestCode, null);
      if (bestCell) {
        const lean = tdrLeanFromSides(pxSideTdr(bestCell, favIdx), pxSideTdr(bestCell, dogIdx));
        const vote = applyFollowFade(lean, true);
        const nm = blBookDisplayName(standings, standings.bestCode);
        const favL = pxSideTdr(bestCell, favIdx);
        const dogL = pxSideTdr(bestCell, dogIdx);
        pushVote(
          'bl-best',
          vote,
          1,
          'BL best ' +
            nm +
            ' follow ' +
            (lean || '?') +
            (dogL && dogL.label ? ' dog ' + dogL.label : '') +
            (favL && favL.label ? ' (fav ' + favL.label + ')' : '')
        );
      }

      // 2) Worst BL book — fade TDR lean
      const worstCell = bookCellByCode(codes, bookCells, standings.worstCode, null);
      if (worstCell && standings.worstCode !== standings.bestCode) {
        const lean = tdrLeanFromSides(pxSideTdr(worstCell, favIdx), pxSideTdr(worstCell, dogIdx));
        const vote = applyFollowFade(lean, false);
        const nm = blBookDisplayName(standings, standings.worstCode);
        const favL = pxSideTdr(worstCell, favIdx);
        const dogL = pxSideTdr(worstCell, dogIdx);
        pushVote(
          'bl-worst',
          vote,
          1,
          'BL worst ' +
            nm +
            ' fade ' +
            (lean || '?') +
            (favL && favL.label ? ' fav ' + favL.label : '') +
            (dogL && dogL.label ? ' (dog ' + dogL.label + ')' : '')
        );
      }
    }

    // 3–4) Best-col: top-half FADE Best side; bottom-half FOLLOW (unranked → fade)
    const bestFav = bestSideLeadBook(gameEl, favIdx, codes, names);
    const bestDog = bestSideLeadBook(gameEl, dogIdx, codes, names);
    const sameBestBook =
      bestFav &&
      bestDog &&
      bestFav.code &&
      bestDog.code &&
      bestFav.code === bestDog.code;

    function addBestColVote(sideRole, lead) {
      if (!lead || sameBestBook) return;
      const code = lead.code || null;
      // Default fade Best (same spirit as old Vertex Best-col)
      let follow = false;
      let w = 0.75;
      let rankLabel = 'unranked';
      if (standings && code && standings.rankIndexByCode[code] != null) {
        const idx = standings.rankIndexByCode[code];
        const n = standings.n;
        const bottomHalf = idx >= n / 2;
        follow = bottomHalf; // top books fade Best; bottom books follow Best
        w = bestColVoteWeight(idx, n);
        rankLabel = 'rank ' + (idx + 1);
      }
      const rawLean = sideRole;
      const vote = applyFollowFade(rawLean, follow);
      const nm =
        (standings && code && blBookDisplayName(standings, code, lead.book)) ||
        lead.book ||
        code ||
        '?';
      pushVote(
        'best-col-' + sideRole,
        vote,
        w,
        'Best ' + nm + ' (' + rankLabel + ') ' + (follow ? 'follow' : 'fade') + ' ' + rawLean
      );
    }

    addBestColVote('fav', bestFav);
    addBestColVote('dog', bestDog);

    // Fallback: fade Best-col so every priced game still gets a Take
    if (!votes.length) {
      if (bestDog && !(bestFav && bestDog.book === bestFav.book)) {
        pushVote('fallback-best-dog', 'fav', 1, 'Fallback fade Best on dog (' + bestDog.book + ')');
      }
      if (bestFav && !(bestDog && bestFav.book === bestDog.book)) {
        pushVote('fallback-best-fav', 'dog', 1, 'Fallback fade Best on fav (' + bestFav.book + ')');
      }
    }

    // Last resort: soft TDR from Pinnacle / first book with both sides
    if (!votes.length) {
      const pinCell =
        pinnacleBookCell(gameEl, codes, bookCells) ||
        (bookCells && bookCells[0]) ||
        null;
      if (pinCell) {
        const lean = tdrLeanFromSides(pxSideTdr(pinCell, favIdx), pxSideTdr(pinCell, dogIdx));
        if (lean) pushVote('fallback-tdr', lean, 1, 'Fallback board TDR → ' + lean);
      }
    }

    // Absolute last resort: Take FAV
    if (!votes.length) {
      pushVote('fallback-default', 'fav', 1, 'Fallback default FAV');
    }

    let favW = 0;
    let dogW = 0;
    for (let i = 0; i < votes.length; i++) {
      if (votes[i].lean === 'fav') favW += votes[i].weight;
      else if (votes[i].lean === 'dog') dogW += votes[i].weight;
    }
    const total = favW + dogW;
    if (!(total > 0)) return;

    let role;
    let agreePct;
    if (favW === dogW) {
      role = 'fav';
      agreePct = 50;
    } else {
      role = favW > dogW ? 'fav' : 'dog';
      // Winning side's share of vote weight (clearer than margin)
      const winW = role === 'fav' ? favW : dogW;
      agreePct = Math.round((100 * winW) / total);
    }
    if (agreePct < TAKE_MIN_CONFIDENCE) return;

    const takeSideIdx = role === 'fav' ? favIdx : dogIdx;
    const takeTeamIdx = outcomeToTeamIndex(takeSideIdx, nOut);
    if (takeTeamIdx == null) return;
    const takeFull = teams[takeTeamIdx];
    const takeShort = teamCallSign(takeFull);
    if (!takeShort) return;

    const whyParts = votes.map((v) => v.detail).filter(Boolean);
    const roleLabel = role === 'fav' ? 'FAV' : 'DOG';
    const takeLabel = takeFull || takeShort;
    const agreeLabel = 'agree ' + agreePct + '%';
    const splitNote =
      'votes fav ' +
      Math.round(favW * 100) / 100 +
      ' / dog ' +
      Math.round(dogW * 100) / 100;

    if (fairCell.dataset.pcFairTitle == null) {
      fairCell.dataset.pcFairTitle = fairCell.getAttribute('title') || '';
    }
    fairCell.classList.add('pc-circa-take');
    let msg = fairCell.querySelector(':scope > .pc-circa-take-msg');
    if (!msg) {
      msg = document.createElement('span');
      fairCell.appendChild(msg);
    }
    msg.className = 'pc-circa-take-msg role-' + (role === 'fav' ? 'fav' : 'dog');
    msg.textContent = 'Take ' + takeLabel + ' ' + roleLabel + ' · ' + agreeLabel;
    fairCell.title =
      whyParts.join(' · ') +
      ' → Take ' +
      takeLabel +
      ' ' +
      roleLabel +
      ' · ' +
      agreeLabel +
      ' (' +
      splitNote +
      ')';
  }

  /** Map outcome index → team row index (away=0, home=1). */
  function outcomeToTeamIndex(sideIdx, nOut) {
    if (sideIdx == null) return null;
    if (nOut >= 3) return sideIdx === 0 ? 0 : sideIdx === 2 ? 1 : null;
    return sideIdx;
  }

  /**
   * Open (cOpen / Pinny open) → current Pinny.
   * Spread: only the number counts (juice-only = no badge).
   * Moneyline (no numbers): fav implied % up/down.
   * Returns 'fav' | 'dog' | null.
   */
  function otcFavorsRole(openAms, curAms, openLines, curLines, favIdx) {
    if (favIdx == null) return null;
    const oL = openLines && openLines[favIdx];
    const cL = curLines && curLines[favIdx];
    if (oL != null && cL != null) {
      if (Math.abs(cL - oL) < 1e-9) return null; // same number — ignore juice
      if (cL < oL) return 'fav'; // fav handicap got heavier
      return 'dog';
    }
    // No spread number (ML): use fav implied %
    const oP = toProb(openAms && openAms[favIdx]);
    const cP = toProb(curAms && curAms[favIdx]);
    if (oP == null || cP == null) return null;
    if (cP > oP + 1e-6) return 'fav';
    if (cP < oP - 1e-6) return 'dog';
    return null;
  }

  /** American ¢ from even so −110 → −150 ≈ 40¢ shortening. */
  function americanCentsFromEven(a) {
    if (!Number.isFinite(a)) return null;
    if (a >= 100) return a - 100;
    if (a <= -100) return a + 100;
    return a;
  }

  /**
   * Pinny open → current move vs fav/dog for Take picks steam-boost sort.
   * againstDog / againstFav are positive magnitudes (pts or ¢).
   */
  function readOtcMove(gameEl) {
    const empty = { favors: null, againstDog: 0, againstFav: 0, label: '' };
    if (!gameEl) return empty;
    const codes = tradBookHeaderCodes();
    if (!codes.length) return empty;
    const bookCells = Array.from(gameEl.querySelectorAll(':scope > .cell.cBook'));
    const openCell =
      gameEl.querySelector(':scope > .cell.cOpen') || gameEl.querySelector('.cell.cOpen');
    const pinCell = pinnacleBookCell(gameEl, codes, bookCells);
    if (!openCell || openCell.classList.contains('none') || !pinCell) return empty;
    const favIdx = tradFavSideIndex(gameEl);
    if (favIdx == null) return empty;
    const openAms = tradCellSidePrices(openCell);
    const curAms = tradCellSidePrices(pinCell);
    const openLines = tradCellSideLines(openCell);
    const curLines = tradCellSideLines(pinCell);
    const favors = otcFavorsRole(openAms, curAms, openLines, curLines, favIdx);
    if (favors !== 'fav' && favors !== 'dog') return empty;

    const oL = openLines && openLines[favIdx];
    const cL = curLines && curLines[favIdx];
    let againstDog = 0;
    let againstFav = 0;
    let label = '';
    if (oL != null && cL != null && Math.abs(cL - oL) >= 1e-9) {
      const d = oL - cL; // + => fav heavier => against dog
      const mag = Math.abs(d);
      const bit = (mag % 1 ? mag.toFixed(1) : String(mag)) + 'pt';
      if (d > 0) {
        againstDog = mag;
        label = bit + ' vs dog';
      } else {
        againstFav = mag;
        label = bit + ' vs fav';
      }
    } else {
      const oAm = openAms && openAms[favIdx];
      const cAm = curAms && curAms[favIdx];
      const oc = americanCentsFromEven(oAm);
      const cc = americanCentsFromEven(cAm);
      const oP = toProb(oAm);
      const cP = toProb(cAm);
      let mag = 0;
      if (oc != null && cc != null) mag = Math.abs(cc - oc);
      else if (oP != null && cP != null) mag = Math.abs(cP - oP) * 100;
      if (mag > 0 && oP != null && cP != null && Math.abs(cP - oP) > 1e-6) {
        const bit = Math.round(mag) + '¢';
        if (cP > oP) {
          againstDog = mag;
          label = bit + ' vs dog';
        } else {
          againstFav = mag;
          label = bit + ' vs fav';
        }
      }
    }
    return { favors: favors, againstDog: againstDog, againstFav: againstFav, label: label };
  }

  /**
   * Green O->C left of fav team name when open→current favors fav;
   * orange O->C left of dog when it favors dog. Nothing if no move.
   * Spread: fav line heavier/lighter. Moneyline: fav implied % up/down.
   */
  function markOtcTeamHighlights(gameEl, codes, bookCells, favIdx, dogIdx, nOut) {
    if (favIdx == null || dogIdx == null) return;
    const openCell = gameEl.querySelector(':scope > .cell.cOpen');
    const pinCell = pinnacleBookCell(gameEl, codes, bookCells);
    if (!openCell || openCell.classList.contains('none') || !pinCell) return;

    const openAms = tradCellSidePrices(openCell);
    const curAms = tradCellSidePrices(pinCell);
    const openLines = tradCellSideLines(openCell);
    const curLines = tradCellSideLines(pinCell);
    const role = otcFavorsRole(openAms, curAms, openLines, curLines, favIdx);
    if (role !== 'fav' && role !== 'dog') return;

    const teams = gameEl.querySelectorAll(
      ':scope > .cGame .teams .team, :scope > .cGame .team'
    );
    if (teams.length < 2) return;
    const sideIdx = role === 'fav' ? favIdx : dogIdx;
    const teamIdx = outcomeToTeamIndex(sideIdx, nOut);
    if (teamIdx == null || !teams[teamIdx]) return;

    const teamEl = teams[teamIdx];
    const name = teamEl.querySelector('a.tName, .tName');

    teamEl.classList.add(role === 'fav' ? 'pc-otc-fav' : 'pc-otc-dog');
    const tip =
      (role === 'fav' ? 'O->C → FAV' : 'O->C → DOG') +
      ' · open ' +
      fmtAmShort(openAms[favIdx]) +
      '/' +
      fmtAmShort(openAms[dogIdx]) +
      ' → Pinny ' +
      fmtAmShort(curAms[favIdx]) +
      '/' +
      fmtAmShort(curAms[dogIdx]);

    if (name) {
      if (name.dataset.pcOtcTitle == null) {
        name.dataset.pcOtcTitle = name.getAttribute('title') || '';
      }
      name.title = tip;
    }

    // Left of team icon/logo (first meaningful child), not between icon and name
    const anchor =
      teamEl.querySelector(
        ':scope > img, :scope > .logo, :scope > .ico, :scope > .badge, :scope > i, :scope > svg'
      ) ||
      teamEl.firstElementChild;
    let badge = teamEl.querySelector(':scope > .pc-otc-badge');
    if (!badge) {
      badge = document.createElement('span');
      if (anchor && anchor.parentNode === teamEl) {
        teamEl.insertBefore(badge, anchor);
      } else {
        teamEl.insertBefore(badge, teamEl.firstChild);
      }
    } else if (anchor && badge !== anchor && badge.nextSibling !== anchor) {
      teamEl.insertBefore(badge, anchor);
    }
    badge.className = 'pc-otc-badge role-' + role;
    badge.textContent = 'O->C';
    badge.title = tip;
  }

  function markPriceRanksOnTradBoard() {
    const codes = tradBookHeaderCodes();
    if (!codes.length) return;

    tradBoardGames().forEach((gameEl) => {
      const nOut = tradOutcomeCount(gameEl);
      const favIdx = tradFavSideIndex(gameEl);
      const bookCells = Array.from(gameEl.querySelectorAll(':scope > .cell.cBook'));
      const n = Math.min(codes.length, bookCells.length);
      if (!n) return;

      if (favIdx == null) {
        applyCircaTakeToMyLine(gameEl, codes, bookCells, nOut, null);
        markVertexBestGlow(gameEl);
        return;
      }
      const homeIdx = nOut >= 3 ? 2 : 1;
      const dogIdx = favIdx === 0 ? homeIdx : 0;
      const drawIdx = nOut >= 3 ? 1 : -1;

      const favEntries = [];
      const dogEntries = [];
      const drawEntries = [];
      for (let i = 0; i < n; i++) {
        const cell = bookCells[i];
        const prices = tradCellSidePrices(cell);
        const lines = tradCellSideLines(cell);
        const els = tradCellSideEls(cell);
        if (prices[favIdx] != null && els[favIdx]) {
          favEntries.push({
            el: els[favIdx],
            price: prices[favIdx],
            line: lines[favIdx],
          });
        }
        if (prices[dogIdx] != null && els[dogIdx]) {
          dogEntries.push({
            el: els[dogIdx],
            price: prices[dogIdx],
            line: lines[dogIdx],
          });
        }
        if (drawIdx >= 0 && prices[drawIdx] != null && els[drawIdx]) {
          drawEntries.push({
            el: els[drawIdx],
            price: prices[drawIdx],
            line: lines[drawIdx],
          });
        }
      }

      const useImplied = tradGameBothSidesNegative(gameEl);
      const favRanks = competitionRankMap(favEntries, useImplied);
      const dogRanks = competitionRankMap(dogEntries, useImplied);
      const drawRanks = competitionRankMap(drawEntries, useImplied);
      favRanks.forEach((info, el) =>
        attachPriceRankBadge(el, info.rank, info.y, 'fav', info.joint)
      );
      dogRanks.forEach((info, el) =>
        attachPriceRankBadge(el, info.rank, info.y, 'dog', info.joint)
      );
      drawRanks.forEach((info, el) =>
        attachPriceRankBadge(el, info.rank, info.y, 'draw', info.joint)
      );

      markOtcTeamHighlights(gameEl, codes, bookCells, favIdx, dogIdx, nOut);
      // After TDR badges so Pin/LV vs Bovada fav gaps are visible
      applyCircaTakeToMyLine(gameEl, codes, bookCells, nOut, favIdx);
      markVertexBestGlow(gameEl);
    });
  }

  function tradMarketSeg() {
    return (
      document.querySelector('.seg[aria-label="Market"]') ||
      document.querySelector('[role="tablist"][aria-label="Market"]') ||
      document.querySelector('section.trad .seg[role="tablist"]') ||
      document.querySelector('.boardPane .seg[role="tablist"]')
    );
  }

  function boardSportKey() {
    const info = routeInfo();
    return [info.live ? 'live' : 'pre', info.sport || info.board || '', info.league || ''].join('|');
  }

  /** MLB / NHL → moneyline; all other sports → spread. */
  function defaultMarketLabel() {
    const info = routeInfo();
    const sport = String(info.sport || info.board || '').toLowerCase();
    const league = String(info.league || '').toUpperCase();
    if (league === 'MLB' || league === 'NHL') return 'Moneyline';
    if (sport === 'baseball' || sport === 'mlb') return 'Moneyline';
    if (sport === 'hockey' || sport === 'nhl' || sport === 'icehockey' || sport === 'ice-hockey') {
      return 'Moneyline';
    }
    return 'Spread';
  }

  function ensureDefaultMarket() {
    const key = boardSportKey();
    if (key !== lastMarketSportKey) {
      lastMarketSportKey = key;
      marketUserOverride = false;
    }
    if (marketUserOverride) return false;
    const seg = tradMarketSeg();
    if (!seg) return false;
    const want = defaultMarketLabel();
    const btns = Array.from(seg.querySelectorAll('button.segBtn, [role="tab"]'));
    if (!btns.length) return false;
    const wantLc = want.toLowerCase();
    const target = btns.find((b) => {
      const t = String(b.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      if (t === wantLc) return true;
      if (wantLc === 'spread' && /^(spread|handicap|puck line|run line)$/.test(t)) return true;
      if (wantLc === 'moneyline' && /^(moneyline|money line|ml|h2h)$/.test(t)) return true;
      return false;
    });
    if (!target) return false;
    const on = target.classList.contains('on') || target.getAttribute('aria-selected') === 'true';
    if (on) return false;
    const now = Date.now();
    if (now - lastMarketEnsureAt < 1200) return false;
    lastMarketEnsureAt = now;
    marketAutoClick = true;
    try {
      target.click();
    } finally {
      setTimeout(() => {
        marketAutoClick = false;
      }, 0);
    }
    return true;
  }

  /** Need Opener column for Pinny open → close. */
  function ensureOpenerOn() {
    const now = Date.now();
    if (now - lastFairEnsureAt < 1200) return false;
    const btns = document.querySelectorAll('button.fairBtn');
    let clicked = false;
    for (let i = 0; i < btns.length; i++) {
      const btn = btns[i];
      const label = String(btn.textContent || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!/\bopener\b/i.test(label)) continue;
      const on = btn.classList.contains('on') || btn.getAttribute('aria-pressed') === 'true';
      if (!on) {
        btn.click();
        clicked = true;
      }
      break;
    }
    if (clicked) lastFairEnsureAt = now;
    return clicked;
  }

  function tradBookHeaderNames() {
    return tradBookHeaderEls().map((el) => {
      const nameEl = el.querySelector('.hName');
      const t = nameEl
        ? String(nameEl.textContent || '')
            .replace(/\s+/g, ' ')
            .trim()
        : '';
      if (t) return t;
      const img = el.querySelector('img.logo, img');
      const alt = img ? String(img.getAttribute('alt') || '').trim() : '';
      return alt || String(el.getAttribute('data-code') || '').toUpperCase();
    });
  }

  function activeMarketLabel() {
    const seg = tradMarketSeg();
    if (!seg) return '';
    const on =
      seg.querySelector('button.segBtn.on, [role="tab"][aria-selected="true"]') ||
      seg.querySelector('button.segBtn, [role="tab"]');
    return String((on && on.textContent) || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function gameTeamNames(gameEl) {
    const teams = gameEl.querySelectorAll(
      ':scope > .cGame .teams .team, :scope > .cGame .team'
    );
    const out = [];
    for (let i = 0; i < teams.length && out.length < 2; i++) {
      const t = tradTeamLabel(teams[i]);
      if (t) out.push(t);
    }
    return out;
  }

  function gameLeagueLabel(gameEl) {
    const lg = gameEl.querySelector(':scope > .cGame .lg, :scope > .cGame .when .lg');
    return String((lg && lg.textContent) || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function gameDayHeaderEl(gameEl) {
    if (!gameEl) return null;
    const parent = gameEl.parentElement;
    if (parent) {
      const kids = Array.from(parent.children);
      const idx = kids.indexOf(gameEl);
      for (let i = idx - 1; i >= 0; i--) {
        if (kids[i].classList && kids[i].classList.contains('gDay')) return kids[i];
      }
    }
    let n = gameEl.previousElementSibling;
    while (n) {
      if (n.classList && n.classList.contains('gDay')) return n;
      n = n.previousElementSibling;
    }
    return null;
  }

  /**
   * 4C builds day headers as <b>Today</b>Mon 12 Oct<em>2 games</em>.
   * textContent glues that to "TodayMon 12 Oct2 games", which breaks \btoday\b and \bOct\b.
   * Walk text nodes and join with spaces instead.
   */
  function gameDayHeaderText(dayEl) {
    if (!dayEl) return '';
    const parts = [];
    const walk = (n) => {
      if (!n) return;
      if (n.nodeType === 3) {
        const t = String(n.textContent || '')
          .replace(/\s+/g, ' ')
          .trim();
        if (t) parts.push(t);
        return;
      }
      if (n.nodeType === 1) {
        for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
      }
    };
    walk(dayEl);
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  function gameIdFromEl(gameEl) {
    if (!gameEl) return '';
    return (
      String(gameEl.getAttribute('data-game') || '').trim() ||
      String(gameEl.id || '')
        .replace(/^g-/, '')
        .trim()
    );
  }

  /** Local kickoff ms from .gDay header + clock, or "now" if live/scored. */
  function parseGameStartMs(gameEl) {
    if (!gameEl) return null;
    if (gameEl.querySelector(':scope > .cGame .score, :scope > .cGame b.score')) {
      return Date.now() - 60000;
    }
    const tEl = gameEl.querySelector(
      ':scope > .cGame .tStar .t, :scope > .cGame .when .t, :scope > .cGame span.t'
    );
    const timeText = String((tEl && tEl.textContent) || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (/final|live|otp|ot\b|q\d|half|inning|top|bot/i.test(timeText)) {
      return Date.now() - 60000;
    }
    const tm = timeText.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
    if (!tm) return null;
    let hour = parseInt(tm[1], 10);
    const min = parseInt(tm[2], 10);
    const ap = (tm[3] || '').toLowerCase();
    if (ap === 'pm' && hour < 12) hour += 12;
    if (ap === 'am' && hour === 12) hour = 0;

    const now = new Date();
    let y = now.getFullYear();
    let mo = now.getMonth();
    let da = now.getDate();
    const dayEl = gameDayHeaderEl(gameEl);
    const dayText = gameDayHeaderText(dayEl);
    let dayResolved = false;
    if (/\btoday\b/i.test(dayText)) {
      dayResolved = true;
    } else if (/\btomorrow\b/i.test(dayText)) {
      const tmr = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      y = tmr.getFullYear();
      mo = tmr.getMonth();
      da = tmr.getDate();
      dayResolved = true;
    } else if (/\byesterday\b/i.test(dayText)) {
      const yest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      y = yest.getFullYear();
      mo = yest.getMonth();
      da = yest.getDate();
      dayResolved = true;
    } else {
      const dm = dayText.match(
        /\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i
      );
      if (dm) {
        const months = {
          jan: 0,
          feb: 1,
          mar: 2,
          apr: 3,
          may: 4,
          jun: 5,
          jul: 6,
          aug: 7,
          sep: 8,
          oct: 9,
          nov: 10,
          dec: 11,
        };
        mo = months[dm[2].slice(0, 3).toLowerCase()];
        da = parseInt(dm[1], 10);
        const cand = new Date(y, mo, da, hour, min, 0, 0);
        if (cand.getTime() < now.getTime() - 40 * 86400000) y += 1;
        dayResolved = true;
      }
    }
    // Never assume "today" when the day header is missing — that was pulling in day+ NFL.
    if (!dayResolved) return null;
    return new Date(y, mo, da, hour, min, 0, 0).getTime();
  }

  function isGameStartWithinLeagueWindow(gameEl) {
    const startMs = parseGameStartMs(gameEl);
    if (startMs == null) return false;
    const now = Date.now();
    if (startMs > now + BOOK_LEAGUE_MAX_START_AHEAD_MS) return false;
    // Hard cap: never snap games 2+ calendar days out (stops day+ NFL boards).
    const start = new Date(startMs);
    const today = new Date();
    const startDay = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
    const todayDay = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
    const dayDiff = (startDay - todayDay) / 86400000;
    if (dayDiff >= 2) return false;
    return true;
  }

  function pxBookLabel(el) {
    if (!el) return '';
    const img = el.querySelector('img.logo, img');
    const alt = img ? String(img.getAttribute('alt') || '').trim() : '';
    if (alt) return alt;
    const aria = String(el.getAttribute('aria-label') || '');
    const m = aria.match(/^([^,]+?)\s+[+-]\d{2,4}/);
    return m ? m[1].trim() : '';
  }

  function bestSideMeta(gameEl, sideIdx) {
    const best = gameEl.querySelector(':scope > .cell.cBest');
    if (!best || best.classList.contains('none')) return null;
    const prices = tradCellSidePrices(best);
    const els = tradCellSideEls(best);
    const price = prices[sideIdx];
    const el = els[sideIdx];
    if (price == null || !el || el.disabled || el.classList.contains('none')) return null;
    return { book: pxBookLabel(el), price: price };
  }

  function hourBucket(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return Math.floor(Date.now() / 3600000);
    return Math.floor(n / 3600000);
  }

  function gameMarketKey(s) {
    return [s && s.id ? s.id : '', s && s.market ? s.market : ''].join('|');
  }

  function snapStoreKey(s) {
    return [
      s && s.id ? s.id : '',
      s && s.market ? s.market : '',
      Number(s && s.at) || 0,
    ].join('|');
  }

  function latestSnapAtForGameMarket(snaps, s) {
    const k = gameMarketKey(s);
    let latest = 0;
    (snaps || []).forEach((x) => {
      if (!x || gameMarketKey(x) !== k) return;
      const t = Number(x.at) || 0;
      if (t > latest) latest = t;
    });
    return latest;
  }

  function isBoardSnapDue(boardSnap, snaps) {
    if (!boardSnap || !boardSnap.id) return false;
    const latest = latestSnapAtForGameMarket(snaps, boardSnap);
    if (!latest) return true;
    const now = Number(boardSnap.at) || Date.now();
    return now - latest >= BOOK_LEAGUE_GAP_MS;
  }

  /** Keep earliest snap per game/market, then only later snaps ≥1h after the previous kept. */
  function pruneRollingHourSnaps(snaps) {
    const groups = new Map();
    (snaps || []).forEach((s) => {
      if (!s || !s.id) return;
      const k = gameMarketKey(s);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(s);
    });
    const out = [];
    groups.forEach((list) => {
      list.sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
      let lastKept = -Infinity;
      for (let i = 0; i < list.length; i++) {
        const t = Number(list[i].at) || 0;
        if (t - lastKept >= BOOK_LEAGUE_GAP_MS) {
          out.push(list[i]);
          lastKept = t;
        }
      }
    });
    return out.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
  }

  /** Drop snaps for games starting more than 18h out (and drop board-visible far games). */
  function pruneFarStartSnaps(snaps) {
    const farIds = new Set();
    const nearIds = new Set();
    tradBoardGames().forEach((gameEl) => {
      const id = gameIdFromEl(gameEl);
      if (!id) return;
      if (isGameStartWithinLeagueWindow(gameEl)) nearIds.add(id);
      else farIds.add(id);
    });
    const horizon = Date.now() + BOOK_LEAGUE_MAX_START_AHEAD_MS;
    const now = Date.now();
    return (snaps || []).filter((s) => {
      if (!s || !s.id) return false;
      if (farIds.has(s.id)) return false;
      const startAt = Number(s.startAt);
      if (Number.isFinite(startAt)) {
        if (startAt > horizon) return false;
        const start = new Date(startAt);
        const today = new Date();
        const dayDiff =
          (Date.UTC(start.getFullYear(), start.getMonth(), start.getDate()) -
            Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) /
          86400000;
        if (dayDiff >= 2) return false;
      } else if (farIds.size && !nearIds.has(s.id)) {
        // Legacy snap with no startAt: drop if this id is currently a far board game.
        // (already handled by farIds above)
      }
      return true;
    });
  }

  function collectLeagueSnap(gameEl) {
    if (!gameEl) return null;
    const id = gameIdFromEl(gameEl);
    if (!id) return null;
    if (!isGameStartWithinLeagueWindow(gameEl)) return null;
    const startAt = parseGameStartMs(gameEl);

    const codes = tradBookHeaderCodes();
    const bookNames = tradBookHeaderNames();
    const bookCells = Array.from(gameEl.querySelectorAll(':scope > .cell.cBook'));
    const n = Math.min(codes.length, bookCells.length);
    if (!n) return null;

    const nOut = tradOutcomeCount(gameEl);
    const favIdx = tradFavSideIndex(gameEl);
    if (favIdx == null) return null;
    const homeIdx = nOut >= 3 ? 2 : 1;
    const dogIdx = favIdx === 0 ? homeIdx : 0;

    const favEntries = [];
    const dogEntries = [];
    const perBook = [];
    for (let i = 0; i < n; i++) {
      const cell = bookCells[i];
      const prices = tradCellSidePrices(cell);
      const lines = tradCellSideLines(cell);
      const code = codes[i];
      const favPrice = prices[favIdx];
      const dogPrice = prices[dogIdx];
      perBook.push({
        code: code,
        name: bookNames[i] || code,
        favPrice: favPrice,
        dogPrice: dogPrice,
        elFav: null,
        elDog: null,
      });
      const els = tradCellSideEls(cell);
      if (favPrice != null && els[favIdx]) {
        favEntries.push({
          el: els[favIdx],
          price: favPrice,
          line: lines[favIdx],
          i: i,
        });
        perBook[i].elFav = els[favIdx];
      }
      if (dogPrice != null && els[dogIdx]) {
        dogEntries.push({
          el: els[dogIdx],
          price: dogPrice,
          line: lines[dogIdx],
          i: i,
        });
        perBook[i].elDog = els[dogIdx];
      }
    }

    if (favEntries.length < BOOK_LEAGUE_MIN_Y) return null;

    const useImplied = tradGameBothSidesNegative(gameEl);
    const favRanks = competitionRankMap(favEntries, useImplied);
    const dogRanks = competitionRankMap(dogEntries, useImplied);
    const y = favEntries.length;

    const books = {};
    for (let i = 0; i < perBook.length; i++) {
      const b = perBook[i];
      if (b.favPrice == null && b.dogPrice == null) continue;
      const favInfo = b.elFav ? favRanks.get(b.elFav) : null;
      const dogInfo = b.elDog ? dogRanks.get(b.elDog) : null;
      books[b.code] = {
        name: b.name,
        favPrice: b.favPrice,
        favRank: favInfo ? favInfo.rank : null,
        favJoint: favInfo ? !!favInfo.joint : false,
        dogPrice: b.dogPrice,
        dogRank: dogInfo ? dogInfo.rank : null,
        dogJoint: dogInfo ? !!dogInfo.joint : false,
      };
    }

    const teams = gameTeamNames(gameEl);
    if (teams.length < 2) return null;
    const favTeamIdx = outcomeToTeamIndex(favIdx, nOut);
    const dogTeamIdx = outcomeToTeamIndex(dogIdx, nOut);
    if (favTeamIdx == null || dogTeamIdx == null) return null;

    const info = routeInfo();
    const bestFav = bestSideMeta(gameEl, favIdx);
    const bestDog = bestSideMeta(gameEl, dogIdx);
    if (!bestFav || !bestDog) return null;

    const openCell = gameEl.querySelector(':scope > .cell.cOpen');
    const openPrices =
      openCell && !openCell.classList.contains('none') ? tradCellSidePrices(openCell) : [];
    const openAway = openPrices[0] != null ? openPrices[0] : null;
    const openHome = openPrices[homeIdx] != null ? openPrices[homeIdx] : null;
    const openFav = openPrices[favIdx] != null ? openPrices[favIdx] : null;
    const openDog = openPrices[dogIdx] != null ? openPrices[dogIdx] : null;

    const fairCell = tradFairCell(gameEl);
    const bestCell = gameEl.querySelector(':scope > .cell.cBest');
    const awayLineNums = [];
    const homeLineNums = [];
    const lineCells = [fairCell, bestCell, openCell].concat(
      Array.from(gameEl.querySelectorAll(':scope > .cell.cBook'))
    );
    for (let li = 0; li < lineCells.length; li++) {
      const cell = lineCells[li];
      if (!cell || cell.classList.contains('none')) continue;
      const lines = tradCellSideLines(cell);
      if (lines[0] != null && Number.isFinite(lines[0])) awayLineNums.push(lines[0]);
      if (lines[homeIdx] != null && Number.isFinite(lines[homeIdx])) {
        homeLineNums.push(lines[homeIdx]);
      }
    }
    const awayLine = modeLine(awayLineNums);
    const homeLine = modeLine(homeLineNums);
    const spread = modeLine(favEntries.map((e) => e.line));

    const at = Date.now();
    return {
      id: id,
      at: at,
      startAt: startAt,
      hourBucket: hourBucket(at),
      sport: info.sport || info.board || '',
      league: gameLeagueLabel(gameEl) || info.league || '',
      market: activeMarketLabel() || defaultMarketLabel(),
      teams: teams.slice(0, 2),
      favSide: favIdx,
      dogSide: dogIdx,
      favTeam: teams[favTeamIdx],
      dogTeam: teams[dogTeamIdx],
      y: y,
      spread: spread,
      awayLine: awayLine,
      homeLine: homeLine,
      best: {
        fav: bestFav,
        dog: bestDog,
      },
      open: {
        away: openAway,
        home: openHome,
        fav: openFav,
        dog: openDog,
      },
      books: books,
      winnerTeamIdx: null,
      coverTeamIdx: null,
      gradeKind: null,
      favCovered: null,
      gradedAt: null,
      status: null,
      awayScore: null,
      homeScore: null,
    };
  }

  function collectLeagueSnapsFromBoard() {
    const out = [];
    tradBoardGames().forEach((gameEl) => {
      const snap = collectLeagueSnap(gameEl);
      if (snap) out.push(snap);
    });
    return out;
  }

  function setBookLeagueStatus(text, warn) {
    bookLeagueLastMsg = text || '';
    const wrap = document.getElementById(BOOK_LEAGUE_UI_ID);
    if (!wrap) return;
    wrap.classList.toggle('warn', !!warn);
    const meta = wrap.querySelector('.pc-bl-meta');
    if (meta) meta.textContent = bookLeagueLastMsg;
  }

  function ensureBookLeagueUi() {
    if (!IS_4C) return;
    let wrap = document.getElementById(BOOK_LEAGUE_UI_ID);
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = BOOK_LEAGUE_UI_ID;
      const title = document.createElement('div');
      title.className = 'pc-bl-title';
      title.textContent = 'Book League';
      const meta = document.createElement('div');
      meta.className = 'pc-bl-meta';
      meta.textContent = bookLeagueLastMsg || 'Waiting…';
      wrap.appendChild(title);
      wrap.appendChild(meta);
      (document.body || document.documentElement).appendChild(wrap);
    }
  }

  /** Sort key for tip time — prefer parseGameStartMs, else HH:MM from the board clock. */
  function tipSortMs(gameEl, timeText) {
    const ms = parseGameStartMs(gameEl);
    if (ms != null && Number.isFinite(ms)) return ms;
    const tm = String(timeText || '').match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
    if (!tm) return Number.POSITIVE_INFINITY;
    let hour = parseInt(tm[1], 10);
    const min = parseInt(tm[2], 10);
    const ap = (tm[3] || '').toLowerCase();
    if (ap === 'pm' && hour < 12) hour += 12;
    if (ap === 'am' && hour === 12) hour = 0;
    const d = new Date();
    d.setHours(hour, min, 0, 0);
    return d.getTime();
  }

  /** Short day label for the panel (Today / Tom / Wed) so later-day noon isn't confused with tonight. */
  function tipDayLabel(gameEl, tipMs) {
    const dayText = gameDayHeaderText(gameDayHeaderEl(gameEl));
    if (/\btoday\b/i.test(dayText)) return 'Today';
    if (/\btomorrow\b/i.test(dayText)) return 'Tom';
    const dow = dayText.match(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/i);
    if (dow) return dow[1].slice(0, 3);
    const md = dayText.match(
      /\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i
    );
    if (md) return md[1] + ' ' + md[2].slice(0, 3);
    if (tipMs != null && Number.isFinite(tipMs) && tipMs !== Number.POSITIVE_INFINITY) {
      const now = new Date();
      const d = new Date(tipMs);
      const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const startTip = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      const dayDiff = Math.round((startTip - startToday) / 86400000);
      if (dayDiff === 0) return 'Today';
      if (dayDiff === 1) return 'Tom';
      const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      return names[d.getDay()];
    }
    return '';
  }

  function zcodeLiveIsFresh() {
    const live = readZcodeLive(true);
    if (!live || !live.games || !live.games.length) return false;
    if (live.updatedAt && Date.now() - live.updatedAt > 15 * 60 * 1000) return false;
    return true;
  }

  /**
   * Take strength /10 from ESPN team record (win %):
   * League-wide for every sport (best win% in league → 10, worst → 1).
   * Not remapped against other Takes in the panel.
   */
  const STR_CACHE = Object.create(null);
  const STR_TTL_MS = 30 * 60 * 1000;
  const STR_INFLIGHT = Object.create(null);
  const STR_ESPN_PATH = {
    MLB: 'baseball/mlb',
    NHL: 'hockey/nhl',
    NFL: 'football/nfl',
    NCAAF: 'football/college-football',
    NBA: 'basketball/nba',
    WNBA: 'basketball/wnba',
    NCAAB: 'basketball/mens-college-basketball',
  };

  function gmGetText(url) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('GM_xmlhttpRequest unavailable'));
        return;
      }
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        timeout: 45000,
        onload: function (res) {
          if (res.status >= 200 && res.status < 300 && res.responseText != null) {
            resolve(String(res.responseText));
          } else {
            reject(new Error('HTTP ' + res.status));
          }
        },
        onerror: function () {
          reject(new Error('network'));
        },
        ontimeout: function () {
          reject(new Error('timeout'));
        },
      });
    });
  }

  function strengthOutOfTen(raw, leagueMin, leagueMax) {
    if (raw == null || !Number.isFinite(raw)) return null;
    const span = Math.max(1e-6, leagueMax - leagueMin);
    const t = Math.max(0, Math.min(1, (raw - leagueMin) / span));
    return Math.round((1 + t * 9) * 10) / 10;
  }

  function finalizeStrengthPack(entries, source) {
    const raws = entries.map((e) => e.raw).filter((n) => Number.isFinite(n));
    const leagueMin = raws.length ? Math.min.apply(null, raws) : 0;
    const leagueMax = raws.length ? Math.max.apply(null, raws) : 1;
    for (let i = 0; i < entries.length; i++) {
      entries[i].score = strengthOutOfTen(entries[i].raw, leagueMin, leagueMax);
    }
    return {
      at: Date.now(),
      source: source || '',
      leagueMin: leagueMin,
      leagueMax: leagueMax,
      entries: entries,
    };
  }

  function parseEspnStandingsWinPct(text) {
    let json;
    try {
      json = JSON.parse(text);
    } catch (_) {
      return finalizeStrengthPack([], 'espn-record');
    }
    const entries = [];
    const seen = Object.create(null);
    function walk(node) {
      if (!node) return;
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) walk(node[i]);
        return;
      }
      const standings = node.standings;
      const list = standings && standings.entries;
      if (Array.isArray(list)) {
        for (let i = 0; i < list.length; i++) {
          const e = list[i] || {};
          const team = e.team || {};
          const uid = String(team.uid || team.id || team.abbreviation || team.displayName || '');
          if (uid && seen[uid]) continue;
          const stats = e.stats || [];
          let winPct = null;
          let wins = null;
          let losses = null;
          let ties = null;
          // CFB/NCAAB often only expose overall as displayValue "5-1" (no winPercent)
          for (let s = 0; s < stats.length; s++) {
            const st = stats[s] || {};
            const name = String(st.name || '');
            if (name === 'overall' || name === 'Overall') {
              const dv = String(st.displayValue != null ? st.displayValue : st.value || '');
              const m = /^(\d+)\s*-\s*(\d+)(?:\s*-\s*(\d+))?/.exec(dv.trim());
              if (m) {
                wins = parseInt(m[1], 10);
                losses = parseInt(m[2], 10);
                ties = m[3] != null ? parseInt(m[3], 10) : 0;
                break; // first overall row only (ignore Home/Away splits)
              }
            }
          }
          for (let s = 0; s < stats.length; s++) {
            const st = stats[s] || {};
            const name = String(st.name || '');
            if (name === 'winPercent' && winPct == null) winPct = Number(st.value);
            if (name === 'wins' && wins == null) wins = Number(st.value);
            if (name === 'losses' && losses == null) losses = Number(st.value);
            if ((name === 'ties' || name === 'otLosses') && ties == null) {
              ties = Number(st.value);
            }
          }
          if (!Number.isFinite(winPct) && Number.isFinite(wins) && Number.isFinite(losses)) {
            const played = wins + losses + (Number.isFinite(ties) ? ties : 0);
            if (played > 0) winPct = wins / played;
          }
          if (!Number.isFinite(winPct)) continue;
          const names = [
            team.displayName,
            team.shortDisplayName,
            team.name,
            team.nickname,
            team.abbreviation,
          ]
            .map((x) => String(x || '').trim())
            .filter(Boolean);
          if (!names.length) continue;
          if (uid) seen[uid] = true;
          let record = '';
          if (Number.isFinite(wins) && Number.isFinite(losses)) {
            record =
              Math.round(wins) +
              '-' +
              Math.round(losses) +
              (Number.isFinite(ties) && ties > 0 ? '-' + Math.round(ties) : '');
          }
          entries.push({
            raw: winPct,
            names: names,
            record: record,
            wins: wins,
            losses: losses,
          });
        }
      }
      if (Array.isArray(node.children)) walk(node.children);
    }
    walk(json);
    return finalizeStrengthPack(entries, 'espn-record');
  }

  function strengthFetchUrl(sportKey) {
    const sk = String(sportKey || '').toUpperCase();
    const path = STR_ESPN_PATH[sk];
    if (!path) return null;
    return {
      kind: 'espn-standings',
      url: 'https://site.api.espn.com/apis/v2/sports/' + path + '/standings',
    };
  }

  async function fetchStrengthPack(sportKey) {
    const spec = strengthFetchUrl(sportKey);
    if (!spec) return finalizeStrengthPack([], 'none');
    const text = await gmGetText(spec.url);
    return parseEspnStandingsWinPct(text);
  }

  function ensureStrengthSport(sportKey) {
    const sk = String(sportKey || '').toUpperCase();
    if (!sk) return Promise.resolve(null);
    const cached = STR_CACHE[sk];
    if (
      cached &&
      cached.entries &&
      cached.entries.length &&
      Date.now() - cached.at < STR_TTL_MS
    ) {
      return Promise.resolve(cached);
    }
    if (STR_INFLIGHT[sk]) return STR_INFLIGHT[sk];
    STR_INFLIGHT[sk] = fetchStrengthPack(sk)
      .then((pack) => {
        STR_CACHE[sk] = pack;
        delete STR_INFLIGHT[sk];
        log('strength loaded', sk, (pack.entries && pack.entries.length) || 0);
        return pack;
      })
      .catch((err) => {
        delete STR_INFLIGHT[sk];
        log('strength fetch fail', sk, err && err.message);
        if (cached && cached.entries && cached.entries.length) return cached;
        const empty = finalizeStrengthPack([], 'error');
        STR_CACHE[sk] = empty;
        return empty;
      });
    return STR_INFLIGHT[sk];
  }

  /** Prefer exact / prefix match; never let "New Mexico" win via "New Mexico State". */
  function scoreStrengthNameMatch(want, cand) {
    if (!want || !cand) return 0;
    if (want === cand) return 100000 + cand.length;
    // X vs X State are different schools
    if (want + ' state' === cand || cand === want + ' state') return 0;
    if (cand.indexOf(want + ' state ') === 0 || cand === want + ' state') return 0;
    if (want.indexOf(cand + ' state ') === 0 || want === cand + ' state') return 0;
    if (cand.indexOf(want + ' ') === 0) return 50000 + want.length; // "arkansas state red wolves"
    if (want.indexOf(cand + ' ') === 0 && cand.length >= 4) return 20000 + cand.length;
    if (teamsMatch(want, cand)) return 10000 + Math.min(want.length, cand.length);
    return 0;
  }

  function lookupStrengthEntry(sportKey, teamName) {
    const sk = String(sportKey || '').toUpperCase();
    const pack = STR_CACHE[sk];
    if (!pack || !pack.entries || !pack.entries.length) return null;
    const want = normTeam(canonTeam(teamName, sk) || teamName);
    if (!want) return null;
    let best = null;
    let bestScore = 0;
    for (let i = 0; i < pack.entries.length; i++) {
      const e = pack.entries[i];
      const names = e.names || [];
      for (let n = 0; n < names.length; n++) {
        const cand = normTeam(names[n]);
        const score = scoreStrengthNameMatch(want, cand);
        if (score > bestScore) {
          bestScore = score;
          best = e;
        }
      }
    }
    return best;
  }

  function fmtStrScore(n) {
    if (n == null || !Number.isFinite(n)) return '—';
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
  }

  function strTierClass(n) {
    if (n == null || !Number.isFinite(n)) return 'na';
    if (n >= 7.5) return 'hi';
    if (n >= 5) return 'mid';
    return 'lo';
  }

  function attachStrengthToRecs(recs) {
    const rows = []
      .concat((recs && recs.favs) || [])
      .concat((recs && recs.dogs) || []);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const sk = r.sportKey;
      const pack = STR_CACHE[String(sk || '').toUpperCase()];
      const hit = lookupStrengthEntry(sk, r.team);
      r.strRaw = hit && Number.isFinite(hit.raw) ? hit.raw : null;
      r.strRecord = hit && hit.record ? hit.record : '';
      r.strScore = null;
      if (r.strRaw == null) continue;
      // Always league-wide: worst record in the league → ~1/10, best → 10/10
      r.strScore =
        pack && Number.isFinite(pack.leagueMin) && Number.isFinite(pack.leagueMax)
          ? strengthOutOfTen(r.strRaw, pack.leagueMin, pack.leagueMax)
          : hit && Number.isFinite(hit.score)
            ? hit.score
            : null;
    }
  }

  async function ensureStrengthForRecs(recs) {
    const sports = {};
    const rows = []
      .concat((recs && recs.favs) || [])
      .concat((recs && recs.dogs) || []);
    for (let i = 0; i < rows.length; i++) {
      const sk = rows[i].sportKey;
      if (sk) sports[sk] = true;
    }
    const keys = Object.keys(sports);
    if (!keys.length) return;
    await Promise.all(keys.map((k) => ensureStrengthSport(k)));
    attachStrengthToRecs(recs);
  }

  /**
   * Score how well a Take label matches one board side.
   * Avoids "Washington" ⊂ "Washington State" / "Arkansas" ⊂ "Arkansas State"
   * first-hit bugs from naive includes().
   */
  function scoreTakeNameMatch(takeN, boardN) {
    if (!takeN || !boardN) return 0;
    if (takeN === boardN) return 10000 + boardN.length;
    // Explicitly different schools (also mirrored in teamsMatch)
    if (takeN + ' state' === boardN || boardN + ' state' === takeN) return 0;
    if (teamsMatch(takeN, boardN)) return 5000 + Math.min(takeN.length, boardN.length);
    return 0;
  }

  /** Other side of the game for a Take team label. */
  function pickTakeOpponent(takeTeam, names, sportKey) {
    if (!names || names.length < 2) return '';
    const takeN = normTeam(canonTeam(takeTeam, sportKey) || takeTeam);
    let bestIdx = -1;
    let bestScore = 0;
    for (let i = 0; i < names.length; i++) {
      const boardN = normTeam(canonTeam(names[i], sportKey) || names[i]);
      const score = scoreTakeNameMatch(takeN, boardN);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) {
      if (String(names[0] || '') === String(takeTeam || '')) return names[1] || '';
      if (String(names[1] || '') === String(takeTeam || '')) return names[0] || '';
      return names[0] || '';
    }
    const opp = names[bestIdx === 0 ? 1 : 0] || '';
    const oppN = normTeam(canonTeam(opp, sportKey) || opp);
    // Never render "Take X vs X"
    if (opp && takeN && (oppN === takeN || String(opp) === String(takeTeam || ''))) {
      const other = names[bestIdx] || '';
      if (other && other !== takeTeam && normTeam(canonTeam(other, sportKey) || other) !== takeN) {
        return other;
      }
      return '';
    }
    return opp;
  }

  /**
   * Take FAV + fav ZCode ratio < 1 · Take DOG + fav ratio ≥ 2.
   * If ZCode isn't syncing (common on mobile), still list Takes without the ratio gate.
   * When steamBoost: same list, sorted by how far O→C is from favoring the take
   * (most adverse steam first; O→C with the take sinks).
   */
  function collectTakeRatioRecs(opts) {
    const steamBoost = !!(opts && opts.steamBoost);
    const favs = [];
    const dogs = [];
    const requireRatio = zcodeLiveIsFresh();
    const games = tradBoardGames();
    for (let gi = 0; gi < games.length; gi++) {
      const gameEl = games[gi];
      const fair = tradFairCell(gameEl);
      const msg = fair && fair.querySelector('.pc-circa-take-msg');
      if (!msg) continue;
      const role = msg.classList.contains('role-fav')
        ? 'fav'
        : msg.classList.contains('role-dog')
          ? 'dog'
          : null;
      if (!role) continue;
      const favChip = gameEl.querySelector(
        ':scope > .cGame .team .pc-zcode-ratio.role-fav, .pc-zcode-ratio.role-fav'
      );
      let ratio = null;
      if (favChip) {
        ratio = parseFloat(String(favChip.textContent || '').replace(/[^\d.]/g, ''));
        if (!Number.isFinite(ratio) || ratio <= 0) ratio = null;
      }
      if (requireRatio) {
        if (ratio == null) continue;
        if (role === 'fav' && !(ratio < 1)) continue;
        if (role === 'dog' && !(ratio >= 2)) continue;
      }
      const otc = readOtcMove(gameEl);
      // + = O→C moved against the take (boost); − = O→C favored the take (sink)
      const againstTake =
        role === 'dog'
          ? (otc.againstDog || 0) - (otc.againstFav || 0)
          : (otc.againstFav || 0) - (otc.againstDog || 0);
      const txt = String(msg.textContent || '');
      const takeM = /^Take\s+(.+?)\s+(FAV|DOG)\b/i.exec(txt);
      const agreeM = /agree\s+(\d+)\s*%/i.exec(txt);
      const team = takeM ? takeM[1].trim() : '';
      if (!team) continue;
      const agree = agreeM ? parseInt(agreeM[1], 10) : null;
      const gameId = String(gameEl.getAttribute('data-game') || gameEl.id || '');
      const tEl = gameEl.querySelector(
        ':scope > .cGame .tStar .t, :scope > .cGame .when .t, :scope > .cGame span.t, .cGame .t'
      );
      const time = String((tEl && tEl.textContent) || '')
        .replace(/\s+/g, ' ')
        .trim();
      const tipMs = tipSortMs(gameEl, time);
      const day = tipDayLabel(gameEl, tipMs);
      const names = tradTeamNames(gameEl);
      const opponent = pickTakeOpponent(team, names, takeSportKeyForGame(gameEl));
      const row = {
        team: team,
        opponent: opponent,
        ratio: ratio,
        agree: agree,
        gameId: gameId,
        gameEl: gameEl,
        time: time,
        day: day,
        tipMs: tipMs,
        boardIdx: gi,
        otcFavors: otc.favors,
        againstDog: otc.againstDog || 0,
        againstFav: otc.againstFav || 0,
        againstTake: againstTake,
        otcLabel: otc.label || '',
        sportKey: takeSportKeyForGame(gameEl),
        strRaw: null,
        strScore: null,
      };
      if (role === 'fav') favs.push(row);
      else if (role === 'dog') dogs.push(row);
    }
    const byTip = (a, b) =>
      a.tipMs - b.tipMs ||
      a.boardIdx - b.boardIdx ||
      (a.ratio != null && b.ratio != null ? a.ratio - b.ratio : 0);
    if (steamBoost) {
      const bySteam = (a, b) => b.againstTake - a.againstTake || byTip(a, b);
      dogs.sort(bySteam);
      favs.sort(bySteam);
    } else {
      favs.sort(byTip);
      dogs.sort(byTip);
    }
    return {
      favs: favs,
      dogs: dogs,
      requireRatio: requireRatio,
      steamBoost: steamBoost,
    };
  }

  function flashTakeRecGame(gameEl) {
    if (!gameEl) return;
    try {
      gameEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (_) {
      try {
        gameEl.scrollIntoView(true);
      } catch (__) {}
    }
    gameEl.classList.add('pc-tr-flash');
    setTimeout(() => {
      try {
        gameEl.classList.remove('pc-tr-flash');
      } catch (_) {}
    }, 1600);
  }

  function isMobileishUi() {
    try {
      return !!(
        window.matchMedia &&
        window.matchMedia('(max-width: 900px), (pointer: coarse)').matches
      );
    } catch (_) {
      return Math.min(window.innerWidth || 0, window.innerHeight || 0) < 900;
    }
  }

  function setTakeRecCollapsed(wrap, collapsed) {
    if (!wrap) return;
    wrap.classList.toggle('pc-tr-collapsed', !!collapsed);
    const tog = wrap.querySelector('.pc-tr-tog');
    if (tog) tog.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    try {
      sessionStorage.setItem('pcTakeRecCollapsed', collapsed ? '1' : '0');
    } catch (_) {}
  }

  function ensureTakeRecUi() {
    if (!IS_4C) return null;
    let wrap = document.getElementById(TAKE_REC_UI_ID);
    if (wrap) return wrap;
    wrap = document.createElement('div');
    wrap.id = TAKE_REC_UI_ID;
    wrap.setAttribute('role', 'complementary');
    wrap.setAttribute('aria-label', 'Take recommendations');
    const head = document.createElement('div');
    head.className = 'pc-tr-head';
    const headText = document.createElement('div');
    headText.className = 'pc-tr-head-text';
    const title = document.createElement('div');
    title.className = 'pc-tr-title';
    title.textContent = 'Take picks';
    const sub = document.createElement('div');
    sub.className = 'pc-tr-sub';
    sub.textContent = 'Take ∩ ZCode';
    headText.appendChild(title);
    headText.appendChild(sub);
    const zcodeBtn = document.createElement('button');
    zcodeBtn.type = 'button';
    zcodeBtn.className = 'pc-tr-zcode-btn pc-tr-zcode-head';
    zcodeBtn.textContent = 'Open Zcode';
    zcodeBtn.title = 'Open ZCode Line Reversals for sport(s) on this board';
    zcodeBtn.setAttribute('aria-label', 'Open Zcode');
    zcodeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openNeededZcodeTabs();
    });
    const tog = document.createElement('button');
    tog.type = 'button';
    tog.className = 'pc-tr-tog';
    tog.setAttribute('aria-label', 'Collapse or expand take picks');
    tog.textContent = '▾';
    head.appendChild(headText);
    head.appendChild(zcodeBtn);
    head.appendChild(tog);
    wrap.appendChild(head);
    const body = document.createElement('div');
    body.className = 'pc-tr-body';
    wrap.appendChild(body);
    const toggle = (e) => {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      setTakeRecCollapsed(wrap, !wrap.classList.contains('pc-tr-collapsed'));
    };
    tog.addEventListener('click', toggle);
    head.addEventListener('click', (e) => {
      if (
        e.target &&
        e.target.closest &&
        e.target.closest('.pc-tr-tog, .pc-tr-zcode-btn')
      ) {
        return;
      }
      if (wrap.classList.contains('pc-tr-collapsed') || isMobileishUi()) toggle(e);
    });
    wrap.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest && e.target.closest('.pc-tr-row[data-game]');
      if (!btn) return;
      const id = btn.getAttribute('data-game');
      if (!id) return;
      const gameEl =
        document.querySelector('.gRow.gGame[data-game="' + CSS.escape(id) + '"]') ||
        document.querySelector('.gRow.gGame[data-game="' + id + '"]') ||
        document.getElementById(id) ||
        document.getElementById('g-' + id);
      flashTakeRecGame(gameEl);
    });
    let preferCollapsed = isMobileishUi();
    try {
      const saved = sessionStorage.getItem('pcTakeRecCollapsed');
      if (saved === '0') preferCollapsed = false;
      if (saved === '1') preferCollapsed = true;
    } catch (_) {}
    setTakeRecCollapsed(wrap, preferCollapsed);
    (document.body || document.documentElement).appendChild(wrap);
    return wrap;
  }

  function renderTakeRecSection(parent, label, role, rows, emptyText, showOtc) {
    const sec = document.createElement('div');
    sec.className = 'pc-tr-sec';
    const lbl = document.createElement('div');
    lbl.className = 'pc-tr-lbl role-' + role;
    lbl.textContent = label;
    sec.appendChild(lbl);
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'pc-tr-empty';
      empty.textContent = emptyText;
      sec.appendChild(empty);
    } else {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pc-tr-row role-' + role;
        if (r.gameId) btn.setAttribute('data-game', r.gameId);
        const whenLabel = [r.day, r.time].filter(Boolean).join(' ') || '—';
        const strLabel = fmtStrScore(r.strScore);
        const recBit = r.strRecord ? ' · ' + r.strRecord : '';
        btn.title =
          whenLabel +
          ' · record ' +
          strLabel +
          '/10' +
          recBit +
          ' · Take ' +
          r.team +
          (r.opponent ? ' vs ' + r.opponent : '') +
          ' ' +
          (role === 'fav' ? 'FAV' : 'DOG') +
          (r.ratio != null ? ' · fav ratio ' + fmtRatioChip(r.ratio) : '') +
          (r.otcLabel ? ' · O→C ' + r.otcLabel : '') +
          (r.agree != null ? ' · agree ' + r.agree + '%' : '');
        const whenWrap = document.createElement('span');
        whenWrap.className = 'pc-tr-when';
        if (r.day) {
          const dayEl = document.createElement('span');
          dayEl.className = 'pc-tr-day';
          dayEl.textContent = r.day;
          whenWrap.appendChild(dayEl);
        }
        const timeEl = document.createElement('span');
        timeEl.className = 'pc-tr-time';
        timeEl.textContent = r.time || '—';
        whenWrap.appendChild(timeEl);
        const strEl = document.createElement('span');
        strEl.className = 'pc-tr-str ' + strTierClass(r.strScore);
        strEl.title =
          'Record /10 vs whole league' +
          (r.strRecord ? ' · ' + r.strRecord : '');
        const strNum = document.createElement('span');
        strNum.className = 'pc-tr-str-num';
        strNum.textContent = strLabel;
        const strDen = document.createElement('span');
        strDen.className = 'pc-tr-str-den';
        strDen.textContent = '/10';
        strEl.appendChild(strNum);
        strEl.appendChild(strDen);
        const teamsWrap = document.createElement('span');
        teamsWrap.className = 'pc-tr-teams';
        const pick = document.createElement('span');
        pick.className = 'pc-tr-pick';
        const takeWord = document.createElement('span');
        takeWord.className = 'pc-tr-take';
        takeWord.textContent = 'Take';
        const team = document.createElement('span');
        team.className = 'pc-tr-team';
        team.textContent = r.team;
        pick.appendChild(takeWord);
        pick.appendChild(team);
        teamsWrap.appendChild(pick);
        if (r.opponent) {
          const opp = document.createElement('span');
          opp.className = 'pc-tr-opp';
          opp.textContent = 'vs ' + r.opponent;
          teamsWrap.appendChild(opp);
        }
        btn.appendChild(whenWrap);
        btn.appendChild(strEl);
        btn.appendChild(teamsWrap);
        if (showOtc && r.otcLabel) {
          const move = document.createElement('span');
          const vsTake = (r.againstTake || 0) > 0;
          const withTake = (r.againstTake || 0) < 0;
          move.className =
            'pc-tr-move' + (vsTake ? ' vs' : withTake ? ' with' : '');
          move.textContent = r.otcLabel;
          move.title = vsTake
            ? 'Pinny O→C moved against this take (boost)'
            : withTake
              ? 'Pinny O→C favored this take (lower boost)'
              : 'Pinny open → close';
          btn.appendChild(move);
        }
        if (r.ratio != null) {
          const ratio = document.createElement('span');
          const tier = role === 'fav' ? 'lo' : r.ratio >= 5 ? 'hi' : 'mid';
          ratio.className = 'pc-tr-ratio ' + tier;
          ratio.textContent = fmtRatioChip(r.ratio);
          btn.appendChild(ratio);
        }
        if (r.agree != null) {
          const ag = document.createElement('span');
          ag.className = 'pc-tr-agree';
          ag.textContent = r.agree + '%';
          btn.appendChild(ag);
        }
        sec.appendChild(btn);
      }
    }
    parent.appendChild(sec);
  }

  function paintTakeRecBody(body, recs) {
    const next = document.createDocumentFragment();
    const tools = document.createElement('div');
    tools.className = 'pc-tr-tools';
    const sports = boardZcodeSportsNeeded();
    const zcodeBtn = document.createElement('button');
    zcodeBtn.type = 'button';
    zcodeBtn.className = 'pc-tr-zcode-btn';
    zcodeBtn.textContent = sports.length
      ? 'Open Zcode · ' + sports.join('+')
      : 'Open Zcode';
    zcodeBtn.title =
      'Open ZCode for ' + (sports.length ? sports.join(' + ') : 'this board');
    zcodeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openNeededZcodeTabs();
    });
    tools.appendChild(zcodeBtn);
    const boostBtn = document.createElement('button');
    boostBtn.type = 'button';
    boostBtn.className =
      'pc-tr-against-btn' + (takeRecSteamBoost ? ' on' : '');
    boostBtn.textContent = takeRecSteamBoost
      ? '✓ O→C steam boost'
      : 'O→C steam boost';
    boostBtn.title =
      'Keep the same Take picks. Sort by how far Pinny open→close is from favoring your take: most adverse steam first, O→C with the take sinks.';
    boostBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      takeRecSteamBoost = !takeRecSteamBoost;
      try {
        GM_setValue(TAKE_REC_AGAINST_KEY, takeRecSteamBoost);
      } catch (_) {}
      refreshTakeRecPanel();
    });
    tools.appendChild(boostBtn);
    next.appendChild(tools);

    const favLabel = recs.requireRatio
      ? recs.steamBoost
        ? 'Take fav · ratio < 1 · O→C boost'
        : 'Take fav · ratio < 1'
      : recs.steamBoost
        ? 'Take fav · O→C boost'
        : 'Take fav';
    const dogLabel = recs.requireRatio
      ? recs.steamBoost
        ? 'Take dog · fav ≥ 2 · O→C boost'
        : 'Take dog · fav ratio ≥ 2'
      : recs.steamBoost
        ? 'Take dog · O→C boost'
        : 'Take dog';
    const emptyTxt = 'None right now';
    // Dogs first when steam-boosting (adverse dog steam is the main use case)
    if (recs.steamBoost) {
      renderTakeRecSection(next, dogLabel, 'dog', recs.dogs, emptyTxt, true);
      renderTakeRecSection(next, favLabel, 'fav', recs.favs, emptyTxt, true);
    } else {
      renderTakeRecSection(next, favLabel, 'fav', recs.favs, emptyTxt, false);
      renderTakeRecSection(next, dogLabel, 'dog', recs.dogs, emptyTxt, false);
    }
    body.textContent = '';
    body.appendChild(next);
  }

  let takeRecStrengthGen = 0;
  function refreshTakeRecPanel() {
    if (!IS_4C) return;
    const wrap = ensureTakeRecUi();
    if (!wrap) return;
    const body = wrap.querySelector('.pc-tr-body');
    if (!body) return;
    const recs = collectTakeRatioRecs({ steamBoost: takeRecSteamBoost });
    attachStrengthToRecs(recs);
    const n = (recs.favs.length || 0) + (recs.dogs.length || 0);
    const title = wrap.querySelector('.pc-tr-title');
    const sub = wrap.querySelector('.pc-tr-sub');
    if (title) title.textContent = n ? 'Take picks · ' + n : 'Take picks';
    if (sub) {
      if (recs.steamBoost) {
        sub.textContent = recs.requireRatio
          ? 'O→C steam boost · farthest from favorable first'
          : 'O→C steam boost · open ZCode for ratios';
      } else {
        sub.textContent = recs.requireRatio
          ? 'Take ∩ ZCode · record /10'
          : 'Takes · record /10';
      }
    }
    const headZ = wrap.querySelector('.pc-tr-zcode-head');
    if (headZ) {
      const sports = boardZcodeSportsNeeded();
      headZ.textContent = 'Open Zcode';
      headZ.title =
        'Open ZCode for ' + (sports.length ? sports.join(' + ') : 'this board');
    }
    paintTakeRecBody(body, recs);
    const gen = ++takeRecStrengthGen;
    ensureStrengthForRecs(recs).then(() => {
      if (gen !== takeRecStrengthGen) return;
      if (!document.getElementById(TAKE_REC_UI_ID)) return;
      paintTakeRecBody(body, recs);
    });
  }

  function getGithubConfig() {
    let token = String(GM_getValue(GH_TOKEN_KEY, '') || '').trim();
    let repo = String(GM_getValue(GH_REPO_KEY, '') || '').trim();
    let branch = String(GM_getValue(GH_BRANCH_KEY, '') || '').trim();
    if (!token) {
      try {
        const raw = localStorage.getItem('pinnyFadeGithubConfig');
        if (raw) {
          const j = JSON.parse(raw);
          if (j && j.token) {
            token = String(j.token || '').trim();
            if (!repo && j.repo) repo = String(j.repo || '').trim();
            if (!branch && j.branch) branch = String(j.branch || '').trim();
            if (token) GM_setValue(GH_TOKEN_KEY, token);
          }
        }
      } catch (_) {}
    }
    if (!repo) repo = DEFAULT_GH_REPO;
    repo = repo
      .replace(/^https?:\/\/github\.com\//i, '')
      .replace(/\.git$/i, '')
      .replace(/\/$/, '');
    if (!branch) branch = 'main';
    try {
      if (repo && !String(GM_getValue(GH_REPO_KEY, '') || '').trim()) GM_setValue(GH_REPO_KEY, repo);
      if (branch && !String(GM_getValue(GH_BRANCH_KEY, '') || '').trim()) GM_setValue(GH_BRANCH_KEY, 'main');
    } catch (_) {}
    return { token: token, repo: repo, branch: branch };
  }

  function promptGithubToken() {
    const cur = getGithubConfig().token || '';
    const next = window.prompt('Book League GitHub PAT (optional override):', cur);
    if (next == null) return cur;
    const token = String(next).trim();
    GM_setValue(GH_TOKEN_KEY, token);
    GM_setValue(GH_REPO_KEY, DEFAULT_GH_REPO);
    GM_setValue(GH_BRANCH_KEY, 'main');
    setBookLeagueStatus(token ? 'Token saved — syncing…' : 'No token', !token);
    if (token) scheduleBookLeagueSync(100);
    return token;
  }

  function ensureGithubToken() {
    return getGithubConfig().token || '';
  }

  function readLocalBookLeague() {
    try {
      const raw = GM_getValue(BOOK_LEAGUE_LOCAL_KEY, null);
      if (!raw) return { updatedAt: null, snaps: [] };
      if (typeof raw === 'string') return parseBookLeagueFile(raw);
      if (raw && typeof raw === 'object') {
        return {
          updatedAt: raw.updatedAt || null,
          snaps: Array.isArray(raw.snaps) ? raw.snaps : [],
        };
      }
    } catch (_) {}
    return { updatedAt: null, snaps: [] };
  }

  function saveLocalBookLeague(payload) {
    const next = {
      updatedAt: (payload && payload.updatedAt) || new Date().toISOString(),
      snaps: Array.isArray(payload && payload.snaps) ? payload.snaps : [],
      source: 'local',
    };
    try {
      GM_setValue(BOOK_LEAGUE_LOCAL_KEY, next);
    } catch (_) {}
    return next;
  }

  function downloadBookLeagueDataFile(payload) {
    const src = payload || readLocalBookLeague() || { updatedAt: null, snaps: [] };
    const body = encodeBookLeagueFile({
      updatedAt: src.updatedAt || null,
      snaps: Array.isArray(src.snaps) ? src.snaps : [],
    });
    const blob = new Blob([body], { type: 'application/javascript;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'book-league-data.js';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      try {
        a.remove();
        URL.revokeObjectURL(url);
      } catch (_) {}
    }, 0);
  }

  function publishBookLeagueToPage(payload) {
    if (!IS_BOOK_LEAGUE_PAGE || !payload) return;
    try {
      const data = {
        updatedAt: payload.updatedAt || null,
        snaps: Array.isArray(payload.snaps) ? payload.snaps.slice() : [],
        source: payload.source || 'local',
      };
      window.__BOOK_LEAGUE_DATA__ = data;
      window.dispatchEvent(new CustomEvent('4c-book-league-data', { detail: data }));
    } catch (_) {}
  }

  function utf8ToBase64(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }

  function base64ToUtf8(b64) {
    return decodeURIComponent(escape(atob(b64)));
  }

  function gmRequest(opts) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('GM_xmlhttpRequest unavailable — reinstall script'));
        return;
      }
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

  function encodeBookLeagueFile(payload) {
    // Compact JSON — pretty-print blew past GitHub Contents API ~1MB limit.
    return (
      'window.__BOOK_LEAGUE_DATA__ = ' +
      JSON.stringify({
        updatedAt: (payload && payload.updatedAt) || null,
        snaps: Array.isArray(payload && payload.snaps) ? payload.snaps : [],
      }) +
      ';\n'
    );
  }

  function parseBookLeagueFile(raw) {
    const text = String(raw || '').trim();
    if (!text) return { updatedAt: null, snaps: [] };
    let jsonText = text;
    const m = text.match(/window\.__BOOK_LEAGUE_DATA__\s*=\s*([\s\S]*?);?\s*$/);
    if (m) jsonText = m[1];
    try {
      const parsed = JSON.parse(jsonText);
      if (parsed && Array.isArray(parsed.snaps)) return parsed;
      if (Array.isArray(parsed)) return { updatedAt: null, snaps: parsed };
    } catch (_) {}
    return { updatedAt: null, snaps: [] };
  }

  function leagueSnapSignature(snaps) {
    return (snaps || [])
      .map((s) => {
        if (!s || !s.id) return '';
        const cover =
          s.coverTeamIdx != null && s.coverTeamIdx !== '' ? String(s.coverTeamIdx) : '';
        const outright =
          s.winnerTeamIdx != null && s.winnerTeamIdx !== '' ? String(s.winnerTeamIdx) : '';
        const line = s.spread != null ? String(s.spread) : '';
        return snapStoreKey(s) + '#' + cover + '/' + outright + '/' + line;
      })
      .filter(Boolean)
      .sort()
      .join('\n');
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function acquireBookLeagueLock() {
    const now = Date.now();
    const id = now + '-' + Math.random().toString(36).slice(2, 9);
    try {
      const raw = localStorage.getItem(BOOK_LEAGUE_LOCK_KEY);
      if (raw) {
        const prev = JSON.parse(raw);
        if (prev && prev.until > now && prev.id) return null;
      }
      localStorage.setItem(
        BOOK_LEAGUE_LOCK_KEY,
        JSON.stringify({ id: id, until: now + BOOK_LEAGUE_LOCK_MS })
      );
      const check = JSON.parse(localStorage.getItem(BOOK_LEAGUE_LOCK_KEY) || '{}');
      if (check.id !== id) return null;
      return id;
    } catch (_) {
      return id;
    }
  }

  function touchBookLeagueLock(id) {
    if (!id) return;
    try {
      const raw = localStorage.getItem(BOOK_LEAGUE_LOCK_KEY);
      const lock = raw ? JSON.parse(raw) : null;
      if (!lock || lock.id !== id) return;
      lock.until = Date.now() + BOOK_LEAGUE_LOCK_MS;
      localStorage.setItem(BOOK_LEAGUE_LOCK_KEY, JSON.stringify(lock));
    } catch (_) {}
  }

  function releaseBookLeagueLock(id) {
    if (!id) return;
    try {
      const raw = localStorage.getItem(BOOK_LEAGUE_LOCK_KEY);
      const lock = raw ? JSON.parse(raw) : null;
      if (lock && lock.id === id) localStorage.removeItem(BOOK_LEAGUE_LOCK_KEY);
    } catch (_) {}
  }

  async function githubApiJson(method, pathWithQuery, data) {
    const { token, repo } = getGithubConfig();
    if (!token) throw new Error('No GitHub token');
    const res = await gmRequest({
      method: method,
      url: 'https://api.github.com/repos/' + repo + pathWithQuery,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      data: data != null ? JSON.stringify(data) : undefined,
      timeout: 120000,
    });
    if (res.status < 200 || res.status >= 300) {
      const err = new Error(
        'GitHub ' + method + ' ' + res.status + ': ' + String(res.responseText || '').slice(0, 200)
      );
      err.status = res.status;
      throw err;
    }
    if (!res.responseText) return null;
    try {
      return JSON.parse(res.responseText);
    } catch (_) {
      return null;
    }
  }

  async function githubGetBookLeague() {
    const { token, repo, branch } = getGithubConfig();
    if (!token) throw new Error('No GitHub token');
    const url =
      'https://api.github.com/repos/' +
      repo +
      '/contents/' +
      BOOK_LEAGUE_PATH +
      '?ref=' +
      encodeURIComponent(branch);
    const res = await gmRequest({
      method: 'GET',
      url: url,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + token,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      timeout: 120000,
    });
    if (res.status === 404) return { sha: null, payload: { updatedAt: null, snaps: [] } };
    if (res.status < 200 || res.status >= 300) {
      throw new Error('GitHub GET ' + res.status + ': ' + String(res.responseText || '').slice(0, 160));
    }
    const body = JSON.parse(res.responseText);
    let raw = '';
    // Contents API omits/truncates content for files ≳1MB — fall back to download_url / git blob.
    if (body.content && body.encoding === 'base64') {
      raw = base64ToUtf8(String(body.content).replace(/\n/g, ''));
    }
    if (!raw && body.download_url) {
      const dl = await gmRequest({
        method: 'GET',
        url: body.download_url,
        headers: {
          Accept: 'application/vnd.github.raw',
          Authorization: 'Bearer ' + token,
        },
        timeout: 120000,
      });
      if (dl.status >= 200 && dl.status < 300) raw = String(dl.responseText || '');
    }
    if (!raw && body.sha) {
      const blobRes = await gmRequest({
        method: 'GET',
        url: 'https://api.github.com/repos/' + repo + '/git/blobs/' + body.sha,
        headers: {
          Accept: 'application/vnd.github.raw',
          Authorization: 'Bearer ' + token,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        timeout: 120000,
      });
      if (blobRes.status >= 200 && blobRes.status < 300) raw = String(blobRes.responseText || '');
    }
    return { sha: body.sha || null, payload: parseBookLeagueFile(raw) };
  }

  async function githubPutBookLeague(payload, _sha, message) {
    // Git Data API (blob→tree→commit→ref) — Contents API rejects files ≳1MB.
    const { branch } = getGithubConfig();
    const text = encodeBookLeagueFile(payload);
    const ref = await githubApiJson('GET', '/git/ref/heads/' + encodeURIComponent(branch));
    const parentSha = ref && ref.object && ref.object.sha;
    if (!parentSha) throw new Error('No tip for branch ' + branch);
    const parentCommit = await githubApiJson('GET', '/git/commits/' + parentSha);
    const baseTree = parentCommit && parentCommit.tree && parentCommit.tree.sha;
    if (!baseTree) throw new Error('No base tree');
    const blob = await githubApiJson('POST', '/git/blobs', {
      content: text,
      encoding: 'utf-8',
    });
    if (!blob || !blob.sha) throw new Error('Blob create failed');
    const tree = await githubApiJson('POST', '/git/trees', {
      base_tree: baseTree,
      tree: [
        {
          path: BOOK_LEAGUE_PATH,
          mode: '100644',
          type: 'blob',
          sha: blob.sha,
        },
      ],
    });
    if (!tree || !tree.sha) throw new Error('Tree create failed');
    const commit = await githubApiJson('POST', '/git/commits', {
      message: message || 'book-league: sync',
      tree: tree.sha,
      parents: [parentSha],
    });
    if (!commit || !commit.sha) throw new Error('Commit create failed');
    try {
      await githubApiJson('PATCH', '/git/refs/heads/' + encodeURIComponent(branch), {
        sha: commit.sha,
      });
    } catch (e) {
      // Non-fast-forward when another tab/push moved main mid-flight.
      if (e && (e.status === 409 || e.status === 422)) {
        e.code = 'GH_CONFLICT';
        e.message = 'GitHub ref conflict (another sync won the race)';
      }
      throw e;
    }
    return { content: { sha: blob.sha }, commit: commit };
  }

  function mergeLeagueSnaps(existing, incoming) {
    const byKey = new Map();
    (existing || []).forEach((s) => {
      if (s && s.id) byKey.set(snapStoreKey(s), s);
    });
    (incoming || []).forEach((s) => {
      if (!s || !s.id) return;
      const k = snapStoreKey(s);
      const prev = byKey.get(k);
      if (!prev) {
        byKey.set(k, s);
        return;
      }
      const prevGraded = blSnapIsGraded(prev);
      const nextGraded = blSnapIsGraded(s);
      if (prevGraded && !nextGraded) {
        byKey.set(
          k,
          Object.assign({}, s, {
            winnerTeamIdx: prev.winnerTeamIdx,
            coverTeamIdx: prev.coverTeamIdx,
            gradeKind: prev.gradeKind,
            favCovered: prev.favCovered,
            gradedAt: prev.gradedAt,
            awayScore: prev.awayScore,
            homeScore: prev.homeScore,
            status: prev.status || s.status,
            open: s.open || prev.open,
            spread: s.spread != null ? s.spread : prev.spread,
            awayLine: s.awayLine != null ? s.awayLine : prev.awayLine,
            homeLine: s.homeLine != null ? s.homeLine : prev.homeLine,
          })
        );
        return;
      }
      if (nextGraded || (Number(s.at) || 0) >= (Number(prev.at) || 0)) {
        if (!nextGraded && prev) {
          // Keep prior line if a newer ungraded board snap omitted it.
          if (s.spread == null && prev.spread != null) s.spread = prev.spread;
          if (s.awayLine == null && prev.awayLine != null) s.awayLine = prev.awayLine;
          if (s.homeLine == null && prev.homeLine != null) s.homeLine = prev.homeLine;
        }
        byKey.set(k, s);
      }
    });
    return pruneRollingHourSnaps(Array.from(byKey.values()));
  }

  function sportKeyFromSnap(s) {
    const league = String((s && s.league) || '').toUpperCase();
    const sport = String((s && s.sport) || '').toLowerCase();
    if (/MLB|SERIES/i.test(league) || sport === 'baseball' || sport === 'mlb') return 'MLB';
    if (/NHL/i.test(league) || sport === 'hockey' || sport === 'nhl') return 'NHL';
    // League-specific BEFORE generic sport: /football/ncaaf stores sport="football"
    if (/NCAAF|CFB/i.test(league) || sport === 'ncaaf') return 'NCAAF';
    if (/NCAAB|CBB/i.test(league) || sport === 'ncaab') return 'NCAAB';
    if (/WNBA/i.test(league) || sport === 'wnba') return 'WNBA';
    if (/NFL/i.test(league) || sport === 'football' || sport === 'nfl') return 'NFL';
    // \bNBA\b so "NBA Cup" / "NBA IST" count as NBA (WNBA already returned above)
    if (/\bNBA\b/i.test(league) || sport === 'basketball' || sport === 'nba') return 'NBA';
    return null;
  }

  /** Hot / missing league: probe sports so finished games still grade. */
  function sportKeysToTry(s) {
    const k = sportKeyFromSnap(s);
    if (k) return [k];
    return ['NHL', 'MLB', 'NFL', 'NBA', 'NCAAF', 'NCAAB', 'WNBA'];
  }

  const ESPN_SPORT_PATH = {
    MLB: 'baseball/mlb',
    NHL: 'hockey/nhl',
    NFL: 'football/nfl',
    NCAAF: 'football/college-football',
    NBA: 'basketball/nba',
    WNBA: 'basketball/wnba',
    NCAAB: 'basketball/mens-college-basketball',
  };

  /** Board abbrevs that differ from ESPN (TBL↔TB, SJS↔SJ, …). */
  const BL_ABBR_ALIASES = {
    tbl: ['tb', 'tbl'],
    tb: ['tb', 'tbl'],
    njd: ['nj', 'njd'],
    nj: ['nj', 'njd'],
    sjs: ['sj', 'sjs'],
    sj: ['sj', 'sjs'],
    lak: ['la', 'lak'],
    la: ['la', 'lak'],
    wsh: ['wsh', 'was'],
    was: ['wsh', 'was'],
    mon: ['mtl', 'mon'],
    mtl: ['mtl', 'mon'],
    pho: ['ari', 'pho'],
    ari: ['ari', 'pho'],
    ath: ['ath', 'oak'],
    oak: ['oak', 'ath'],
    jax: ['jax', 'jac'],
    jac: ['jax', 'jac'],
    'app state': ['appalachian state', 'app state'],
    'appalachian state': ['appalachian state', 'app state'],
  };

  function ymdCompactEt(ts) {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return null;
    const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    return (
      et.getFullYear() +
      String(et.getMonth() + 1).padStart(2, '0') +
      String(et.getDate()).padStart(2, '0')
    );
  }

  function shiftYmdCompact(ymd, deltaDays) {
    if (!ymd || String(ymd).length !== 8) return null;
    const y = Number(String(ymd).slice(0, 4));
    const m = Number(String(ymd).slice(4, 6));
    const d = Number(String(ymd).slice(6, 8));
    const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
    if (isNaN(dt.getTime())) return null;
    return (
      dt.getUTCFullYear() +
      String(dt.getUTCMonth() + 1).padStart(2, '0') +
      String(dt.getUTCDate()).padStart(2, '0')
    );
  }

  /** Prefer game start date; also try snap day and ±1 for late boards. */
  function daysToTryForSnap(s) {
    const primary = ymdCompactEt(s.startAt != null ? s.startAt : s.at);
    const snapDay = ymdCompactEt(s.at);
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
      add(shiftYmdCompact(primary, -1));
      add(shiftYmdCompact(primary, 1));
    }
    return out;
  }

  function blTokens(s) {
    const n = canonTeam(s);
    if (!n) return [];
    const out = new Set([n]);
    const compact = n.replace(/\s+/g, '');
    if (compact) out.add(compact);
    const alias = BL_ABBR_ALIASES[compact] || BL_ABBR_ALIASES[n];
    if (alias) alias.forEach((tok) => out.add(tok));
    n.split(' ').filter(Boolean).forEach((tok) => {
      if (tok.length >= 3) out.add(tok);
    });
    return Array.from(out);
  }

  function blNameMatch(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    if (teamsMatch(a, b)) return true;
    const ta = blTokens(a);
    const tb = blTokens(b);
    for (let i = 0; i < ta.length; i++) {
      for (let j = 0; j < tb.length; j++) {
        if (ta[i] === tb[j] && ta[i].length >= 2) return true;
      }
    }
    if (a.length >= 5 && b.length >= 5 && (a.includes(b) || b.includes(a))) return true;
    return false;
  }

  function blSideMatch(snapSide, evCanon, evAbbr, evShort) {
    return (
      blNameMatch(snapSide, evCanon) ||
      blNameMatch(snapSide, evAbbr) ||
      blNameMatch(snapSide, evShort)
    );
  }

  async function fetchEspnScoreboard(sportKey, dateCompact) {
    const path = ESPN_SPORT_PATH[sportKey];
    if (!path || !dateCompact) return [];
    let url =
      'https://site.api.espn.com/apis/site/v2/sports/' + path + '/scoreboard?dates=' + dateCompact;
    if (sportKey === 'NCAAF') url += '&groups=80';
    if (sportKey === 'NCAAB') url += '&groups=50';
    const res = await gmRequest({ method: 'GET', url: url, timeout: 30000 });
    if (res.status < 200 || res.status >= 300) return [];
    let j;
    try {
      j = JSON.parse(res.responseText);
    } catch (_) {
      return [];
    }
    const out = [];
    (j.events || []).forEach((ev) => {
      const c = (ev.competitions || [])[0];
      if (!c) return;
      const st = c.status && c.status.type;
      const comps = c.competitors || [];
      const home = comps.find((x) => x.homeAway === 'home');
      const away = comps.find((x) => x.homeAway === 'away');
      if (!home || !away) return;
      const awayName = (away.team && (away.team.displayName || away.team.name)) || '';
      const homeName = (home.team && (home.team.displayName || home.team.name)) || '';
      const awayAbbr = (away.team && away.team.abbreviation) || '';
      const homeAbbr = (home.team && home.team.abbreviation) || '';
      const awayShort = (away.team && away.team.shortDisplayName) || '';
      const homeShort = (home.team && home.team.shortDisplayName) || '';
      const awayScore = Number(away.score);
      const homeScore = Number(home.score);
      out.push({
        completed: !!(st && st.completed),
        status: (st && (st.shortDetail || st.description || st.name)) || '',
        awayCanon: canonTeam(awayName),
        homeCanon: canonTeam(homeName),
        awayAbbr: canonTeam(awayAbbr),
        homeAbbr: canonTeam(homeAbbr),
        awayShort: canonTeam(awayShort),
        homeShort: canonTeam(homeShort),
        awayScore: Number.isFinite(awayScore) ? awayScore : null,
        homeScore: Number.isFinite(homeScore) ? homeScore : null,
      });
    });
    return out;
  }

  function matchEspnEventForSnap(s, events) {
    const teams = Array.isArray(s.teams) ? s.teams : [];
    if (teams.length < 2) return null;
    const a = canonTeam(teams[0]);
    const h = canonTeam(teams[1]);
    for (let j = 0; j < events.length; j++) {
      const e = events[j];
      if (
        blSideMatch(a, e.awayCanon, e.awayAbbr, e.awayShort) &&
        blSideMatch(h, e.homeCanon, e.homeAbbr, e.homeShort)
      ) {
        return { ev: e, orient: 'ah' };
      }
      if (
        blSideMatch(a, e.homeCanon, e.homeAbbr, e.homeShort) &&
        blSideMatch(h, e.awayCanon, e.awayAbbr, e.awayShort)
      ) {
        return { ev: e, orient: 'ha' };
      }
    }
    return null;
  }

  function isEspnPostponedStatus(status) {
    return /postpon|cancel|suspend|washout/i.test(String(status || ''));
  }

  async function gradeSnapsWithEspn(snaps) {
    const need = (snaps || []).filter((s) => {
      if (!s || blSnapIsGraded(s)) return false;
      if (
        s.awayScore != null &&
        s.homeScore != null &&
        !blIsMoneylineMarket(s) &&
        blSnapSpread(s) == null
      ) {
        return false;
      }
      return true;
    });
    if (!need.length) return 0;
    const cache = new Map();
    let graded = 0;
    const drop = new Set();
    for (let i = 0; i < need.length; i++) {
      const s = need[i];
      const sportKeys = sportKeysToTry(s);
      const days = daysToTryForSnap(s);
      if (!sportKeys.length || !days.length) continue;

      let hit = null;
      for (let si = 0; si < sportKeys.length && !hit; si++) {
        const sportKey = sportKeys[si];
        for (let di = 0; di < days.length && !hit; di++) {
          const day = days[di];
          const ck = sportKey + '|' + day;
          if (!cache.has(ck)) {
            try {
              cache.set(ck, await fetchEspnScoreboard(sportKey, day));
            } catch (_) {
              cache.set(ck, []);
            }
          }
          const matched = matchEspnEventForSnap(s, cache.get(ck) || []);
          if (matched) hit = matched;
        }
      }

      if (!hit) continue;
      const ev = hit.ev;
      if (!ev.completed) {
        if (isEspnPostponedStatus(ev.status)) {
          drop.add(s);
          continue;
        }
        if (ev.status) s.status = ev.status;
        continue;
      }
      if (ev.awayScore == null || ev.homeScore == null) continue;
      s.awayScore = ev.awayScore;
      s.homeScore = ev.homeScore;
      s.status = ev.status || 'Final';

      if (ev.awayScore === ev.homeScore) {
        s.winnerTeamIdx = 'void';
      } else {
        const awayWon = ev.awayScore > ev.homeScore;
        // orient ah: snap[0]=away; ha: snap[0]=home
        s.winnerTeamIdx = hit.orient === 'ah' ? (awayWon ? 0 : 1) : awayWon ? 1 : 0;
      }

      if (blApplyCoverGrade(s, ev.awayScore, ev.homeScore, hit.orient)) {
        s.gradedAt = Date.now();
        graded++;
      }
    }
    if (drop.size) {
      for (let i = snaps.length - 1; i >= 0; i--) {
        if (drop.has(snaps[i])) snaps.splice(i, 1);
      }
    }
    return graded;
  }

  async function syncBookLeagueNow(opts) {
    const forceGh = !!(opts && opts.forceGh);
    if ((!IS_4C && !IS_BOOK_LEAGUE_PAGE) || bookLeagueSyncing) return;
    if (IS_4C) {
      ensureStyle();
      ensureBookLeagueUi();
    }
    const lockId = acquireBookLeagueLock();
    if (!lockId) {
      setBookLeagueStatus('Waiting — another tab is syncing…');
      return;
    }
    bookLeagueLockId = lockId;
    const board = IS_4C ? collectLeagueSnapsFromBoard() : [];
    const token = ensureGithubToken();
    bookLeagueSyncing = true;
    try {
      setBookLeagueStatus(
        board.length
          ? 'Scanning board (' + board.length + ')…'
          : token
            ? forceGh
              ? 'Force push to GitHub…'
              : 'Checking local + GitHub…'
            : 'Checking local…'
      );

      let lastDue = 0;
      let lastGraded = 0;
      let lastTotal = 0;
      let wroteGh = false;
      let localOnly = !token;
      let lastRemoteCount = 0;

      for (let attempt = 0; attempt < 5; attempt++) {
        touchBookLeagueLock(lockId);
        if (attempt > 0) {
          await sleep(700 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 500));
          touchBookLeagueLock(lockId);
        }
        const local = readLocalBookLeague();
        let remote = { sha: null, payload: { updatedAt: null, snaps: [] } };
        if (token) {
          try {
            remote = await githubGetBookLeague();
            localOnly = false;
          } catch (e) {
            // Keep going locally if GitHub is down / token bad.
            localOnly = true;
            if (attempt === 0) {
              setBookLeagueStatus(
                'GitHub unavailable — local only (' + ((e && e.message) || 'error') + ')',
                true
              );
            }
          }
        }

        const remoteSnaps = (remote.payload && remote.payload.snaps) || [];
        lastRemoteCount = remoteSnaps.length;
        let snaps = mergeLeagueSnaps(local.snaps || [], remoteSnaps);
        // On Book League page, also fold in whatever the HTML file already loaded.
        if (IS_BOOK_LEAGUE_PAGE && window.__BOOK_LEAGUE_DATA__ && Array.isArray(window.__BOOK_LEAGUE_DATA__.snaps)) {
          snaps = mergeLeagueSnaps(snaps, window.__BOOK_LEAGUE_DATA__.snaps);
        }
        const beforePrune = snaps.length;
        snaps = pruneFarStartSnaps(snaps);
        snaps = pruneRollingHourSnaps(snaps);
        const pruned = beforePrune - snaps.length;

        const due = board.filter((s) => isBoardSnapDue(s, snaps));
        if (due.length) snaps = mergeLeagueSnaps(snaps, due);

        const beforeGrade = snaps.length;
        const graded = IS_4C || IS_BOOK_LEAGUE_PAGE ? await gradeSnapsWithEspn(snaps) : 0;
        touchBookLeagueLock(lockId);
        const droppedPost = beforeGrade - snaps.length;
        const payload = { updatedAt: new Date().toISOString(), snaps: snaps };
        lastDue = due.length;
        lastGraded = graded;
        lastTotal = snaps.length;

        saveLocalBookLeague(payload);
        publishBookLeagueToPage(Object.assign({}, payload, { source: wroteGh ? 'github' : 'local' }));

        const remoteDrift =
          leagueSnapSignature(snaps) !== leagueSnapSignature(remoteSnaps);
        const changed = !!due.length || !!graded || !!pruned || !!droppedPost || remoteDrift;
        // Always push when merged set differs from GitHub — local TM is not the source of truth.
        const needGhWrite =
          !localOnly &&
          token &&
          (forceGh ||
            !!due.length ||
            !!graded ||
            !!pruned ||
            !!droppedPost ||
            !remote.sha ||
            remoteDrift);

        if (!needGhWrite) {
          if (changed) {
            setBookLeagueStatus(
              'Local · +' +
                due.length +
                (graded ? ' · graded ' + graded : '') +
                ' · ' +
                snaps.length +
                ' total' +
                (token ? '' : ' (no GitHub token)')
            );
            log('Book League local sync', '+', due.length, 'total', snaps.length);
          } else {
            const where = token && !localOnly ? 'GitHub' : 'local';
            let msg = 'Up to date · ' + snaps.length + ' on ' + where;
            if (IS_4C && !board.length) {
              const games = tradBoardGames().length;
              if (games) {
                msg +=
                  ' · board ' +
                  games +
                  ' games, 0 eligible (need ≥' +
                  BOOK_LEAGUE_MIN_Y +
                  ' books priced, start <18h)';
              }
            }
            setBookLeagueStatus(msg);
          }
          wroteGh = false;
          break;
        }

        try {
          setBookLeagueStatus(
            due.length
              ? 'Pushing +' + due.length + ' to GitHub (' + snaps.length + ')…'
              : remoteDrift
                ? 'Catch-up push ' +
                  snaps.length +
                  (lastRemoteCount ? ' (was ' + lastRemoteCount + ' remote)' : '') +
                  '…'
                : 'Pushing to GitHub (' + snaps.length + ')…'
          );
          touchBookLeagueLock(lockId);
          await githubPutBookLeague(
            payload,
            remote.sha,
            'book-league: sync ' +
              snaps.length +
              ' (+' +
              due.length +
              (graded ? ', grade ' + graded : '') +
              (pruned ? ', prune ' + pruned : '') +
              (remoteDrift && !due.length ? ', catch-up' : '') +
              ')'
          );
          wroteGh = true;
          publishBookLeagueToPage(Object.assign({}, payload, { source: 'github' }));
          break;
        } catch (e) {
          if (e && e.code === 'GH_CONFLICT' && attempt < 4) {
            setBookLeagueStatus(
              'Retrying GitHub… (' + (attempt + 1) + '/4 · ref race)'
            );
            continue;
          }
          // Local already saved — surface GitHub failure without losing snaps.
          setBookLeagueStatus(
            'Saved local · GitHub failed (' + ((e && e.message) || 'error') + ') · ' + snaps.length,
            true
          );
          wroteGh = false;
          break;
        }
      }

      if (wroteGh) {
        setBookLeagueStatus(
          'GitHub · +' +
            lastDue +
            (lastGraded ? ' · graded ' + lastGraded : '') +
            ' · ' +
            lastTotal +
            ' total' +
            (lastRemoteCount && lastRemoteCount !== lastTotal
              ? ' (was ' + lastRemoteCount + ' remote)'
              : '')
        );
        log('Book League synced', '+', lastDue, 'total', lastTotal);
      }
    } catch (e) {
      setBookLeagueStatus((e && e.message) || 'Sync failed', true);
      log('Book League sync error', e);
    } finally {
      bookLeagueSyncing = false;
      releaseBookLeagueLock(lockId);
      if (bookLeagueLockId === lockId) bookLeagueLockId = '';
    }
  }

  let bookLeagueSyncTimer = 0;
  function scheduleBookLeagueSync(ms) {
    if (bookLeagueSyncTimer) clearTimeout(bookLeagueSyncTimer);
    bookLeagueSyncTimer = setTimeout(() => {
      bookLeagueSyncTimer = 0;
      syncBookLeagueNow();
    }, ms == null ? 400 : ms);
  }

  function paintBoard() {
    painting = true;
    try {
      ensureStyle();
      ensureBookLeagueUi();
      ensureTakeRecUi();
      ensureBasketballAllChip();
      ensureDefaultMarket();
      ensureOpenerOn();
      clearTdrMarks();
      markPriceRanksOnTradBoard();
      markZcodeRatioChips();
      refreshTakeRecPanel();
    } finally {
      painting = false;
    }
  }

  function scheduleBoardPaint(ms) {
    if (paintTimer) clearTimeout(paintTimer);
    paintTimer = setTimeout(() => {
      paintTimer = 0;
      paintBoard();
    }, ms == null ? 80 : ms);
  }

  function boot4c() {
    if (fixBrokenBoardRoute()) return;
    scrubUnknownView();

    document.addEventListener(
      'click',
      (e) => {
        if (marketAutoClick) return;
        const t = e && e.target;
        if (!t || !t.closest) return;
        const btn = t.closest(
          '.seg[aria-label="Market"] .segBtn, [role="tablist"][aria-label="Market"] [role="tab"]'
        );
        if (btn) marketUserOverride = true;
      },
      true
    );

    try {
      if (typeof GM_addValueChangeListener === 'function') {
        GM_addValueChangeListener(ZCODE_LIVE_KEY, (_name, oldVal, newVal, remote) => {
          // Cross-tab write from ZCode → update chips immediately (not a one-shot cache).
          zcodeLiveCache = newVal && Array.isArray(newVal.games) ? newVal : null;
          zcodeLiveCacheAt = Date.now();
          const oldFp = oldVal && oldVal.fp != null ? String(oldVal.fp) : '';
          const newFp = newVal && newVal.fp != null ? String(newVal.fp) : '';
          if (remote || oldFp !== newFp) {
            if (oldFp !== newFp || !zcodeLiveFpSeen) {
              refreshZcodeRatioChipsFromGm();
              log('ZCode ratios synced', newVal && newVal.gameCount, remote ? '(remote)' : '');
            }
          }
        });
      }
    } catch (_) {}

    watchFourCSportRoute();
    scheduleBoardPaint(0);
    setInterval(() => {
      if (fixBrokenBoardRoute()) return;
      scrubUnknownView();
      scheduleBoardPaint(0);
    }, 2500);
    // Fallback poll if value-change listener misses a write
    setInterval(() => {
      refreshZcodeRatioChipsFromGm();
    }, 1500);

    try {
      let moTimer = 0;
      const isOwn = (n) => {
        if (!n || n.nodeType !== 1) return true;
        if (n.id === STYLE_ID) return true;
        if (n.id === BOOK_LEAGUE_UI_ID) return true;
        if (n.id === TAKE_REC_UI_ID) return true;
        if (n.closest && n.closest('#' + TAKE_REC_UI_ID)) return true;
        if (
          n.classList &&
          (n.classList.contains('pc-price-rank') ||
            n.classList.contains('pc-zcode-ratio') ||
            n.classList.contains('pc-circa-take-msg') ||
            n.classList.contains('pc-bl-title') ||
            n.classList.contains('pc-bl-meta') ||
            n.classList.contains('pc-tr-row') ||
            n.classList.contains('pc-tr-body') ||
            n.classList.contains('pc-tr-sec') ||
            n.classList.contains('pc-tr-tog') ||
            n.classList.contains('pc-tr-zcode-btn') ||
            n.classList.contains('pc-tr-head'))
        ) {
          return true;
        }
        return false;
      };
      const mo = new MutationObserver((muts) => {
        if (painting) return;
        for (let i = 0; i < muts.length; i++) {
          const m = muts[i];
          const lists = [m.addedNodes, m.removedNodes];
          for (let li = 0; li < lists.length; li++) {
            const nodes = lists[li];
            for (let j = 0; j < (nodes ? nodes.length : 0); j++) {
              const n = nodes[j];
              if (!n || n.nodeType !== 1) {
                if (n && n.nodeType === 3) {
                  if (moTimer) clearTimeout(moTimer);
                  moTimer = setTimeout(() => {
                    moTimer = 0;
                    scheduleBoardPaint(80);
                  }, 120);
                }
                continue;
              }
              if (isOwn(n)) continue;
              if (n.classList && n.classList.contains('pc-circa-take-msg')) {
                continue;
              }
              // Ignore line-history modal entirely — never touch it.
              if (
                n.closest &&
                n.closest('.hm, .hmBody, .mtable, .modal.wide[aria-label="Line history"]')
              ) {
                continue;
              }
              if (moTimer) clearTimeout(moTimer);
              moTimer = setTimeout(() => {
                moTimer = 0;
                scrubUnknownView();
                scheduleBoardPaint(80);
              }, 120);
            }
          }
        }
      });
      const start = () => {
        const root = document.getElementById('app') || document.body;
        if (!root) return false;
        mo.observe(root, { childList: true, subtree: true });
        return true;
      };
      if (!start()) {
        const w = setInterval(() => {
          if (start()) clearInterval(w);
        }, 500);
      }
    } catch (_) {}

    let lastPath = location.pathname + location.search;
    setInterval(() => {
      if (fixBrokenBoardRoute()) return;
      scrubUnknownView();
      const key = location.pathname + location.search;
      if (key === lastPath) return;
      lastPath = key;
      publishFourCSportWant(true);
      scheduleBoardPaint(100);
    }, 600);

    ensureBookLeagueUi();
    ensureTakeRecUi();
    try {
      if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('Book League: Set GitHub token', promptGithubToken);
        GM_registerMenuCommand('Book League: Sync now', () => scheduleBookLeagueSync(0));
        GM_registerMenuCommand('Book League: Force push to GitHub', () => {
          syncBookLeagueNow({ forceGh: true });
        });
        GM_registerMenuCommand('Book League: Download data.js', () => {
          downloadBookLeagueDataFile(readLocalBookLeague());
        });
      }
    } catch (_) {}
    scheduleBookLeagueSync(800);
    setInterval(() => scheduleBookLeagueSync(0), BOOK_LEAGUE_SYNC_MS);
    log('Ready (TDR + Take + OTC + ZCode + Book League ATS · v3.11.0)');
  }

  function bootBookLeaguePage() {
    const local = readLocalBookLeague();
    const fileData =
      window.__BOOK_LEAGUE_DATA__ && typeof window.__BOOK_LEAGUE_DATA__ === 'object'
        ? window.__BOOK_LEAGUE_DATA__
        : null;
    // Merge local TM + Pages file immediately, then reconcile with GitHub (global store).
    let snaps = mergeLeagueSnaps(
      (local && local.snaps) || [],
      (fileData && fileData.snaps) || []
    );
    const payload = {
      updatedAt: new Date().toISOString(),
      snaps: snaps,
      source: 'merged',
    };
    saveLocalBookLeague(payload);
    publishBookLeagueToPage(payload);
    try {
      if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('Book League: Set GitHub token', promptGithubToken);
        GM_registerMenuCommand('Book League: Sync now', () => scheduleBookLeagueSync(0));
        GM_registerMenuCommand('Book League: Force push to GitHub', () => {
          syncBookLeagueNow({ forceGh: true });
        });
        GM_registerMenuCommand('Book League: Download data.js', () => {
          downloadBookLeagueDataFile(readLocalBookLeague());
        });
      }
    } catch (_) {}
    log('Book League page hydrated (pre-GitHub)', snaps.length);
    scheduleBookLeagueSync(300);
  }

  function boot() {
    if (IS_ZCODE) {
      bootZcodeBridge();
      return;
    }
    if (IS_BOOK_LEAGUE_PAGE) {
      bootBookLeaguePage();
      return;
    }
    if (IS_4C) boot4c();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
