// ==UserScript==
// @name         4C Odds — TDRs only
// @namespace    https://github.com/local/pinny-fade
// @version      3.14.1
// @description  TDR badges on today's 2 Best-line books; Take = every game from quadratic BL×gap vote; agree% from margin; OTC; Open Zcode; hold glow; Best vs Pinny ¢; Take picks; Book League ATS/ML cover grades.
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
// @connect      sports.core.api.espn.com
// @connect      www.thesportsdb.com
// @connect      www.fotmob.com
// @connect      fotmob.com
// @connect      prod-cdn-public-api.livescore.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const STYLE_ID = 'pinny-tdr-style';
  const ZCODE_LIVE_KEY = '4cConsZcodeLive';
  const ZCODE_SPORT_WANT_KEY = '4cConsZcodeSportWant';
  /** Bumped while a 4codds tab is open, even when the sport itself did not change. */
  const ZCODE_SPORT_WANT_BEAT_KEY = '4cConsZcodeSportWantBeat';
  /** Ignore a saved sport once 4codds has been closed longer than this. */
  const ZCODE_SPORT_WANT_FRESH_MS = 8000;
  /** Roster for multi-tab ZCode: surplus tabs close when board sports shrink. */
  const ZCODE_TAB_ROSTER_KEY = '4cConsZcodeTabRoster';
  /** Click Open Zcode: force an immediate scrape (bypasses scrape debounce). */
  const ZCODE_FORCE_KEY = '4cConsZcodeForceAt';
  /** Steady ZCode poll once this tab's sport is covered — keep ratios fresh, avoid DOM thrash. */
  const ZCODE_POLL_MS = 15 * 1000;
  /** Min gap between DOM scrapes unless Open Zcode / missing sport / live MO forces one. */
  const ZCODE_SCRAPE_MIN_MS = 8 * 1000;
  let zcodeWantSettleTimer = 0;
  let zcodeLastScrapeAt = 0;
  /** Min books with a fav price to snap. Was 12; NBA boards often only quote ~10–11. */
  const BOOK_LEAGUE_MIN_Y = 8;
  /** Soccer books thinner than US boards — still need a real market, not a 1-book listing. */
  const BOOK_LEAGUE_MIN_Y_SOCCER = 5;
  const BOOK_LEAGUE_UI_ID = 'pc-book-league-sync';
  const TAKE_REC_UI_ID = 'pc-take-rec';
  const OPEN_ZCODE_UI_ID = 'pc-open-zcode';
  /**
   * Paint TDR 1/Y badges under every book price.
   * false = rank in-memory for Take + Book League (no badge on every book).
   */
  const DISPLAY_TDR_RANKS = false;
  /**
   * When full TDR display is off: paint real ranks on the 2 Best-line books only (fav Best + dog Best).
   * Limited to today's games to avoid board-wide layout thrash.
   */
  const DISPLAY_TDR_BL_ENDS = true;
  /** Skip Take/TDR work on a game until this many books show a fav price (lets rows finish loading). */
  const RANK_MIN_BOOKS_WHILE_LOADING = 4;

  function tdrBadgesVisible() {
    return DISPLAY_TDR_RANKS || DISPLAY_TDR_BL_ENDS;
  }
  /** Take picks panel (top-center). Board My Line Take overlay stays on. */
  const TAKE_REC_PANEL_ENABLED = true;
  /** Dog Takes: hold % at or below this. Fav Takes: hold % at or above this + fav ratio < 1. */
  const TAKE_REC_DOG_HOLD_MAX = 0.5;
  const TAKE_REC_FAV_HOLD_MIN = 1.5;
  /** Take picks: sort-boost by how far Pinny O→C is from favoring the take. */
  const TAKE_REC_AGAINST_KEY = 'pcTakeRecMovedAgainst';
  let takeRecSteamBoost = false;
  let takeRecLastFp = '';
  let takeRecRefreshTimer = 0;
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
  /** Soccer kickoffs cluster overnight / next afternoon ET; 18h dropped tomorrow's CL. */
  const BOOK_LEAGUE_MAX_START_AHEAD_MS_SOCCER = 36 * 3600000;
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
  let lastPaintAt = 0;
  let styleReady = false;
  let strippedLegacyMarks = false;
  let strippedVisibleTdrs = false;
  /** In-memory TDR badges so Take can read ranks without painting the board. */
  const tdrInfoByPx = new WeakMap();
  /** Mutation burst tracking — stretch paint debounce while the board is streaming prices. */
  let moBurstHits = 0;
  let moBurstWindowAt = 0;
  let boardGamesCache = null;
  let headerBundleCache = { head: null, n: 0, sig: '', codes: [], names: [] };
  let dirtyAllGames = true;
  const dirtyGames = new Set();
  let lastBoardOddsFp = '';
  let lastMarketSportKey = '';
  let marketUserOverride = false;
  let marketAutoClick = false;
  let lastMarketEnsureAt = 0;
  let lastFairEnsureAt = 0;
  let lastBasketballAllEnsureAt = 0;
  let lastBasketballBoardKey = '';
  let basketballLeagueUserOverride = false;
  let basketballAllAutoClick = false;
  let zcodeLiveCache = null;
  let zcodeLiveCacheAt = 0;
  let zcodeLiveFpSeen = '';
  let bookLeagueLastMsg = '';
  let bookLeagueSyncing = false;
  let bookLeagueLockId = '';
  /** Cache: { updatedAt, bySport: { NFL: { rows, bestCode, worstCode, rankIndexByCode, nameByCode } } } */
  let blStandingsCache = { updatedAt: null, bySport: {} };
  const TAKE_MIN_BL_BOOKS = 1;
  /** Always paint a Take; agree% is the calibrated margin (never gates the side). */
  const TAKE_MIN_CONFIDENCE = 0;
  /** Book abstains only on exact TDR ties (gap 0). */
  const TAKE_MIN_TDR_GAP = 1;

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
    // Purdue Fort Wayne (4C: IPFW · ZCode: IUPU - Ft. Wayne)
    ipfw: 'iupu ft wayne',
    pfw: 'iupu ft wayne',
    'iupu ft wayne': 'iupu ft wayne',
    'iupui ft wayne': 'iupu ft wayne',
    'iupu fort wayne': 'iupu ft wayne',
    'iupui fort wayne': 'iupu ft wayne',
    'purdue fort wayne': 'iupu ft wayne',
    'purdue ft wayne': 'iupu ft wayne',
    'indiana fort wayne': 'iupu ft wayne',
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

  /**
   * Exact ZCode row:
   *   <div class="public_tix_stats zcode-average-popular-number">% Ratio: <b>2.92</b></div>
   * (Not Public Ratio in .public_tickets.tickets[ratio_level_*].)
   */
  function readZcodePctRatio(teamRoot) {
    if (!teamRoot) return null;
    const nodes = teamRoot.querySelectorAll('.public_tix_stats.zcode-average-popular-number');
    for (let i = 0; i < nodes.length; i++) {
      const text = String(nodes[i].textContent || '').replace(/\s+/g, ' ').trim();
      if (!/%\s*Ratio\s*:/i.test(text)) continue;
      const b = nodes[i].querySelector('b');
      const raw = String((b && b.textContent) || '').replace(/\s+/g, ' ').trim();
      if (!raw || /^N\/A$/i.test(raw)) continue;
      const n = parseFloat(raw);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
  }

  function readZcodePpcPct(teamRoot, kind) {
    if (!teamRoot) return NaN;
    const sel =
      kind === 'ml'
        ? '.public_tickets.ppc.ToML b'
        : '.public_tickets.ppc.ToSpread b, .public_tickets.ppc.ToSpreadVal b';
    const el = teamRoot.querySelector(sel);
    if (!el) return NaN;
    const n = parseFloat(String(el.textContent || '').replace('%', ''));
    return Number.isFinite(n) ? n : NaN;
  }

  /** Same model ZCode uses for the % Ratio row (Massey / Backtest Helper). */
  function computeZcodePctRatio(ml, spread, oppMl, oppSpread, isFavorite, sport) {
    const round2 = (n) => Math.round(n * 100) / 100;
    const sp = String(sport || '').toUpperCase();
    if (sp === 'NHL' || sp === 'MLB') {
      let ratio = null;
      const hasMl = Number.isFinite(ml) && Number.isFinite(oppMl) && oppMl > 0;
      if (hasMl) ratio = ml / oppMl;
      else if (Number.isFinite(spread) && Number.isFinite(oppSpread) && oppSpread > 0)
        ratio = spread / oppSpread;
      if (ratio == null) return null;
      if (isFavorite && hasMl && oppMl > ml) ratio *= 0.3;
      return round2(ratio);
    }
    const hasAll = [ml, spread, oppMl, oppSpread].every(Number.isFinite);
    let ratio = null;
    if (hasAll) {
      const combined = ml + spread;
      const opposite = 200 - combined;
      if (opposite <= 0) return null;
      ratio = combined / opposite;
    } else if (Number.isFinite(spread) && Number.isFinite(oppSpread) && oppSpread > 0) {
      ratio = spread / oppSpread;
    }
    if (ratio == null) return null;
    if (isFavorite) {
      if (Number.isFinite(ml) && Number.isFinite(oppMl) && oppMl > ml) ratio *= 0.3;
      if (Number.isFinite(spread) && Number.isFinite(oppSpread) && oppSpread > spread)
        ratio *= 0.5;
    }
    return round2(ratio);
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
      const t1 = el.querySelector('.team1');
      const t2 = el.querySelector('.team2');
      let r1 = readZcodePctRatio(t1);
      let r2 = readZcodePctRatio(t2);
      // Fallback: rebuild % Ratio from ML%/Spread% when the labeled row isn't painted yet.
      if (!(Number.isFinite(r1) && r1 > 0) || !(Number.isFinite(r2) && r2 > 0)) {
        let ppc = null;
        const ppcRaw = get('ppc');
        if (ppcRaw) {
          try {
            ppc = JSON.parse(ppcRaw);
          } catch (_) {
            ppc = null;
          }
        }
        const ml1 =
          ppc && ppc.ml_pc1 != null ? parseFloat(ppc.ml_pc1) : readZcodePpcPct(t1, 'ml');
        const ml2 =
          ppc && ppc.ml_pc2 != null ? parseFloat(ppc.ml_pc2) : readZcodePpcPct(t2, 'ml');
        const sl1 =
          ppc && ppc.sl_pc1 != null ? parseFloat(ppc.sl_pc1) : readZcodePpcPct(t1, 'spread');
        const sl2 =
          ppc && ppc.sl_pc2 != null ? parseFloat(ppc.sl_pc2) : readZcodePpcPct(t2, 'spread');
        const odd1 = parseFloat(get('ml1') || '');
        const odd2 = parseFloat(get('ml2') || '');
        const h1 = parseFloat(get('handicap1') || '');
        const h2 = parseFloat(get('handicap2') || '');
        const team1Fav =
          Number.isFinite(odd1) && Number.isFinite(odd2)
            ? odd1 < odd2
            : Number.isFinite(h1) && Number.isFinite(h2)
              ? h1 < h2
              : true;
        if (!(Number.isFinite(r1) && r1 > 0)) {
          r1 = computeZcodePctRatio(ml1, sl1, ml2, sl2, team1Fav, sport);
        }
        if (!(Number.isFinite(r2) && r2 > 0)) {
          r2 = computeZcodePctRatio(ml2, sl2, ml1, sl1, !team1Fav, sport);
        }
      }
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

  function zcodeHasGames(live) {
    return !!(live && Array.isArray(live.games) && live.games.length);
  }

  function zcodeSportCovered(live, sport) {
    const sp = String(sport || '').toUpperCase();
    if (!sp) return zcodeHasGames(live);
    const sports = Array.isArray(live && live.sports)
      ? live.sports.map((s) => String(s || '').toUpperCase()).filter(Boolean)
      : [];
    if (sports.indexOf(sp) >= 0) return true;
    const games = live && Array.isArray(live.games) ? live.games : [];
    for (let i = 0; i < games.length; i++) {
      if (String((games[i] && games[i].sport) || '').toUpperCase() === sp) return true;
    }
    return false;
  }

  /** Drop this tab's sport from the live bus (or wipe if nothing remains). No abandoned cache. */
  function revokeZcodeLiveForSport(sport) {
    const sp = String(sport || '').toUpperCase();
    if (!sp || typeof GM_getValue !== 'function') return;
    let prev = null;
    try {
      prev = GM_getValue(ZCODE_LIVE_KEY, null);
    } catch (_) {}
    const prevGames = prev && Array.isArray(prev.games) ? prev.games : [];
    const write = (payload) => {
      try {
        if (typeof GM_setValue === 'function') GM_setValue(ZCODE_LIVE_KEY, payload);
      } catch (_) {}
      zcodeLiveCache = payload && Array.isArray(payload.games) && payload.games.length ? payload : null;
      zcodeLiveCacheAt = Date.now();
    };
    if (!prevGames.length) {
      write(null);
      return;
    }
    const kept = prevGames.filter((g) => String((g && g.sport) || '').toUpperCase() !== sp);
    if (!kept.length) {
      write(null);
      return;
    }
    write({
      updatedAt: Date.now(),
      gameCount: kept.length,
      games: kept,
      fp: zcodeGamesFingerprint(kept),
      sports: Array.from(
        new Set(
          kept
            .map((g) => String((g && g.sport) || '').toUpperCase())
            .filter(Boolean)
        )
      ),
    });
  }

  function requestZcodeUserRefresh() {
    zcodeLiveFpSeen = '';
    zcodeLastScrapeAt = 0;
    try {
      if (typeof GM_setValue === 'function') GM_setValue(ZCODE_FORCE_KEY, Date.now());
    } catch (_) {}
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

  /**
   * Scrape ZCode DOM into GM. Anti-lag: debounce scrapes, write only when the
   * ratio fingerprint changes (or Open Zcode / missing-sport forces it).
   */
  function publishZcodeLive(force) {
    if (typeof GM_setValue !== 'function') return 0;
    const now = Date.now();
    let prev = null;
    try {
      prev = GM_getValue(ZCODE_LIVE_KEY, null);
    } catch (_) {}
    const prevGames = prev && Array.isArray(prev.games) ? prev.games : [];
    const sport = currentZcodeSportFromUrl() || '';
    const prevSports = Array.isArray(prev && prev.sports)
      ? prev.sports.map((s) => String(s || '').toUpperCase()).filter(Boolean)
      : [];
    const sportMissing = !!(sport && prevSports.indexOf(sport) < 0);
    let userForceAt = 0;
    try {
      userForceAt = Number(GM_getValue(ZCODE_FORCE_KEY, 0)) || 0;
    } catch (_) {}
    const prevAt = prev && prev.updatedAt ? Number(prev.updatedAt) : 0;
    const userForce = userForceAt > 0 && userForceAt > prevAt;
    const sinceScrape = now - zcodeLastScrapeAt;
    const allowScrape =
      !!force ||
      userForce ||
      sportMissing ||
      !prevGames.length ||
      sinceScrape >= ZCODE_SCRAPE_MIN_MS;
    if (!allowScrape) return prevGames.length;
    zcodeLastScrapeAt = now;
    const scraped = scrapeZcodeLiveGames();
    // Empty scrape on a sport still missing from GM: keep the old snapshot,
    // but return 0 so first-run retry does not think this tab is done.
    if (!scraped.length && sportMissing) return 0;
    const games = mergeZcodeLiveGames(scraped, sport, prevGames);
    if (!games.length) return 0;
    const fp = zcodeGamesFingerprint(games);
    const prevFp = prev && prev.fp != null ? String(prev.fp) : '';
    if (!userForce && !force && !sportMissing && fp === prevFp && prevGames.length) {
      return games.length;
    }
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
    zcodeLiveCache = payload;
    zcodeLiveCacheAt = now;
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
  function refreshZcodeRatioChipsFromGm(force) {
    if (!force) {
      const liveQuick = readZcodeLive(false);
      const fpQuick =
        liveQuick && liveQuick.fp != null
          ? String(liveQuick.fp)
          : zcodeGamesFingerprint(liveQuick && liveQuick.games);
      if (
        fpQuick === zcodeLiveFpSeen &&
        zcodeHasGames(liveQuick) &&
        zcodeRatioRolesSettled()
      ) {
        const zbtnHeld = document.getElementById(OPEN_ZCODE_UI_ID);
        if (zbtnHeld) syncOpenZcodeBtn(zbtnHeld);
        return false;
      }
    }
    zcodeLiveCache = null;
    zcodeLiveCacheAt = 0;
    const zbtn = document.getElementById(OPEN_ZCODE_UI_ID);
    if (zbtn) syncOpenZcodeBtn(zbtn);
    else ensureOpenZcodeBtn();
    const live = readZcodeLive(true);
    const fp = live && live.fp != null ? String(live.fp) : zcodeGamesFingerprint(live && live.games);
    if (fp === zcodeLiveFpSeen && zcodeHasGames(live) && zcodeRatioRolesSettled()) {
      return false;
    }
    const wasPainting = painting;
    painting = true;
    try {
      // In-place update only — do not wipe chips first
      markZcodeRatioChips();
      if (TAKE_REC_PANEL_ENABLED) scheduleTakeRecRefresh(120);
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
    teamEl.removeAttribute('data-pc-zratio');
    teamEl.removeAttribute('data-pc-zrole');
    teamEl.removeAttribute('data-pc-ztier');
  }

  function clearZcodeRatioChips() {
    document.querySelectorAll('.pc-zcode-ratio').forEach((n) => n.remove());
    document
      .querySelectorAll('.team.pc-zcode-host, .team.pc-zcode-name, .team[data-pc-zratio]')
      .forEach((el) => {
        el.classList.remove('pc-zcode-host');
        clearZcodeNameTier(el);
      });
  }

  /** Fav-only alert colors: <1 green · 2–4.99 yellow · 5+ red · 1–1.99 muted */
  /** Take-picks ratio pill: ≤0.99 green, 2.00–4.99 yellow, ≥5 red, else blue. */
  function takeRecRatioTier(r) {
    if (r == null || !Number.isFinite(r)) return 'soft';
    const shown = parseFloat(fmtRatioChip(r));
    if (!Number.isFinite(shown)) return 'soft';
    if (shown <= 0.99) return 'lo';
    if (shown >= 5) return 'hi';
    if (shown >= 2 && shown <= 4.99) return 'mid';
    return 'soft';
  }

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
    const leftover = teamEl.querySelector(':scope > .pc-zcode-ratio');
    if (leftover) leftover.remove();
    const txt = fmtRatioChip(ratio);
    const tier = role === 'fav' ? ratioTierClass(ratio) : 'tier-soft';
    const zt =
      role === 'fav'
        ? tier === 'tier-lo'
          ? 'lo'
          : tier === 'tier-mid'
            ? 'mid'
            : tier === 'tier-hi'
              ? 'hi'
              : 'soft'
        : '';
    const zr = role === 'fav' ? 'fav' : 'dog';
    if (teamEl.getAttribute('data-pc-zratio') !== txt) teamEl.setAttribute('data-pc-zratio', txt);
    if (teamEl.getAttribute('data-pc-zrole') !== zr) teamEl.setAttribute('data-pc-zrole', zr);
    if (zt) {
      if (teamEl.getAttribute('data-pc-ztier') !== zt) teamEl.setAttribute('data-pc-ztier', zt);
    } else if (teamEl.hasAttribute('data-pc-ztier')) teamEl.removeAttribute('data-pc-ztier');
    const title =
      'ZCode % Ratio ' +
      txt +
      (role === 'fav' ? ' (fav)' : role === 'dog' ? ' (dog)' : '');
    if (teamEl.title !== title) teamEl.title = title;
  }

  /**
   * True when ratio chips don't need another pass for fav/dog roles.
   * After a tab switch, ratios often stamp before Best/books exist, so every
   * side is dog and ztier never lands. Re-run once tradFavSideIndex can resolve.
   */
  function zcodeRatioRolesSettled() {
    if (document.querySelector('.gRow.gGame .team[data-pc-zrole="fav"]')) return true;
    let stamped = 0;
    let resolvable = 0;
    for (const row of document.querySelectorAll('.gRow.gGame')) {
      if (!row.querySelector('.team[data-pc-zratio]')) continue;
      stamped++;
      if (tradFavSideIndex(row) != null) resolvable++;
    }
    if (!stamped) return false;
    // Book fav available on a stamped row but no fav chip → stale dog-only pass.
    if (resolvable > 0) return false;
    return true;
  }

  function markZcodeRatioChips() {
    const live = readZcodeLive(false);
    if (!live || !live.games || !live.games.length) {
      zcodeLiveFpSeen = '';
      clearZcodeRatioChips();
      return;
    }
    const fp = live.fp != null ? String(live.fp) : zcodeGamesFingerprint(live.games);
    if (fp === zcodeLiveFpSeen && document.querySelector('.gRow.gGame .team[data-pc-zratio]')) {
      if (zcodeRatioRolesSettled()) return;
    }
    zcodeLiveFpSeen = fp;

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
      const favSide = tradFavSideIndex(gameEl, nOut);
      const favTeamIdx = outcomeToTeamIndex(favSide, nOut);
      const role0 = favTeamIdx === 0 ? 'fav' : favTeamIdx === 1 ? 'dog' : null;
      const role1 = favTeamIdx === 1 ? 'fav' : favTeamIdx === 0 ? 'dog' : null;
      attachZcodeRatioChip(nameEls[0], hit.r0, live, role0);
      attachZcodeRatioChip(nameEls[1], hit.r1, live, role1);
      for (let si = 0; si < 2; si++) {
        const ne = nameEls[si];
        if (!ne) continue;
        const host = ne.closest('.team') || ne.parentElement;
        if (host) keep.add(host);
      }
    });
    document.querySelectorAll('.gRow.gGame .team[data-pc-zratio]').forEach((el) => {
      if (!keep.has(el)) clearZcodeNameTier(el);
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
        const k = String(takeSportKeyForGame(gameEl) || '').toUpperCase();
        if (!k || k === 'SOCCER') return;
        set.add(k);
      });
    } catch (_) {}
    if (!set.size) {
      const one = fourCToZcodeSport();
      if (one) set.add(one);
    }
    const ordered = order.filter((k) => set.has(k));
    Array.from(set)
      .filter((k) => !order.includes(k) && k !== 'SOCCER')
      .sort()
      .forEach((k) => ordered.push(k));
    return ordered;
  }

  function touchFourCSportWantBeat() {
    if (typeof GM_setValue !== 'function') return;
    try {
      GM_setValue(ZCODE_SPORT_WANT_BEAT_KEY, Date.now());
    } catch (_) {}
  }

  /** True only while a 4codds tab has published recently. A closed board must not move Zcode. */
  function zcodeSportWantIsLive(payload) {
    if (!payload || !payload.sport) return false;
    let beat = 0;
    try {
      beat = Number(GM_getValue(ZCODE_SPORT_WANT_BEAT_KEY, 0)) || 0;
    } catch (_) {}
    const at = Math.max(beat, Number(payload.updatedAt) || 0);
    return at > 0 && Date.now() - at < ZCODE_SPORT_WANT_FRESH_MS;
  }

  function publishFourCSportWant(force) {
    if (typeof GM_setValue !== 'function') return null;
    const sports = boardZcodeSportsNeeded();
    const sport = sports[0] || fourCToZcodeSport();
    if (!sport) {
      log('ZCode sport want: no map for', location.pathname);
      return null;
    }
    touchFourCSportWantBeat();
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
    if (!payload || !zcodeSportWantIsLive(payload)) return false;
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

  function syncOpenZcodeBtn(btn) {
    if (!btn) return;
    const live = readZcodeLive(false);
    const liveN = live && live.games ? live.games.length : 0;
    const on = liveN > 0;
    const nextText = on ? 'Zcode · ' + liveN : 'Open Zcode';
    if (btn.classList.contains('on') !== on) btn.classList.toggle('on', on);
    if (btn.textContent !== nextText) btn.textContent = nextText;
  }

  function ensureOpenZcodeBtn() {
    if (!IS_4C) return null;
    let btn = document.getElementById(OPEN_ZCODE_UI_ID);
    if (btn) {
      syncOpenZcodeBtn(btn);
      return btn;
    }
    btn = document.createElement('button');
    btn.id = OPEN_ZCODE_UI_ID;
    btn.type = 'button';
    btn.textContent = 'Open Zcode';
    btn.setAttribute('aria-label', 'Open Zcode');
    btn.title = 'Open ZCode Line Reversals for sport(s) on this board';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      requestZcodeUserRefresh();
      openNeededZcodeTabs();
      syncOpenZcodeBtn(btn);
    });
    (document.body || document.documentElement).appendChild(btn);
    syncOpenZcodeBtn(btn);
    return btn;
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
    setInterval(bump, 2500);
    publishFourCSportWant(true);
  }

  function bootZcodeBridge() {
    // Follow 4codds board → ?sport= before scraping
    try {
      const want = typeof GM_getValue === 'function' ? GM_getValue(ZCODE_SPORT_WANT_KEY, null) : null;
      log('ZCode sport want on boot', want && want.sport, 'url', currentZcodeSportFromUrl());
      if (applyZcodeSportFromWant(want)) return; // navigating away
    } catch (_) {}

    let lastFp = '';
    let retryTimer = 0;
    let retryMo = null;
    let retryMoTo = 0;
    let pollTimer = 0;
    let liveMo = null;
    let liveMoTo = 0;
    let retryStartedAt = 0;
    const FIRST_RETRY_MS = 1500;
    const FIRST_RETRY_CAP_MS = 90 * 1000;
    /** Debounce for persistent ratio-DOM observer (keeps GM fresh after first fill). */
    const LIVE_MO_DEBOUNCE_MS = 1200;

    function readLive() {
      try {
        return typeof GM_getValue === 'function' ? GM_getValue(ZCODE_LIVE_KEY, null) : null;
      } catch (_) {
        return null;
      }
    }

    function thisTabSnapshotReady() {
      const live = readLive();
      if (!zcodeHasGames(live)) return false;
      return zcodeSportCovered(live, currentZcodeSportFromUrl());
    }

    function stopFirstRetry() {
      if (retryTimer) {
        clearInterval(retryTimer);
        retryTimer = 0;
      }
      if (retryMoTo) {
        clearTimeout(retryMoTo);
        retryMoTo = 0;
      }
      if (retryMo) {
        try {
          retryMo.disconnect();
        } catch (_) {}
        retryMo = null;
      }
    }

    function scheduleSteadyPoll() {
      if (pollTimer) return;
      pollTimer = setInterval(() => {
        tick(false);
        if (!thisTabSnapshotReady()) {
          if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = 0;
          }
          startFirstRetry();
        }
      }, ZCODE_POLL_MS);
    }

    /** Stay attached after first fill — ZCode often mutates ratios without a full re-render. */
    function armLiveRatioObserver() {
      if (liveMo || !document.body) return;
      try {
        liveMo = new MutationObserver(() => {
          if (liveMoTo) return;
          liveMoTo = setTimeout(() => {
            liveMoTo = 0;
            tick(false);
          }, LIVE_MO_DEBOUNCE_MS);
        });
        liveMo.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      } catch (_) {
        liveMo = null;
      }
    }

    const tick = (force) => {
      const n = publishZcodeLive(!!force);
      let payload = null;
      try {
        payload = GM_getValue(ZCODE_LIVE_KEY, null);
      } catch (_) {}
      const fp = payload && payload.fp != null ? String(payload.fp) : '';
      if (fp && fp !== lastFp) {
        lastFp = fp;
        log('ZCode live published', n, 'games (ratios changed)');
      }
      try {
        const b = document.getElementById('pc-zcode-bridge-badge');
        const sp = currentZcodeSportFromUrl() || '?';
        if (b) {
          const count = zcodeHasGames(payload) ? payload.games.length : n;
          b.textContent = '4C bridge · ' + sp + (count ? ' · ' + count + ' ratios' : '');
        }
      } catch (_) {}
      if (thisTabSnapshotReady()) {
        stopFirstRetry();
        scheduleSteadyPoll();
        armLiveRatioObserver();
      }
      return n;
    };

    function startFirstRetry() {
      if (thisTabSnapshotReady()) {
        stopFirstRetry();
        tick(false); // scrape now; tick arms the steady poll + live MO
        return;
      }
      if (retryTimer) return;
      retryStartedAt = Date.now();
      tick(false);
      if (thisTabSnapshotReady()) return;
      retryTimer = setInterval(() => {
        if (thisTabSnapshotReady()) {
          stopFirstRetry();
          scheduleSteadyPoll();
          armLiveRatioObserver();
          return;
        }
        if (retryStartedAt && Date.now() - retryStartedAt > FIRST_RETRY_CAP_MS) {
          stopFirstRetry();
          // Keep polling lightly even if the first fill never landed.
          tick(false);
          scheduleSteadyPoll();
          armLiveRatioObserver();
          return;
        }
        tick(false);
      }, FIRST_RETRY_MS);
      try {
        if (!retryMo && document.body) {
          retryMo = new MutationObserver(() => {
            if (retryMoTo) return;
            retryMoTo = setTimeout(() => {
              retryMoTo = 0;
              if (!thisTabSnapshotReady()) tick(false);
            }, 800);
          });
          retryMo.observe(document.body, { childList: true, subtree: true });
        }
      } catch (_) {}
    }

    try {
      if (typeof GM_addValueChangeListener === 'function') {
        GM_addValueChangeListener(ZCODE_SPORT_WANT_KEY, (_n, _o, v, remote) => {
          log('ZCode sport want event', v && v.sport, remote ? 'remote' : 'local');
          applyZcodeSportFromWant(v);
          setTimeout(() => {
            if (thisTabSnapshotReady()) tick(false);
            else startFirstRetry();
          }, 400);
        });
        GM_addValueChangeListener(ZCODE_FORCE_KEY, () => {
          zcodeLastScrapeAt = 0;
          stopFirstRetry();
          tick(true);
          if (!thisTabSnapshotReady()) startFirstRetry();
          else scheduleSteadyPoll();
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
    startFirstRetry();
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
    armLiveRatioObserver();
    // Drop this tab's sport when it closes so 4C never paints an abandoned scrape.
    const revokeThisSport = () => {
      try {
        revokeZcodeLiveForSport(currentZcodeSportFromUrl());
      } catch (_) {}
    };
    window.addEventListener('pagehide', revokeThisSport);
    window.addEventListener('beforeunload', revokeThisSport);
    log(
      'ZCode → 4C bridge armed (poll ' +
        ZCODE_POLL_MS / 1000 +
        's · scrape min ' +
        ZCODE_SCRAPE_MIN_MS / 1000 +
        's · no cache · v3.13.32)'
    );
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
   * Basketball: default league nav to All (NBA + NCAAB).
   * Manual NBA / NCAAB / etc. clicks stick until you leave basketball or click All.
   */
  function ensureBasketballAllChip() {
    const path = String(location.pathname || '').toLowerCase().replace(/\/+$/, '') || '/';
    const onBb = /(^|\/)basketball(\/|$)/.test(path);
    const info = routeInfo();
    const boardKey = (info.live ? 'live' : 'pre') + '|' + (onBb ? 'basketball' : String(info.sport || info.board || ''));
    if (!onBb) {
      lastBasketballBoardKey = boardKey;
      return false;
    }
    if (boardKey !== lastBasketballBoardKey) {
      lastBasketballBoardKey = boardKey;
      basketballLeagueUserOverride = false;
    }
    if (basketballLeagueUserOverride) return false;
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

    basketballAllAutoClick = true;
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
    } finally {
      setTimeout(() => {
        basketballAllAutoClick = false;
      }, 0);
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
    const existing = document.getElementById(STYLE_ID);
    const styleMark = DISPLAY_TDR_RANKS
      ? 'tdr-display-on-v1'
      : DISPLAY_TDR_BL_ENDS
        ? 'tdr-display-bl-ends-v1'
        : 'tdr-display-off-v1';
    if (
      styleReady &&
      existing &&
      existing.textContent.indexOf('hold-arb-glow-v3') >= 0 &&
      existing.textContent.indexOf('take-rec-otc-v2') >= 0 &&
      existing.textContent.indexOf(styleMark) >= 0
    )
      return;
    styleReady = false;
    let s = document.getElementById(STYLE_ID);
    if (!s) {
      s = document.createElement('style');
      s.id = STYLE_ID;
      document.documentElement.appendChild(s);
    }
    const tdrAfterCss = `.gRow.gGame .cell.cBook .px[data-pc-rank]::after{content:attr(data-pc-rank);flex:1 0 100%;display:block;width:100%;margin:0;padding:0 2px;border-radius:2px;font:800 7px/1.05 Sora,system-ui,sans-serif;font-variant-numeric:tabular-nums;color:#000!important;letter-spacing:0;pointer-events:none;white-space:nowrap;text-align:center;background:#7ecbff}
.gRow.gGame .cell.cBook .px[data-pc-rt="dog"]::after{background:#ff8a8a}
.gRow.gGame .cell.cBook .px[data-pc-rt="draw"]::after{background:#ffa500}
.gRow.gGame .cell.cBook .px[data-pc-tt="best"]::after{background:#ffeb3b}
.gRow.gGame .cell.cBook .px[data-pc-tt="green"]::after{background:#a6ff4d}
.gRow.gGame .cell.cBook .px[data-pc-tt="deep"]::after{background:#4a9eff}`;
    // Full display wraps every book px; BL-ends only wraps the few cells that have a badge.
    const bookPxCss = DISPLAY_TDR_RANKS
      ? `.gRow.gGame .cell.cBook .px{position:relative;display:inline-flex!important;flex-direction:row;flex-wrap:wrap;align-items:center;justify-content:center;gap:0 2px;line-height:1;overflow:visible}
${tdrAfterCss}`
      : DISPLAY_TDR_BL_ENDS
        ? `.gRow.gGame .cell.cBook .px[data-pc-rank]{position:relative;display:inline-flex!important;flex-direction:row;flex-wrap:wrap;align-items:center;justify-content:center;gap:0 2px;line-height:1;overflow:visible}
${tdrAfterCss}`
        : `/* ${styleMark} — ranks stay in-memory; no badge layout under every book */`;
    const css = `
/* ${styleMark} */
.gRow.gGame .cell.cBook,.gRow.gGame .cell.cBest{overflow:visible}
${bookPxCss}
.gRow.gGame .cell.cBest .px{position:relative;display:inline-flex!important;flex-direction:row;flex-wrap:nowrap;align-items:center;justify-content:center;gap:0 2px;line-height:1;overflow:visible}
.gRow.gGame .cell.cBest .px[data-pc-pingap]::after{content:attr(data-pc-pingap);flex:0 0 auto;display:inline-block;margin:0;padding:0 2px;border-radius:2px;font:800 7px/1.05 Sora,system-ui,sans-serif;font-variant-numeric:tabular-nums;letter-spacing:0;pointer-events:none;white-space:nowrap;text-align:center}
.gRow.gGame .cell.cBest .px[data-pc-pg="fav"]::after{background:#2e7d32;color:#fff!important}
.gRow.gGame .cell.cBest .px[data-pc-pg="dog"]::after{background:#ff6a00;color:#000!important}
/* My Line: inset outline when Vertex is board best — Take FAV green / DOG orange */
.gRow.gGame .cell.cFair.pc-vertex-best{border-radius:3px!important}
.gRow.gGame .cell.cFair.pc-vertex-best.role-fav{outline:1px solid rgba(57,255,20,.95);outline-offset:-1px}
.gRow.gGame .cell.cFair.pc-vertex-best.role-dog{outline:1px solid rgba(255,106,0,.95);outline-offset:-1px}
.gRow.gGame.pc-hold-tight{outline:1px solid rgba(255,214,0,.95);outline-offset:-1px;position:relative;z-index:1}
.gRow.gGame.pc-hold-arb{outline:1px solid #ffffff;outline-offset:-1px;position:relative;z-index:1}
.gRow.gGame .cell.cHold.pc-hold-tight{outline:1px solid rgba(255,220,40,.95);outline-offset:-1px;color:#ffe566;text-shadow:0 0 4px rgba(255,214,0,.7)}
/* hold-arb-glow-v3 — pure #ffffff inner glow, stacked above the cell */
.gRow.gGame .cell.cHold.pc-hold-arb{
  position:relative!important;
  z-index:40!important;
  overflow:visible!important;
  isolation:isolate;
  outline:none!important;
  color:#ffffff!important;
  text-shadow:none!important;
  filter:none!important;
  background-image:none!important;
  box-shadow:none!important;
  --darkreader-inline-boxshadow:none!important;
  --darkreader-inline-color:#ffffff!important;
  --darkreader-text:#ffffff!important;
}
.gRow.gGame .cell.cHold.pc-hold-arb::after{
  content:"";
  position:absolute;
  inset:0;
  border-radius:inherit;
  pointer-events:none;
  z-index:999;
  mix-blend-mode:normal;
  background:transparent!important;
  box-shadow:inset 0 0 0 1px #ffffff,inset 0 0 8px 2px #ffffff,inset 0 0 16px 4px #ffffff!important;
  --darkreader-inline-boxshadow:inset 0 0 0 1px #ffffff,inset 0 0 8px 2px #ffffff,inset 0 0 16px 4px #ffffff!important;
}
.gRow.gGame .cell.cFair[data-pc-take]{position:relative}
.gRow.gGame .cell.cFair[data-pc-take] > .px{visibility:hidden!important;pointer-events:none}
.gRow.gGame .cell.cFair[data-pc-take]::after{content:attr(data-pc-take);position:absolute;inset:0 1px;display:flex;align-items:center;justify-content:center;text-align:center;font:800 7px/1.05 Sora,system-ui,sans-serif;pointer-events:none;z-index:2;overflow:hidden;hyphens:auto}
.gRow.gGame .cell.cFair[data-pc-take-role="fav"]::after{color:#39ff14;text-shadow:0 0 8px rgba(57,255,20,.55),0 0 2px #000}
.gRow.gGame .cell.cFair[data-pc-take-role="dog"]::after{color:#ff6a00;text-shadow:0 0 8px rgba(255,106,0,.55),0 0 2px #000}
.gRow.gGame .team[data-pc-otc]::before{content:"O->C";display:inline-block;margin-right:3px;vertical-align:middle;font:900 8px/1 Sora,system-ui,sans-serif;letter-spacing:-0.01em;pointer-events:none;white-space:nowrap;flex-shrink:0}
.gRow.gGame .team[data-pc-otc="fav"]::before{color:#39ff14;text-shadow:0 0 6px rgba(57,255,20,.45),0 0 1px #000}
.gRow.gGame .team[data-pc-otc="dog"]::before{color:#ff9800;text-shadow:0 0 6px rgba(255,152,0,.4),0 0 1px #000}
.gRow.gGame .team[data-pc-zratio]{position:relative!important}
.gRow.gGame .team[data-pc-zratio]::after{content:attr(data-pc-zratio);position:absolute;right:0;top:50%;transform:translateY(-50%);margin:0;padding:0 3px;border-radius:3px;font:800 8px/1.15 Sora,system-ui,sans-serif;font-variant-numeric:tabular-nums;letter-spacing:0;pointer-events:none;white-space:nowrap;z-index:3;background:#1e3a4c;color:#9ed0ff;border:1px solid rgba(158,208,255,.28)}
.gRow.gGame .team[data-pc-ztier="lo"]::after{background:#2e7d32;color:#e8ffe9;border-color:rgba(165,214,167,.55)}
.gRow.gGame .team[data-pc-ztier="soft"]::after{background:#1e3a4c;color:#9ed0ff;border-color:rgba(158,208,255,.28)}
.gRow.gGame .team[data-pc-ztier="mid"]::after{background:#f0c419;color:#1a1400;border-color:rgba(240,196,25,.7)}
.gRow.gGame .team[data-pc-ztier="hi"]::after{background:#d32f2f;color:#fff;border-color:rgba(255,180,180,.55)}
.gRow.gGame .team[data-pc-zrole="dog"]::after{background:#1e3a4c!important;color:#9ed0ff!important;border-color:rgba(158,208,255,.28)!important}
/* Name highlight on .team only — never pad/border .tName (triggers 4C abbr flicker) */
.gRow.gGame .team[data-pc-zrole="fav"]{border-radius:3px}
.gRow.gGame .team[data-pc-ztier="lo"]{background:rgba(46,125,50,.55);outline:1px solid rgba(165,214,167,.55);outline-offset:-1px}
.gRow.gGame .team[data-pc-ztier="soft"]{background:rgba(30,58,76,.65);outline:1px solid rgba(158,208,255,.28);outline-offset:-1px}
.gRow.gGame .team[data-pc-ztier="mid"]{background:rgba(240,196,25,.55);outline:1px solid rgba(240,196,25,.7);outline-offset:-1px}
.gRow.gGame .team[data-pc-ztier="hi"]{background:rgba(211,47,47,.55);outline:1px solid rgba(255,180,180,.55);outline-offset:-1px}
.gRow.gGame .team[data-pc-zrole="fav"] .tName{font-weight:800}
.board .state.err,.boardPane .state.err,section.board .state.err{display:none!important}
#pc-open-zcode{position:fixed;right:max(10px,env(safe-area-inset-right,0px));top:max(8px,env(safe-area-inset-top,0px));z-index:100001;min-height:36px;min-width:6.2em;padding:8px 12px;border:1px solid rgba(158,208,255,.45);border-radius:9px;background:rgba(30,58,76,.96);color:#9ed0ff;font:800 12px/1.1 Sora,system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.35);cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;-webkit-text-size-adjust:100%}
#pc-open-zcode.on{border-color:rgba(57,255,20,.5);color:#9dff8a;background:rgba(24,58,36,.96)}
#pc-open-zcode:hover{border-color:rgba(158,208,255,.75);color:#dff0ff}
@media (max-width:900px),(pointer:coarse){
  #pc-open-zcode{min-height:44px;padding:12px 16px;font-size:14px;top:max(52px,env(safe-area-inset-top,0px))}
}
#pc-book-league-sync{position:fixed;right:10px;bottom:calc(10px + env(safe-area-inset-bottom,0px));z-index:99999;max-width:210px;padding:6px 9px;border-radius:8px;border:1px solid rgba(255,255,255,.14);background:rgba(18,26,38,.92);color:#c8d4e6;font:650 10px/1.3 Sora,system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.35);pointer-events:none}
#pc-book-league-sync .pc-bl-title{font:800 10px/1.15 Sora,system-ui,sans-serif;color:#e8eef8;margin:0 0 1px}
#pc-book-league-sync.warn{border-color:rgba(252,165,165,.35);color:#fecaca}
/* take-rec-otc-v2 — O->C immediately after the team name */
#pc-take-rec{position:fixed;left:50%;top:max(8px,env(safe-area-inset-top,0px));transform:translateX(-50%);z-index:100000;width:min(420px,calc(100vw - 24px));max-height:min(46vh,440px);overflow:auto;-webkit-overflow-scrolling:touch;padding:7px 8px;border-radius:9px;border:1px solid rgba(255,255,255,.14);background:rgba(12,18,28,.96);color:#c8d4e6;font:650 10px/1.3 Sora,system-ui,sans-serif;box-shadow:0 8px 22px rgba(0,0,0,.4);touch-action:manipulation;-webkit-text-size-adjust:100%}
#pc-take-rec .pc-tr-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 8px;cursor:pointer;-webkit-user-select:none;user-select:none}
#pc-take-rec .pc-tr-head-text{min-width:0;flex:1}
#pc-take-rec .pc-tr-title{font:800 11px/1.15 Sora,system-ui,sans-serif;color:#e8eef8;letter-spacing:-0.01em}
#pc-take-rec .pc-tr-sub{font:650 9px/1.2 Sora,system-ui,sans-serif;color:#8a97ad}
#pc-take-rec .pc-tr-tog{flex-shrink:0;width:32px;height:32px;border:1px solid rgba(255,255,255,.16);border-radius:8px;background:rgba(255,255,255,.06);color:#e8eef8;font:800 14px/1 Sora,system-ui,sans-serif;cursor:pointer;touch-action:manipulation}
#pc-take-rec.pc-tr-collapsed{max-height:none;overflow:hidden;width:auto;min-width:9.5em;padding:6px 8px}
#pc-take-rec.pc-tr-collapsed .pc-tr-head{margin:0}
#pc-take-rec.pc-tr-collapsed .pc-tr-body{display:none}
#pc-take-rec.pc-tr-collapsed .pc-tr-sub{display:none}
#pc-take-rec.pc-tr-collapsed .pc-tr-zcode-head{display:none}
#pc-take-rec.pc-tr-collapsed .pc-tr-tog{transform:rotate(-90deg)}
@media (max-width:900px),(pointer:coarse){
  #pc-take-rec{
    top:max(52px,env(safe-area-inset-top,0px));
    left:50%;
    right:auto;
    bottom:auto;
    transform:translateX(-50%);
    width:min(440px,calc(100vw - 20px));
    max-height:min(46vh,380px);
    z-index:100001;
  }
  #pc-take-rec.pc-tr-collapsed{
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
#pc-take-rec .pc-tr-row{display:flex;flex-direction:column;align-items:stretch;gap:3px;width:100%;margin:0 0 3px;padding:6px 8px;border:1px solid rgba(255,255,255,.08);border-radius:8px;background:rgba(255,255,255,.03);color:#e8eef8;font:inherit;text-align:left;cursor:pointer}
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
#pc-take-rec .pc-tr-str{flex-shrink:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;min-width:2.8em;padding:3px 5px;border-radius:5px;background:rgba(255,255,255,.07);font:800 11px/1 Sora,system-ui,sans-serif;font-variant-numeric:tabular-nums;color:#e8eef8;letter-spacing:-0.02em}
#pc-take-rec .pc-tr-str .pc-tr-str-den{font:650 7px/1 Sora,system-ui,sans-serif;color:#8a97ad;text-transform:uppercase;letter-spacing:0.04em}
#pc-take-rec .pc-tr-str.hi{background:rgba(57,255,20,.16);color:#9dff8a}
#pc-take-rec .pc-tr-str.mid{background:rgba(240,196,25,.16);color:#f5d76e}
#pc-take-rec .pc-tr-str.lo{background:rgba(211,47,47,.18);color:#ff8a80}
#pc-take-rec .pc-tr-str.na{opacity:.45;font-weight:700}
#pc-take-rec .pc-tr-row.role-fav .pc-tr-day{color:#6dbf5c}
#pc-take-rec .pc-tr-row.role-dog .pc-tr-day{color:#c67a3a}
#pc-take-rec .pc-tr-row.role-fav .pc-tr-time{color:#9dff8a;text-shadow:0 0 8px rgba(57,255,20,.45)}
#pc-take-rec .pc-tr-row.role-dog .pc-tr-time{color:#ffb078;text-shadow:0 0 8px rgba(255,106,0,.45)}
#pc-take-rec .pc-tr-main{display:flex;align-items:baseline;gap:6px;min-width:0;width:100%}
#pc-take-rec .pc-tr-take{font:800 12px/1.2 Sora,system-ui,sans-serif;color:#fff!important;text-shadow:0 0 1px #000;flex-shrink:0}
#pc-take-rec .pc-tr-team{flex:1 1 auto;min-width:8em;font:800 14px/1.2 Sora,system-ui,sans-serif;color:#fff!important;white-space:normal;overflow:visible;text-overflow:clip;word-break:break-word}
#pc-take-rec .pc-tr-role{flex-shrink:0;font:800 12px/1 Sora,system-ui,sans-serif;letter-spacing:0.04em}
#pc-take-rec .pc-tr-row.role-fav .pc-tr-role{color:#39ff14!important}
#pc-take-rec .pc-tr-row.role-dog .pc-tr-role{color:#ffb078!important}
#pc-take-rec .pc-tr-otc{margin-left:6px;font:900 11px/1 Sora,system-ui,sans-serif;letter-spacing:-0.01em;white-space:nowrap}
#pc-take-rec .pc-tr-otc.fav{color:#39ff14;text-shadow:0 0 6px rgba(57,255,20,.45),0 0 1px #000}
#pc-take-rec .pc-tr-otc.dog{color:#ff9800;text-shadow:0 0 6px rgba(255,152,0,.4),0 0 1px #000}
#pc-take-rec .pc-tr-meta{display:flex;align-items:center;flex-wrap:wrap;gap:6px;width:100%}
#pc-take-rec .pc-tr-opp{font:650 11px/1.2 Sora,system-ui,sans-serif;color:#c5d0e0!important;white-space:normal}
#pc-take-rec .pc-tr-row.role-fav .pc-tr-team{color:#39ff14!important;text-shadow:0 0 10px rgba(57,255,20,.55),0 0 2px #000}
#pc-take-rec .pc-tr-row.role-dog .pc-tr-team{color:#ffb078!important;text-shadow:0 0 10px rgba(255,106,0,.55),0 0 2px #000}
#pc-take-rec .pc-tr-ratio{flex-shrink:0;font:800 11px/1 Sora,system-ui,sans-serif;font-variant-numeric:tabular-nums;padding:2px 6px;border-radius:5px}
#pc-take-rec .pc-tr-ratio.lo{background:#2e7d32;color:#e8ffe9}
#pc-take-rec .pc-tr-ratio.mid{background:#f0c419;color:#1a1400}
#pc-take-rec .pc-tr-ratio.hi{background:#d32f2f;color:#fff}
#pc-take-rec .pc-tr-ratio.soft{background:#1e3a4c;color:#9ed0ff}
#pc-take-rec .pc-tr-hold{flex-shrink:0;font:800 10px/1 Sora,system-ui,sans-serif;font-variant-numeric:tabular-nums;padding:2px 5px;border-radius:5px;background:rgba(255,255,255,.08);color:#c8d4e6}
#pc-take-rec .pc-tr-hold.tight{background:rgba(255,214,0,.18);color:#ffe566}
#pc-take-rec .pc-tr-hold.arb{background:rgba(255,255,255,.2);color:#fff}
#pc-take-rec .pc-tr-hold.wide{background:rgba(57,255,20,.14);color:#9dff8a}
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
.gRow.gGame.pc-tr-flash{outline:1px solid rgba(57,255,20,.85);outline-offset:-1px;border-radius:3px}
`;
    if (s.textContent !== css) s.textContent = css;
    styleReady = true;
  }

  function stripLegacyOverlayNodes() {
    if (strippedLegacyMarks) return;
    strippedLegacyMarks = true;
    document
      .querySelectorAll('.pc-price-rank, .pc-otc-badge, .pc-zcode-ratio, .pc-circa-take-msg')
      .forEach((n) => n.remove());
  }

  function tradBoardGames() {
    if (boardGamesCache) return boardGamesCache;
    const root =
      document.querySelector('.gTable') ||
      document.querySelector('section.trad .gScroll') ||
      document.querySelector('.boardPane.trad');
    if (root) return root.querySelectorAll('.gRow.gGame[data-game]');
    return document.querySelectorAll('.gRow.gGame[data-game]');
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

  function tradBookHeaderBundle() {
    const els = tradBookHeaderEls();
    const head = els.length ? els[0].parentElement : null;
    const n = els.length;
    const sig =
      n &&
      String(els[0].getAttribute('data-code') || '') +
        '|' +
        String(els[n - 1].getAttribute('data-code') || '');
    if (
      headerBundleCache.head === head &&
      headerBundleCache.n === n &&
      headerBundleCache.sig === sig &&
      headerBundleCache.codes.length === n
    ) {
      return headerBundleCache;
    }
    const codes = els.map((el) => String(el.getAttribute('data-code') || '').toUpperCase());
    const names = els.map((el) => {
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
    headerBundleCache = { head: head, n: n, sig: sig, codes: codes, names: names };
    return headerBundleCache;
  }

  function tradBookHeaderCodes() {
    return tradBookHeaderBundle().codes;
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
      const raw = String(num.textContent || '').trim();
      if (/^(pk|pick(?:em)?|even)$/i.test(raw)) return 0;
      const m = raw.match(/^([+-]?\d+(?:\.\d+)?)/);
      if (m) return parseFloat(m[1]);
    }
    const ariaHost = el.getAttribute('aria-label')
      ? el
      : el.querySelector('.bestPrice, [aria-label]');
    const aria = ariaHost ? String(ariaHost.getAttribute('aria-label') || '') : '';
    const m2 = aria.match(/([+-]?\d+(?:\.\d+)?)\s+[+-]\d{2,4}/);
    return m2 ? parseFloat(m2[1]) : null;
  }

  function tradCellPxNodes(cell) {
    if (!cell) return [];
    const pxs = cell.querySelectorAll(':scope > .px, :scope > button.px, :scope > span.px');
    const n = pxs.length >= 3 ? 3 : Math.min(2, pxs.length);
    const out = [];
    for (let i = 0; i < n; i++) out.push(pxs[i] || null);
    return out;
  }

  function tradCellSides(cell) {
    const pxs = tradCellPxNodes(cell);
    const prices = [];
    const lines = [];
    for (let i = 0; i < pxs.length; i++) {
      prices.push(tradPxAmerican(pxs[i]));
      lines.push(tradPxLine(pxs[i]));
    }
    return { prices: prices, lines: lines, els: pxs };
  }

  function tradCellSidePrices(cell) {
    const pxs = tradCellPxNodes(cell);
    const out = [];
    for (let i = 0; i < pxs.length; i++) out.push(tradPxAmerican(pxs[i]));
    return out;
  }

  function tradCellSideLines(cell) {
    const pxs = tradCellPxNodes(cell);
    const out = [];
    for (let i = 0; i < pxs.length; i++) out.push(tradPxLine(pxs[i]));
    return out;
  }

  function tradCellSideEls(cell) {
    return tradCellPxNodes(cell);
  }

  function tradOutcomeCount(gameEl) {
    const sample =
      gameEl.querySelector(':scope > .cell.cBest') ||
      gameEl.querySelector(':scope > .cell.cFair') ||
      gameEl.querySelector(':scope > .cell.cBook');
    if (!sample) return 2;
    const n = sample.querySelectorAll(':scope > .px, :scope > button.px, :scope > span.px').length;
    return n >= 3 ? 3 : 2;
  }

  function tradFavSideIndex(gameEl, nOut) {
    if (nOut == null) nOut = tradOutcomeCount(gameEl);
    const best =
      gameEl.querySelector(':scope > .cell.cBest') || gameEl.querySelector('.cell.cBest');
    const open =
      gameEl.querySelector(':scope > .cell.cOpen') || gameEl.querySelector('.cell.cOpen');
    const homeIdx = nOut >= 3 ? 2 : 1;
    const linePairs = [tradCellSideLines(best), tradCellSideLines(open)];
    const books = gameEl.querySelectorAll(':scope > .cell.cBook');
    for (let i = 0; i < books.length && i < 4; i++) {
      linePairs.push(tradCellSideLines(books[i]));
    }
    for (let p = 0; p < linePairs.length; p++) {
      const a = linePairs[p][0];
      const h = linePairs[p][homeIdx];
      if (a == null || h == null || a === h) continue;
      return a < h ? 0 : homeIdx;
    }
    const pricePairs = [tradCellSidePrices(best), tradCellSidePrices(open)];
    for (let i = 0; i < books.length && i < 6; i++) {
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

  function tradGameBothSidesNegative(gameEl, nOut) {
    if (!gameEl) return false;
    if (nOut == null) nOut = tradOutcomeCount(gameEl);
    const homeIdx = nOut >= 3 ? 2 : 1;
    const cell =
      gameEl.querySelector(':scope > .cell.cBest') ||
      gameEl.querySelector(':scope > .cell.cOpen') ||
      gameEl.querySelector(':scope > .cell.cBook');
    if (!cell) return false;
    const prices = tradCellSidePrices(cell);
    const a = prices[0];
    const h = prices[homeIdx];
    return a != null && h != null && a < 0 && h < 0;
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

  function priceRankTierClass(rank, y) {
    if (!rank || !y) return '';
    if (rank === 1) return 'tier-best';
    const mid = y / 2;
    if (rank > mid) return 'tier-deep';
    const greenMax = Math.max(2, Math.floor(y / 4));
    if (rank <= greenMax) return 'tier-green';
    return '';
  }

  function hidePriceRankAttrs(el) {
    if (!el || !el.removeAttribute) return;
    el.removeAttribute('data-pc-rank');
    el.removeAttribute('data-pc-rt');
    el.removeAttribute('data-pc-tt');
    el.removeAttribute('data-pc-jt');
  }

  function clearPriceRankOnPx(el) {
    if (!el) return;
    try {
      tdrInfoByPx.delete(el);
    } catch (_) {}
    hidePriceRankAttrs(el);
  }

  function paintPriceRankFromCache(el) {
    if (!el) return;
    const cached = tdrInfoByPx.get(el);
    if (!cached || !cached.rank) {
      hidePriceRankAttrs(el);
      return;
    }
    const label = cached.label || String(cached.rank);
    const rt = cached.role || 'fav';
    const tier = priceRankTierClass(cached.rank, cached.y || cached.rank);
    const tt =
      tier === 'tier-best' ? 'best' : tier === 'tier-green' ? 'green' : tier === 'tier-deep' ? 'deep' : '';
    if (el.getAttribute('data-pc-rank') !== label) el.setAttribute('data-pc-rank', label);
    if (el.getAttribute('data-pc-rt') !== rt) el.setAttribute('data-pc-rt', rt);
    if (tt) {
      if (el.getAttribute('data-pc-tt') !== tt) el.setAttribute('data-pc-tt', tt);
    } else if (el.hasAttribute('data-pc-tt')) el.removeAttribute('data-pc-tt');
    if (cached.joint) {
      if (el.getAttribute('data-pc-jt') !== '1') el.setAttribute('data-pc-jt', '1');
    } else if (el.hasAttribute('data-pc-jt')) el.removeAttribute('data-pc-jt');
  }

  /** Today's board games only (day chip / tip calendar day). */
  function isBoardGameToday(gameEl) {
    if (!gameEl) return false;
    const dayText = gameDayHeaderText(gameDayHeaderEl(gameEl, { skipTour: true }));
    if (/\btoday\b/i.test(dayText)) return true;
    if (/\btomorrow\b/i.test(dayText) || /\byesterday\b/i.test(dayText)) return false;
    const ms = parseGameStartMs(gameEl);
    if (ms == null || !Number.isFinite(ms)) {
      // Undated daily row — treat as today; explicit other-day chips already returned false.
      return !dayText || !/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun|\d{1,2}\s+[A-Za-z]{3}|[A-Za-z]{3}\s+\d{1,2})\b/i.test(dayText);
    }
    const d = new Date(ms);
    const n = new Date();
    return (
      d.getFullYear() === n.getFullYear() &&
      d.getMonth() === n.getMonth() &&
      d.getDate() === n.getDate()
    );
  }

  /** Real board TDR badges only on today's 2 Best-line books (fav Best + dog Best). */
  function paintBlEndTdrBadges(gameEl, codes, bookCells, names, favIdx, dogIdx) {
    if (!DISPLAY_TDR_BL_ENDS || DISPLAY_TDR_RANKS || !gameEl) return;
    if (!isBoardGameToday(gameEl)) {
      const ranked = gameEl.querySelectorAll(':scope > .cell.cBook .px[data-pc-rank]');
      for (let i = 0; i < ranked.length; i++) hidePriceRankAttrs(ranked[i]);
      return;
    }
    const show = new Set();
    if (favIdx != null && dogIdx != null) {
      const leads = [
        bestSideLeadBook(gameEl, favIdx, codes, names),
        bestSideLeadBook(gameEl, dogIdx, codes, names),
      ];
      for (let c = 0; c < leads.length; c++) {
        const lead = leads[c];
        if (!lead || !lead.code) continue;
        const cell = bookCellForBlCode(codes, bookCells, names, lead.code);
        if (!cell) continue;
        const els = tradCellSideEls(cell);
        for (let i = 0; i < els.length; i++) {
          if (els[i]) show.add(els[i]);
        }
      }
    }
    show.forEach((el) => paintPriceRankFromCache(el));
    gameEl.querySelectorAll(':scope > .cell.cBook .px[data-pc-rank]').forEach((px) => {
      if (!show.has(px)) hidePriceRankAttrs(px);
    });
  }

  function attachPriceRankBadge(el, rank, y, role, joint) {
    if (!el || !rank || !y) return null;
    const leftover = el.querySelector(':scope > .pc-price-rank');
    if (leftover) leftover.remove();
    const tier = priceRankTierClass(rank, y);
    const label = (joint ? 'J' : '') + rank + '/' + y;
    const rt = role === 'dog' ? 'dog' : role === 'draw' ? 'draw' : 'fav';
    const tt =
      tier === 'tier-best' ? 'best' : tier === 'tier-green' ? 'green' : tier === 'tier-deep' ? 'deep' : '';
    tdrInfoByPx.set(el, {
      rank: rank,
      y: y,
      joint: !!joint,
      label: label,
      role: rt,
    });
    // Full board paint, or memory-only (BL-ends paints #1/last in a second pass).
    if (!DISPLAY_TDR_RANKS) {
      hidePriceRankAttrs(el);
      return el;
    }
    if (el.getAttribute('data-pc-rank') !== label) el.setAttribute('data-pc-rank', label);
    if (el.getAttribute('data-pc-rt') !== rt) el.setAttribute('data-pc-rt', rt);
    if (tt) {
      if (el.getAttribute('data-pc-tt') !== tt) el.setAttribute('data-pc-tt', tt);
    } else if (el.hasAttribute('data-pc-tt')) el.removeAttribute('data-pc-tt');
    if (joint) {
      if (el.getAttribute('data-pc-jt') !== '1') el.setAttribute('data-pc-jt', '1');
    } else if (el.hasAttribute('data-pc-jt')) el.removeAttribute('data-pc-jt');
    return el;
  }

  function clearTdrMarks() {
    document.querySelectorAll('.px[data-pc-rank]').forEach(clearPriceRankOnPx);
    document.querySelectorAll('.pc-price-rank').forEach((n) => n.remove());
    document.querySelectorAll('.gRow.gGame[data-pc-tdr]').forEach((el) => {
      el.removeAttribute('data-pc-tdr');
    });
    document.querySelectorAll('.pc-otc-badge').forEach((n) => n.remove());
    document.querySelectorAll('.team[data-pc-otc]').forEach((el) => {
      el.removeAttribute('data-pc-otc');
    });
    document.querySelectorAll('.px[data-pc-pingap], a.tName[data-pc-pingap], .tName[data-pc-pingap]').forEach((el) => {
      el.removeAttribute('data-pc-pingap');
      el.removeAttribute('data-pc-pg');
    });
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
    document.querySelectorAll('.cell.cFair.pc-circa-take').forEach((cell) => {
      const gameEl = cell.closest('.gRow.gGame');
      restoreCircaTakeOnGame(gameEl || cell.parentElement);
    });
    document.querySelectorAll('.gRow.gGame.pc-hold-tight, .gRow.gGame.pc-hold-arb').forEach((el) => {
      el.classList.remove('pc-hold-tight', 'pc-hold-arb');
    });
    document.querySelectorAll('.cell.cHold.pc-hold-tight, .cell.cHold.pc-hold-arb').forEach((el) => {
      el.classList.remove('pc-hold-tight', 'pc-hold-arb');
    });
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

  /** TDR badge on a px: { rank, y, joint, label } or null. Prefers in-memory cache. */
  function pxTdrInfo(pxEl) {
    if (!pxEl || pxEl.classList.contains('none') || pxEl.disabled) return null;
    const cached = tdrInfoByPx.get(pxEl);
    if (cached && cached.rank) {
      return {
        rank: cached.rank,
        y: cached.y || null,
        joint: !!cached.joint,
        label: cached.label || String(cached.rank),
      };
    }
    const label = String(pxEl.getAttribute('data-pc-rank') || '').trim();
    if (label) {
      const m = label.match(/^J?(\d+)\s*\/\s*(\d+)/i);
      if (m) {
        return {
          rank: parseInt(m[1], 10),
          y: parseInt(m[2], 10),
          joint: pxEl.getAttribute('data-pc-jt') === '1' || /^J/i.test(label),
          label: label,
        };
      }
    }
    // Site “best” class before ranks land
    if (pxEl.classList.contains('best') || pxEl.getAttribute('data-pc-tt') === 'best') {
      return { rank: 1, y: null, joint: false, label: 'best' };
    }
    return null;
  }

  function restoreCircaTakeOnGame(gameEl) {
    if (!gameEl) return;
    const fairCell = tradFairCell(gameEl);
    if (!fairCell) return;
    fairCell.querySelectorAll(':scope > .pc-circa-take-msg').forEach((n) => n.remove());
    fairCell.removeAttribute('data-pc-take');
    fairCell.removeAttribute('data-pc-take-role');
    delete gameEl.dataset.pcTakeFp;
    if (fairCell.classList.contains('pc-circa-take') || fairCell.hasAttribute('data-pc-take')) {
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
  function markVertexBestGlow(gameEl, nOut, favIdx) {
    if (!gameEl) return;
    const fairCell = tradFairCell(gameEl);
    if (!fairCell) return;
    fairCell.classList.remove('pc-vertex-best', 'role-fav', 'role-dog');
    if (nOut == null) nOut = tradOutcomeCount(gameEl);
    if (favIdx == null) favIdx = tradFavSideIndex(gameEl, nOut);
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
    const league = gameLeagueLabel(gameEl) || gameTourLeagueLabel(gameEl);
    const teams = gameTeamNames(gameEl);
    if (league) {
      const fromGame = sportKeyFromSnap({ league: league, sport: '', teams: teams });
      if (fromGame) return fromGame;
    }
    const info = routeInfo();
    const fromTeams = sportKeyFromSnap({
      league: league || '',
      sport: (info && (info.sport || info.board)) || '',
      teams: teams,
    });
    if (fromTeams === 'NCAAB') return 'NCAAB';
    const fromRoute = fourCToZcodeSport();
    if (fromRoute && fromRoute !== 'NBA') return fromRoute;
    if (fromTeams) return fromTeams;
    if (fromRoute) return fromRoute;
    return sportKeyFromSnap({
      league: league || '',
      sport: (info && (info.sport || info.board)) || '',
      teams: teams,
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
   * TDR vote: { lean, gap } or null.
   * Follow the sharper side; abstain if either side missing or gap < TAKE_MIN_TDR_GAP.
   */
  function tdrLeanFromSides(favTdr, dogTdr) {
    const dogRank =
      dogTdr && dogTdr.rank != null && Number.isFinite(dogTdr.rank) ? dogTdr.rank : null;
    const favRank =
      favTdr && favTdr.rank != null && Number.isFinite(favTdr.rank) ? favTdr.rank : null;
    if (favRank == null || dogRank == null) return null;
    const gap = Math.abs(favRank - dogRank);
    if (gap < TAKE_MIN_TDR_GAP) return null;
    if (favRank < dogRank) return { lean: 'fav', gap: gap };
    if (dogRank < favRank) return { lean: 'dog', gap: gap };
    return null;
  }

  /**
   * Map raw winning share s∈(0.5,1] → agree%∈(50,100].
   * edge = 2s−1 (0 = coin flip, 1 = unanimous). sqrt so clear majorities
   * read high without needing every soft book to pile on.
   */
  function takeAgreeFromShare(winShare) {
    const s = Number(winShare);
    if (!Number.isFinite(s) || s <= 0.5) return 50;
    if (s >= 1) return 100;
    const edge = Math.max(0, Math.min(1, 2 * s - 1));
    return Math.min(100, Math.max(50, Math.round(50 + 50 * Math.sqrt(edge))));
  }

  function blBookDisplayName(standings, code, fallback) {
    if (standings && standings.nameByCode && standings.nameByCode[code]) {
      return standings.nameByCode[code];
    }
    return fallback || code || '?';
  }

  /** Board cell for a Book League code (exact, then fuzzy name/code). */
  function bookCellForBlCode(codes, bookCells, names, blCode) {
    if (!blCode) return null;
    let cell = bookCellByCode(codes, bookCells, blCode, null);
    if (cell) return cell;
    const resolved = resolveBookCode(blCode, codes, names);
    if (resolved) {
      cell = bookCellByCode(codes, bookCells, resolved, null);
      if (cell) return cell;
    }
    const compact = String(blCode).replace(/[^a-z0-9]/gi, '');
    if (compact.length >= 3) {
      try {
        return bookCellByCode(codes, bookCells, null, new RegExp(compact, 'i'));
      } catch (_) {}
    }
    return null;
  }

  /**
   * Last-resort side when no BL book has a two-sided TDR lean:
   * fade the better sport-BL Best-line book (Ducks-style).
   */
  function takeFromBestLineFallback(gameEl, standings, codes, bookCells, names, favIdx, dogIdx) {
    if (!gameEl || !standings) return null;
    const bestFav = bestSideLeadBook(gameEl, favIdx, codes, names);
    const bestDog = bestSideLeadBook(gameEl, dogIdx, codes, names);
    if (
      !bestFav ||
      !bestDog ||
      !bestFav.code ||
      !bestDog.code ||
      bestFav.code === bestDog.code
    ) {
      return null;
    }
    const favBlIdx = standings.rankIndexByCode[bestFav.code];
    const dogBlIdx = standings.rankIndexByCode[bestDog.code];
    if (favBlIdx == null || dogBlIdx == null || favBlIdx === dogBlIdx) return null;
    // Better BL → fade its Best side.
    return {
      role: favBlIdx < dogBlIdx ? 'dog' : 'fav',
      agreePct: 50,
      voters: 0,
    };
  }

  /**
   * Weighted sport Book League vote — every priced game gets a side.
   * weight = (n − rankIndex)² × TDR gap → top BL books dominate soft noise.
   * agree% from vote margin (sqrt edge), not raw 51/49 share.
   * Exact weight tie → follow best-ranked voter; no voters → Best-line fallback.
   */
  function takeFromWeightedBookLeague(
    gameEl,
    standings,
    codes,
    bookCells,
    names,
    favIdx,
    dogIdx
  ) {
    if (!standings || !standings.rows || !standings.rows.length) return null;
    const n = standings.rows.length;
    let favW = 0;
    let dogW = 0;
    let voters = 0;
    let topVoterLean = null; // best BL rank that cast a vote
    for (let i = 0; i < n; i++) {
      const row = standings.rows[i];
      if (!row || !row.code) continue;
      const cell = bookCellForBlCode(codes, bookCells, names, row.code);
      if (!cell) continue;
      const vote = tdrLeanFromSides(pxSideTdr(cell, favIdx), pxSideTdr(cell, dogIdx));
      if (!vote || !vote.lean) continue;
      if (topVoterLean == null) topVoterLean = vote.lean;
      const blW = Math.max(1, n - i);
      const w = blW * blW * vote.gap;
      if (vote.lean === 'fav') favW += w;
      else if (vote.lean === 'dog') dogW += w;
      else continue;
      voters += 1;
    }
    if (!voters || !(favW + dogW)) {
      return takeFromBestLineFallback(
        gameEl,
        standings,
        codes,
        bookCells,
        names,
        favIdx,
        dogIdx
      );
    }
    if (favW === dogW) {
      return {
        role: topVoterLean || 'fav',
        agreePct: 50,
        voters: voters,
      };
    }
    const role = favW > dogW ? 'fav' : 'dog';
    const share = Math.max(favW, dogW) / (favW + dogW);
    return {
      role: role,
      agreePct: takeAgreeFromShare(share),
      voters: voters,
    };
  }

  /**
   * My Line Take from every sport Book League book, weighted by BL rank.
   * Neon green = FAV, neon orange = DOG.
   */
  function takeTdrLabel(cell, side) {
    const t = cell && pxSideTdr(cell, side);
    return t && t.label ? t.label : '';
  }

  function takeCheapKey(gameEl, codes, bookCells, names, standings, favIdx, dogIdx) {
    let k = String(favIdx);
    if (!standings || !standings.rows) return k;
    k += '|' + (standings.updatedAt || '') + '|' + (standings.n || 0);
    for (let i = 0; i < standings.rows.length; i++) {
      const row = standings.rows[i];
      if (!row || !row.code) continue;
      const cell = bookCellForBlCode(codes, bookCells, names, row.code);
      if (!cell) continue;
      k +=
        '|' +
        row.code +
        ':' +
        takeTdrLabel(cell, favIdx) +
        '/' +
        takeTdrLabel(cell, dogIdx);
    }
    return k;
  }

  function applyCircaTakeToMyLine(gameEl, codes, bookCells, nOut, favIdx, names) {
    const fairCell = tradFairCell(gameEl);
    if (!fairCell) return;
    if (favIdx == null) {
      restoreCircaTakeOnGame(gameEl);
      return;
    }

    const teams = tradTeamNames(gameEl);
    if (teams.length < 2) {
      restoreCircaTakeOnGame(gameEl);
      return;
    }

    const homeIdx = nOut >= 3 ? 2 : 1;
    const dogIdx = favIdx === 0 ? homeIdx : 0;
    if (!names) names = tradBookHeaderNames();
    const sportKey = takeSportKeyForGame(gameEl);
    const standings = aggregateBookLeagueStandings(sportKey);
    const skipKey = takeCheapKey(gameEl, codes, bookCells, names, standings, favIdx, dogIdx);
    // Skip when fingerprint matches — including intentional blank.
    if (gameEl.dataset.pcTakeFp === skipKey) {
      return;
    }

    function noTake() {
      restoreCircaTakeOnGame(gameEl);
      gameEl.dataset.pcTakeFp = skipKey;
    }

    const verdict = takeFromWeightedBookLeague(
      gameEl,
      standings,
      codes,
      bookCells,
      names,
      favIdx,
      dogIdx
    );
    if (!verdict || !verdict.role) {
      noTake();
      return;
    }

    const role = verdict.role;
    const agreePct = verdict.agreePct;
    const takeSideIdx = role === 'fav' ? favIdx : dogIdx;
    const takeTeamIdx = outcomeToTeamIndex(takeSideIdx, nOut);
    if (takeTeamIdx == null) {
      restoreCircaTakeOnGame(gameEl);
      return;
    }
    const takeFull = teams[takeTeamIdx];
    const takeShort = teamCallSign(takeFull);
    if (!takeShort) {
      restoreCircaTakeOnGame(gameEl);
      return;
    }

    const roleLabel = role === 'fav' ? 'FAV' : 'DOG';
    const takeLabel = takeFull || takeShort;
    const text = 'Take ' + takeLabel + ' ' + roleLabel + ' · agree ' + agreePct + '%';
    const takeRole = role === 'fav' ? 'fav' : 'dog';
    if (
      fairCell.getAttribute('data-pc-take') === text &&
      fairCell.getAttribute('data-pc-take-role') === takeRole
    ) {
      gameEl.dataset.pcTakeFp = skipKey;
      return;
    }
    if (fairCell.dataset.pcFairTitle == null) {
      fairCell.dataset.pcFairTitle = fairCell.getAttribute('title') || '';
    }
    fairCell.classList.add('pc-circa-take');
    fairCell.setAttribute('data-pc-take', text);
    fairCell.setAttribute('data-pc-take-role', takeRole);
    fairCell.title = text;
    gameEl.dataset.pcTakeFp = skipKey;
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
    const nOut = tradOutcomeCount(gameEl);
    const favIdx = tradFavSideIndex(gameEl, nOut);
    if (favIdx == null) return empty;
    const openSides = tradCellSides(openCell);
    const curSides = tradCellSides(pinCell);
    const openAms = openSides.prices;
    const curAms = curSides.prices;
    const openLines = openSides.lines;
    const curLines = curSides.lines;
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
  function clearOtcOnGame(gameEl) {
    if (!gameEl) return;
    gameEl.querySelectorAll('.team.pc-otc-fav, .team.pc-otc-dog, .team[data-pc-otc]').forEach((el) => {
      el.classList.remove('pc-otc-fav', 'pc-otc-dog');
      el.removeAttribute('data-pc-otc');
      const name = el.querySelector('a.tName, .tName');
      if (name && name.dataset.pcOtcTitle != null) {
        if (name.dataset.pcOtcTitle) name.setAttribute('title', name.dataset.pcOtcTitle);
        else name.removeAttribute('title');
        delete name.dataset.pcOtcTitle;
      }
    });
    gameEl.querySelectorAll('.pc-otc-badge').forEach((n) => n.remove());
  }

  function markOtcTeamHighlights(gameEl, codes, bookCells, favIdx, dogIdx, nOut) {
    clearOtcOnGame(gameEl);
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
    teamEl.setAttribute('data-pc-otc', role);
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
    teamEl.title = tip;
  }

  function clearPinGapOnGame(gameEl) {
    if (!gameEl) return;
    gameEl.querySelectorAll('.px[data-pc-pingap], a.tName[data-pc-pingap], .tName[data-pc-pingap]').forEach((el) => {
      el.removeAttribute('data-pc-pingap');
      el.removeAttribute('data-pc-pg');
    });
  }

  /** Half-point = 24¢ (same as Market Sensitivity Tracker: 48¢ per full point). */
  const SPREAD_CENTS_PER_POINT = 48;

  function fmtLineAmShort(line, am) {
    const juice = fmtAmShort(am);
    if (line == null || !Number.isFinite(line)) return juice;
    const ls = line > 0 ? '+' + line : String(line);
    return ls + ' ' + juice;
  }

  /**
   * Per side: |Best − Pinny| in ¢. On spreads, juice ¢ + line move (24¢ per ½).
   * Badge = |gapA − gapB| on the larger-gap side.
   * ML: Mammoth −132 vs Pinny −139 (7¢), Leafs +129 vs +126 (3¢) → 4¢ on Mammoth.
   * Spread: +4 −105 vs +4.5 −105 → 24¢ (½ pt, same juice).
   */
  function markPinBestGap(gameEl, codes, bookCells, nOut) {
    clearPinGapOnGame(gameEl);
    if (!gameEl || !codes || !bookCells) return;
    const pinCell = pinnacleBookCell(gameEl, codes, bookCells);
    const bestCell =
      gameEl.querySelector(':scope > .cell.cBest') || gameEl.querySelector('.cell.cBest');
    if (!pinCell || !bestCell || pinCell.classList.contains('none') || bestCell.classList.contains('none')) {
      return;
    }
    if (nOut == null) nOut = tradOutcomeCount(gameEl);
    const favIdx = tradFavSideIndex(gameEl, nOut);
    const pinPrices = tradCellSidePrices(pinCell);
    const bestPrices = tradCellSidePrices(bestCell);
    const pinLines = tradCellSideLines(pinCell);
    const bestLines = tradCellSideLines(bestCell);
    const bestEls = tradCellSideEls(bestCell);
    const homeIdx = nOut >= 3 ? 2 : 1;
    const gaps = [];
    const sideIdxs = [0, homeIdx];
    for (let i = 0; i < sideIdxs.length; i++) {
      const idx = sideIdxs[i];
      const pin = pinPrices[idx];
      const best = bestPrices[idx];
      const pinC = americanCentsFromEven(pin);
      const bestC = americanCentsFromEven(best);
      if (pinC == null || bestC == null || !bestEls[idx]) continue;
      const pinLine = pinLines[idx];
      const bestLine = bestLines[idx];
      let gap = bestC - pinC;
      if (
        pinLine != null &&
        bestLine != null &&
        Number.isFinite(pinLine) &&
        Number.isFinite(bestLine)
      ) {
        // Higher algebraic line is better for that side; ½ pt = 24¢.
        gap += (bestLine - pinLine) * SPREAD_CENTS_PER_POINT;
      }
      gaps.push({
        sideIdx: idx,
        el: bestEls[idx],
        gap: Math.abs(gap),
        pin: pin,
        best: best,
        pinLine: pinLine,
        bestLine: bestLine,
      });
    }
    if (gaps.length < 2) return;
    const a = gaps[0];
    const b = gaps[1];
    const diff = Math.abs(a.gap - b.gap);
    if (!Number.isFinite(diff) || diff < 0.5) return;
    const host = a.gap > b.gap ? a : b.gap > a.gap ? b : null;
    if (!host || !host.el) return;
    const txt = Math.round(diff) + '¢';
    const role = favIdx != null && host.sideIdx === favIdx ? 'fav' : 'dog';
    if (host.el.getAttribute('data-pc-pingap') !== txt) host.el.setAttribute('data-pc-pingap', txt);
    if (host.el.getAttribute('data-pc-pg') !== role) host.el.setAttribute('data-pc-pg', role);
    const other = host === a ? b : a;
    const tip =
      'Best vs Pinnacle · ' +
      txt +
      ' (|' +
      Math.round(host.gap) +
      '−' +
      Math.round(other.gap) +
      '|¢) · on ' +
      role +
      ' · this ' +
      fmtLineAmShort(host.bestLine, host.best) +
      ' vs Pinny ' +
      fmtLineAmShort(host.pinLine, host.pin) +
      ' · other ' +
      fmtLineAmShort(other.bestLine, other.best) +
      ' vs Pinny ' +
      fmtLineAmShort(other.pinLine, other.pin);
    if (host.el.title !== tip) host.el.title = tip;
  }

  function gamePriceFp(gameEl) {
    if (!gameEl) return '';
    let s = '';
    const kids = gameEl.children;
    for (let i = 0; i < kids.length; i++) {
      const cell = kids[i];
      if (!cell.classList) continue;
      if (
        !cell.classList.contains('cBook') &&
        !cell.classList.contains('cOpen') &&
        !cell.classList.contains('cBest')
      ) {
        continue;
      }
      const pxs = cell.children;
      for (let j = 0; j < pxs.length; j++) {
        const px = pxs[j];
        if (!px.classList || !px.classList.contains('px')) continue;
        const bits = px.children;
        let saw = false;
        for (let k = 0; k < bits.length; k++) {
          const b = bits[k];
          if (!b.classList) continue;
          if (b.classList.contains('pr') || b.classList.contains('num')) {
            s += b.textContent || '';
            saw = true;
          }
        }
        if (!saw) {
          const al = px.getAttribute('aria-label');
          if (al) s += al.length > 36 ? al.slice(0, 36) : al;
        }
      }
    }
    return s;
  }

  function markPriceRanksOnTradBoard() {
    const codes = tradBookHeaderCodes();
    if (!codes.length) return;
    const names = tradBookHeaderNames();

    // One-shot: peel leftover visible TDR badges when nothing should paint.
    if (!tdrBadgesVisible() && !strippedVisibleTdrs) {
      strippedVisibleTdrs = true;
      document.querySelectorAll('.px[data-pc-rank]').forEach((px) => {
        hidePriceRankAttrs(px);
      });
      document.querySelectorAll('.pc-price-rank').forEach((n) => n.remove());
    }

    const games = tradBoardGames();
    const runAll = dirtyAllGames || dirtyGames.size === 0;
    games.forEach((gameEl) => {
      if (!runAll && !dirtyGames.has(gameEl)) return;
      const nOut = tradOutcomeCount(gameEl);
      const bookCells = Array.from(gameEl.querySelectorAll(':scope > .cell.cBook'));
      const fp = gamePriceFp(gameEl);
      const ranksReady = gameEl.getAttribute('data-pc-tdr') === '1';
      let cacheAlive = true;
      if (!DISPLAY_TDR_RANKS && ranksReady && bookCells[0]) {
        const sampleEls = tradCellSideEls(bookCells[0]);
        const sample = sampleEls[0] || sampleEls[1] || null;
        cacheAlive = !sample || tdrInfoByPx.has(sample);
      }
      if (
        fp &&
        gameEl.getAttribute('data-pc-odds-fp') === fp &&
        ranksReady &&
        cacheAlive &&
        (DISPLAY_TDR_RANKS
          ? !!gameEl.querySelector(':scope > .cell.cBook .px[data-pc-rank]')
          : true)
      ) {
        if (DISPLAY_TDR_BL_ENDS && !DISPLAY_TDR_RANKS) {
          const favCached = tradFavSideIndex(gameEl, nOut);
          const dogCached =
            favCached == null ? null : favCached === 0 ? (nOut >= 3 ? 2 : 1) : 0;
          paintBlEndTdrBadges(gameEl, codes, bookCells, names, favCached, dogCached);
        }
        markPinBestGap(gameEl, codes, bookCells, nOut);
        return;
      }
      if (fp) gameEl.setAttribute('data-pc-odds-fp', fp);
      const favIdx = tradFavSideIndex(gameEl, nOut);
      const n = Math.min(codes.length, bookCells.length);
      if (!n) return;

      if (favIdx == null) {
        gameEl.removeAttribute('data-pc-tdr');
        applyCircaTakeToMyLine(gameEl, codes, bookCells, nOut, null, names);
        markVertexBestGlow(gameEl, nOut, favIdx);
        markPinBestGap(gameEl, codes, bookCells, nOut);
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
        const sides = tradCellSides(cell);
        const prices = sides.prices;
        const lines = sides.lines;
        const els = sides.els;
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

      // Row still filling — leave My Line/prices alone until enough books land.
      if (favEntries.length < RANK_MIN_BOOKS_WHILE_LOADING) {
        gameEl.removeAttribute('data-pc-odds-fp');
        gameEl.removeAttribute('data-pc-tdr');
        return;
      }

      const useImplied = tradGameBothSidesNegative(gameEl, nOut);
      const favRanks = competitionRankMap(favEntries, useImplied);
      const dogRanks = competitionRankMap(dogEntries, useImplied);
      const drawRanks = competitionRankMap(drawEntries, useImplied);
      const keep = new Set();
      favRanks.forEach((info, el) => {
        const b = attachPriceRankBadge(el, info.rank, info.y, 'fav', info.joint);
        if (b) keep.add(b);
      });
      dogRanks.forEach((info, el) => {
        const b = attachPriceRankBadge(el, info.rank, info.y, 'dog', info.joint);
        if (b) keep.add(b);
      });
      drawRanks.forEach((info, el) => {
        const b = attachPriceRankBadge(el, info.rank, info.y, 'draw', info.joint);
        if (b) keep.add(b);
      });
      if (DISPLAY_TDR_RANKS) {
        gameEl.querySelectorAll(':scope > .cell.cBook .px[data-pc-rank]').forEach((px) => {
          if (!keep.has(px)) clearPriceRankOnPx(px);
        });
      } else if (DISPLAY_TDR_BL_ENDS) {
        paintBlEndTdrBadges(gameEl, codes, bookCells, names, favIdx, dogIdx);
      }
      gameEl.setAttribute('data-pc-tdr', '1');

      markOtcTeamHighlights(gameEl, codes, bookCells, favIdx, dogIdx, nOut);
      applyCircaTakeToMyLine(gameEl, codes, bookCells, nOut, favIdx, names);
      markVertexBestGlow(gameEl, nOut, favIdx);
      markPinBestGap(gameEl, codes, bookCells, nOut);
    });
    dirtyAllGames = false;
    dirtyGames.clear();
  }

  function parseHoldPct(el) {
    const t = String((el && el.textContent) || '')
      .replace(/\u2212/g, '-')
      .replace(/\s+/g, '');
    if (!t) return null;
    const m = t.match(/([+\-]?\d+(?:\.\d+)?)%/);
    if (!m) return null;
    const n = parseFloat(m[1]);
    return Number.isFinite(n) ? n : null;
  }

  function setHoldGlowClass(el, hcls) {
    if (!el) return;
    const tight = hcls === 'pc-hold-tight';
    const arb = hcls === 'pc-hold-arb';
    if (el.classList.contains('pc-hold-tight') !== tight) {
      el.classList.toggle('pc-hold-tight', tight);
    }
    if (el.classList.contains('pc-hold-arb') !== arb) {
      el.classList.toggle('pc-hold-arb', arb);
    }
    if (el.classList.contains('cHold')) {
      if (arb) el.setAttribute('data-darkreader-ignore', '');
      else el.removeAttribute('data-darkreader-ignore');
    }
  }

  function markHoldGlows() {
    tradBoardGames().forEach((gameEl) => {
      const holds = gameEl.querySelectorAll(':scope > .cell.cHold');
      let cls = '';
      holds.forEach((hold) => {
        let hcls = '';
        if (!hold.classList.contains('none')) {
          const pct = parseHoldPct(hold);
          if (pct != null) {
            if (pct < 0) hcls = 'pc-hold-arb';
            else if (pct <= 0.5) hcls = 'pc-hold-tight';
          }
        }
        setHoldGlowClass(hold, hcls);
        if (hcls) cls = hcls;
      });
      setHoldGlowClass(gameEl, cls);
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
    return [info.live ? 'live' : 'pre', info.sport || info.board || ''].join('|');
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
    return tradBookHeaderBundle().names;
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

  function gameDayHeaderEl(gameEl, opts) {
    if (!gameEl) return null;
    const wantTour = !!(opts && opts.tour);
    const skipTour = !!(opts && opts.skipTour);
    const match = (el) => {
      if (!el || !el.classList || !el.classList.contains('gDay')) return false;
      const isTour = el.classList.contains('tour');
      if (wantTour && !isTour) return false;
      if (skipTour && isTour) return false;
      return true;
    };
    const parent = gameEl.parentElement;
    if (parent) {
      const kids = Array.from(parent.children);
      const idx = kids.indexOf(gameEl);
      for (let i = idx - 1; i >= 0; i--) {
        if (match(kids[i])) return kids[i];
      }
    }
    let n = gameEl.previousElementSibling;
    while (n) {
      if (match(n)) return n;
      n = n.previousElementSibling;
    }
    return null;
  }

  function gameTourLeagueLabel(gameEl) {
    const t = gameDayHeaderText(gameDayHeaderEl(gameEl, { tour: true }));
    return t.replace(/\s+\d+\s+games?$/i, '').trim();
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
    if (
      /final|live|otp|ot\b|q\d|half|inning|top|bot|\bht\b|\bft\b|\d+\s*'|pen(?:alty)?/i.test(
        timeText
      )
    ) {
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
    const dayEl = gameDayHeaderEl(gameEl, { skipTour: true });
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
      // "12 Oct" / "12 October"
      const dm = dayText.match(
        /\b(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b/i
      );
      // "Oct 12" / "October 12" / "Oct 12, 2026"
      const md = !dm
        ? dayText.match(
            /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:,?\s*(\d{4}))?\b/i
          )
        : null;
      if (dm || md) {
        if (dm) {
          mo = months[dm[2].slice(0, 3).toLowerCase()];
          da = parseInt(dm[1], 10);
        } else {
          mo = months[md[1].slice(0, 3).toLowerCase()];
          da = parseInt(md[2], 10);
          if (md[3]) y = parseInt(md[3], 10);
        }
        const cand = new Date(y, mo, da, hour, min, 0, 0);
        if (!md || !md[3]) {
          if (cand.getTime() < now.getTime() - 40 * 86400000) y += 1;
        }
        dayResolved = true;
      }
    }
    // Football day+ boards: never guess "today" without a header (was pulling next week's NFL).
    // Daily sports / NCAAB openers often omit or reformat the day chip — assume today.
    if (!dayResolved) {
      const lg = gameLeagueLabel(gameEl) || gameTourLeagueLabel(gameEl);
      const info = routeInfo();
      const sk = sportKeyFromSnap({
        league: lg || (info && info.league) || '',
        sport: (info && (info.sport || info.board)) || '',
        teams: gameTeamNames(gameEl),
      });
      if (sk === 'NFL' || sk === 'NCAAF') return null;
      dayResolved = true;
    }
    return new Date(y, mo, da, hour, min, 0, 0).getTime();
  }

  function isGameStartWithinLeagueWindow(gameEl) {
    const startMs = parseGameStartMs(gameEl);
    if (startMs == null) return false;
    const now = Date.now();
    const lg = gameLeagueLabel(gameEl) || gameTourLeagueLabel(gameEl);
    const info = routeInfo();
    const sk = sportKeyFromSnap({
      league: lg || (info && info.league) || '',
      sport: (info && (info.sport || info.board)) || '',
      teams: gameTeamNames(gameEl),
    });
    const maxAhead = sk === 'SOCCER' ? BOOK_LEAGUE_MAX_START_AHEAD_MS_SOCCER : BOOK_LEAGUE_MAX_START_AHEAD_MS;
    if (startMs > now + maxAhead) return false;
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
    const favIdx = tradFavSideIndex(gameEl, nOut);
    if (favIdx == null) return null;
    const homeIdx = nOut >= 3 ? 2 : 1;
    const dogIdx = favIdx === 0 ? homeIdx : 0;

    const favEntries = [];
    const dogEntries = [];
    const perBook = [];
    for (let i = 0; i < n; i++) {
      const cell = bookCells[i];
      const sides = tradCellSides(cell);
      const prices = sides.prices;
      const lines = sides.lines;
      const els = sides.els;
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

    const infoEarly = routeInfo();
    const soccerBoard =
      String((infoEarly && (infoEarly.sport || infoEarly.board)) || '').toLowerCase() === 'soccer';
    const soccerRow =
      soccerBoard ||
      looksLikeSoccerLeague(gameLeagueLabel(gameEl) || gameTourLeagueLabel(gameEl));
    const minY = soccerRow ? BOOK_LEAGUE_MIN_Y_SOCCER : BOOK_LEAGUE_MIN_Y;
    if (favEntries.length < minY) return null;

    const useImplied = tradGameBothSidesNegative(gameEl, nOut);
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
    const sportRaw = info.sport || info.board || '';
    let leagueRaw = gameLeagueLabel(gameEl) || gameTourLeagueLabel(gameEl) || info.league || '';
    // Persist NCAAB even when .lg is blank/odd on basketball All (new season).
    const sk = sportKeyFromSnap({
      league: leagueRaw,
      sport: sportRaw,
      teams: teams.slice(0, 2),
    });
    if (sk === 'NCAAB' && !/NCAAB|CBB|NCAA|COLLEGE|MBB/i.test(leagueRaw)) {
      leagueRaw = 'NCAAB';
    }
    if (sk === 'SOCCER' && !leagueRaw) {
      leagueRaw = gameTourLeagueLabel(gameEl) || 'Soccer';
    }
    return {
      id: id,
      at: at,
      startAt: startAt,
      hourBucket: hourBucket(at),
      sport: sportRaw,
      league: leagueRaw,
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
    return zcodeHasGames(readZcodeLive(false));
  }

  /**
   * Take panel strength = ATS record (not win% /10).
   * MLB / NBA / NHL / NCAAB / WNBA → last 7 days ATS.
   * NFL / NCAAF → season ATS.
   */
  const STR_CACHE = Object.create(null);
  const STR_TTL_MS = 30 * 60 * 1000;
  const STR_INFLIGHT = Object.create(null);
  const STR_TEAM_DIR = Object.create(null);
  const STR_TEAM_DIR_INFLIGHT = Object.create(null);
  const STR_TEAM_ATS = Object.create(null);
  const STR_TEAM_ATS_INFLIGHT = Object.create(null);
  const STR_ODDS_CACHE = Object.create(null);
  const STR_ODDS_INFLIGHT = Object.create(null);
  const STR_ESPN_PATH = {
    MLB: 'baseball/mlb',
    NHL: 'hockey/nhl',
    NFL: 'football/nfl',
    NCAAF: 'football/college-football',
    NBA: 'basketball/nba',
    WNBA: 'basketball/wnba',
    NCAAB: 'basketball/mens-college-basketball',
  };
  const ATS_WEEKLY_SPORTS = {
    MLB: true,
    NBA: true,
    NHL: true,
    NCAAB: true,
    WNBA: true,
  };
  const ATS_WEEKLY_MS = 7 * 86400000;

  function atsIsWeekly(sportKey) {
    return !!ATS_WEEKLY_SPORTS[String(sportKey || '').toUpperCase()];
  }

  function atsWindowLabel(sportKey) {
    return atsIsWeekly(sportKey) ? '7d' : 'ATS';
  }

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

  function espnTeamsListUrl(sportKey) {
    const sk = String(sportKey || '').toUpperCase();
    const path = STR_ESPN_PATH[sk];
    if (!path) return null;
    let url = 'https://site.api.espn.com/apis/site/v2/sports/' + path + '/teams?limit=500';
    if (sk === 'NCAAF') url += '&groups=80';
    if (sk === 'NCAAB') url += '&groups=50';
    return url;
  }

  function parseEspnTeamsDir(text) {
    let json;
    try {
      json = JSON.parse(text);
    } catch (_) {
      return [];
    }
    const out = [];
    const leagues =
      (json.sports && json.sports[0] && json.sports[0].leagues) || json.leagues || [];
    for (let li = 0; li < leagues.length; li++) {
      const teams = leagues[li].teams || [];
      for (let i = 0; i < teams.length; i++) {
        const wrap = teams[i] || {};
        const team = wrap.team || wrap;
        const id = String(team.id || '');
        if (!id) continue;
        const names = [
          team.displayName,
          team.shortDisplayName,
          team.name,
          team.nickname,
          team.location,
          team.abbreviation,
        ]
          .map((x) => String(x || '').trim())
          .filter(Boolean);
        if (!names.length) continue;
        out.push({ id: id, names: names });
      }
    }
    return out;
  }

  function ensureEspnTeamDir(sportKey) {
    const sk = String(sportKey || '').toUpperCase();
    if (!sk || !STR_ESPN_PATH[sk]) return Promise.resolve([]);
    const cached = STR_TEAM_DIR[sk];
    if (cached && cached.at && Date.now() - cached.at < STR_TTL_MS * 4) {
      return Promise.resolve(cached.teams || []);
    }
    if (STR_TEAM_DIR_INFLIGHT[sk]) return STR_TEAM_DIR_INFLIGHT[sk];
    const url = espnTeamsListUrl(sk);
    STR_TEAM_DIR_INFLIGHT[sk] = gmGetText(url)
      .then((text) => {
        const teams = parseEspnTeamsDir(text);
        STR_TEAM_DIR[sk] = { at: Date.now(), teams: teams };
        delete STR_TEAM_DIR_INFLIGHT[sk];
        log('espn teams', sk, teams.length);
        return teams;
      })
      .catch((err) => {
        delete STR_TEAM_DIR_INFLIGHT[sk];
        log('espn teams fail', sk, err && err.message);
        return (cached && cached.teams) || [];
      });
    return STR_TEAM_DIR_INFLIGHT[sk];
  }

  /** Prefer exact / prefix match; never let "New Mexico" win via "New Mexico State". */
  function scoreStrengthNameMatch(want, cand) {
    if (!want || !cand) return 0;
    if (want === cand) return 100000 + cand.length;
    if (want + ' state' === cand || cand === want + ' state') return 0;
    if (cand.indexOf(want + ' state ') === 0 || cand === want + ' state') return 0;
    if (want.indexOf(cand + ' state ') === 0 || want === cand + ' state') return 0;
    if (cand.indexOf(want + ' ') === 0) return 50000 + want.length;
    if (want.indexOf(cand + ' ') === 0 && cand.length >= 4) return 20000 + cand.length;
    if (teamsMatch(want, cand)) return 10000 + Math.min(want.length, cand.length);
    return 0;
  }

  function resolveEspnTeamId(sportKey, teamName) {
    const sk = String(sportKey || '').toUpperCase();
    const dir = (STR_TEAM_DIR[sk] && STR_TEAM_DIR[sk].teams) || [];
    const want = normTeam(canonTeam(teamName, sk) || teamName);
    if (!want || !dir.length) return null;
    let best = null;
    let bestScore = 0;
    for (let i = 0; i < dir.length; i++) {
      const names = dir[i].names || [];
      for (let n = 0; n < names.length; n++) {
        const score = scoreStrengthNameMatch(want, normTeam(names[n]));
        if (score > bestScore) {
          bestScore = score;
          best = dir[i];
        }
      }
    }
    return best && bestScore >= 10000 ? best : null;
  }

  function homeSpreadFromOdds(odds) {
    if (!odds) return null;
    const home = odds.homeTeamOdds || {};
    const block = home.close || home.current || home.open || null;
    const ps = block && block.pointSpread;
    const raw =
      (ps && (ps.alternateDisplayValue || ps.american || ps.displayValue)) || '';
    let line = parseFloat(String(raw).replace(/[^0-9.+-]/g, ''));
    if (Number.isFinite(line)) return line;
    const spread = Number(odds.spread);
    if (!Number.isFinite(spread)) return null;
    if (home.favorite) return -Math.abs(spread);
    if (odds.awayTeamOdds && odds.awayTeamOdds.favorite) return Math.abs(spread);
    const details = String(odds.details || '');
    const m = details.match(/([+-]\d+(?:\.\d+)?)\s*$/);
    if (m) {
      const favLine = parseFloat(m[1]);
      if (!Number.isFinite(favLine)) return null;
      // details names the favorite's line; without side info treat as away-fav abs
      return odds.awayTeamOdds && odds.awayTeamOdds.favorite === false
        ? favLine
        : -favLine;
    }
    return null;
  }

  function atsCoverSide(awayScore, homeScore, homeLine) {
    if (
      !Number.isFinite(awayScore) ||
      !Number.isFinite(homeScore) ||
      !Number.isFinite(homeLine)
    ) {
      return null;
    }
    const adj = homeScore + homeLine - awayScore;
    if (Math.abs(adj) < 1e-9) return 'push';
    return adj > 0 ? 'home' : 'away';
  }

  function fetchEventOdds(sportKey, eventId, competitionId) {
    const sk = String(sportKey || '').toUpperCase();
    const path = STR_ESPN_PATH[sk];
    if (!path || !eventId || !competitionId) return Promise.resolve(null);
    const ck = sk + '|' + eventId;
    if (Object.prototype.hasOwnProperty.call(STR_ODDS_CACHE, ck)) {
      return Promise.resolve(STR_ODDS_CACHE[ck]);
    }
    if (STR_ODDS_INFLIGHT[ck]) return STR_ODDS_INFLIGHT[ck];
    const parts = path.split('/');
    const url =
      'https://sports.core.api.espn.com/v2/sports/' +
      parts[0] +
      '/leagues/' +
      parts[1] +
      '/events/' +
      eventId +
      '/competitions/' +
      competitionId +
      '/odds';
    STR_ODDS_INFLIGHT[ck] = gmGetText(url)
      .then((text) => {
        let json;
        try {
          json = JSON.parse(text);
        } catch (_) {
          json = null;
        }
        const item =
          json && Array.isArray(json.items) && json.items.length ? json.items[0] : null;
        STR_ODDS_CACHE[ck] = item;
        delete STR_ODDS_INFLIGHT[ck];
        return item;
      })
      .catch(() => {
        STR_ODDS_CACHE[ck] = null;
        delete STR_ODDS_INFLIGHT[ck];
        return null;
      });
    return STR_ODDS_INFLIGHT[ck];
  }

  function fmtAtsRecord(wins, losses, pushes) {
    const w = Math.round(wins || 0);
    const l = Math.round(losses || 0);
    const p = Math.round(pushes || 0);
    return p > 0 ? w + '-' + l + '-' + p : w + '-' + l;
  }

  async function computeTeamAts(sportKey, teamId, teamNames) {
    const sk = String(sportKey || '').toUpperCase();
    const path = STR_ESPN_PATH[sk];
    if (!path || !teamId) {
      return { raw: null, record: '', wins: 0, losses: 0, pushes: 0, names: teamNames || [] };
    }
    const weekly = atsIsWeekly(sk);
    const since = weekly ? Date.now() - ATS_WEEKLY_MS : 0;
    const url =
      'https://site.api.espn.com/apis/site/v2/sports/' +
      path +
      '/teams/' +
      teamId +
      '/schedule?seasontype=2';
    const text = await gmGetText(url);
    let json;
    try {
      json = JSON.parse(text);
    } catch (_) {
      json = null;
    }
    const events = (json && json.events) || [];
    let wins = 0;
    let losses = 0;
    let pushes = 0;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i] || {};
      const c = (ev.competitions || [])[0];
      if (!c) continue;
      const st = c.status && c.status.type;
      if (!(st && st.completed)) continue;
      const tip = Date.parse(ev.date || c.date || c.startDate || '');
      if (weekly && Number.isFinite(tip) && tip < since) continue;
      const comps = c.competitors || [];
      const home = comps.find((x) => x.homeAway === 'home');
      const away = comps.find((x) => x.homeAway === 'away');
      if (!home || !away) continue;
      const awayScore = Number(away.score && away.score.value != null ? away.score.value : away.score);
      const homeScore = Number(home.score && home.score.value != null ? home.score.value : home.score);
      if (!Number.isFinite(awayScore) || !Number.isFinite(homeScore)) continue;
      const myHome = String((home.team && home.team.id) || home.id || '') === String(teamId);
      const myAway = String((away.team && away.team.id) || away.id || '') === String(teamId);
      if (!myHome && !myAway) continue;
      const odds = await fetchEventOdds(sk, ev.id, c.id || ev.id);
      const homeLine = homeSpreadFromOdds(odds);
      if (homeLine == null) continue;
      const side = atsCoverSide(awayScore, homeScore, homeLine);
      if (!side) continue;
      if (side === 'push') {
        pushes += 1;
        continue;
      }
      const covered = (side === 'home' && myHome) || (side === 'away' && myAway);
      if (covered) wins += 1;
      else losses += 1;
    }
    const decided = wins + losses;
    const raw = decided > 0 ? wins / decided : null;
    return {
      raw: raw,
      record: decided || pushes ? fmtAtsRecord(wins, losses, pushes) : '',
      wins: wins,
      losses: losses,
      pushes: pushes,
      names: teamNames || [],
      weekly: weekly,
    };
  }

  function teamAtsCacheKey(sportKey, teamId) {
    return String(sportKey || '').toUpperCase() + '|' + String(teamId || '');
  }

  function ensureTeamAtsEntry(sportKey, teamName) {
    const sk = String(sportKey || '').toUpperCase();
    const hit = resolveEspnTeamId(sk, teamName);
    if (!hit) return Promise.resolve(null);
    const ck = teamAtsCacheKey(sk, hit.id);
    const cached = STR_TEAM_ATS[ck];
    if (cached && Date.now() - cached.at < STR_TTL_MS) return Promise.resolve(cached.entry);
    if (STR_TEAM_ATS_INFLIGHT[ck]) return STR_TEAM_ATS_INFLIGHT[ck];
    STR_TEAM_ATS_INFLIGHT[ck] = computeTeamAts(sk, hit.id, hit.names)
      .then((entry) => {
        STR_TEAM_ATS[ck] = { at: Date.now(), entry: entry };
        // Merge into sport pack for lookupStrengthEntry
        let pack = STR_CACHE[sk];
        if (!pack || !Array.isArray(pack.entries)) {
          pack = {
            at: Date.now(),
            source: 'espn-ats',
            weekly: atsIsWeekly(sk),
            entries: [],
          };
          STR_CACHE[sk] = pack;
        }
        const idx = pack.entries.findIndex(
          (e) => e && e.teamId && String(e.teamId) === String(hit.id)
        );
        const row = Object.assign({ teamId: hit.id }, entry);
        if (idx >= 0) pack.entries[idx] = row;
        else pack.entries.push(row);
        pack.at = Date.now();
        pack.weekly = atsIsWeekly(sk);
        delete STR_TEAM_ATS_INFLIGHT[ck];
        return entry;
      })
      .catch((err) => {
        delete STR_TEAM_ATS_INFLIGHT[ck];
        log('ats fail', sk, teamName, err && err.message);
        return null;
      });
    return STR_TEAM_ATS_INFLIGHT[ck];
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
    return bestScore >= 10000 ? best : null;
  }

  function fmtStrScore(record) {
    if (!record) return '—';
    return String(record);
  }

  function strTierClass(coverPct) {
    if (coverPct == null || !Number.isFinite(coverPct)) return 'na';
    if (coverPct >= 0.55) return 'hi';
    if (coverPct >= 0.45) return 'mid';
    return 'lo';
  }

  function attachStrengthToRecs(recs) {
    const rows = []
      .concat((recs && recs.favs) || [])
      .concat((recs && recs.dogs) || []);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const sk = r.sportKey;
      const hit = lookupStrengthEntry(sk, r.team);
      r.strRaw = hit && Number.isFinite(hit.raw) ? hit.raw : null;
      r.strRecord = hit && hit.record ? hit.record : '';
      r.strWeekly = atsIsWeekly(sk);
      r.strScore = r.strRaw; // cover % for tier coloring
    }
  }

  async function ensureStrengthForRecs(recs) {
    const rows = []
      .concat((recs && recs.favs) || [])
      .concat((recs && recs.dogs) || []);
    const bySport = Object.create(null);
    for (let i = 0; i < rows.length; i++) {
      const sk = String(rows[i].sportKey || '').toUpperCase();
      const team = rows[i].team;
      if (!sk || !team) continue;
      if (!bySport[sk]) bySport[sk] = [];
      bySport[sk].push(team);
    }
    const sports = Object.keys(bySport);
    if (!sports.length) return;
    await Promise.all(
      sports.map(async (sk) => {
        await ensureEspnTeamDir(sk);
        const uniq = Array.from(new Set(bySport[sk]));
        // Cap concurrency a bit for college boards
        const chunk = 4;
        for (let i = 0; i < uniq.length; i += chunk) {
          await Promise.all(uniq.slice(i, i + chunk).map((t) => ensureTeamAtsEntry(sk, t)));
        }
      })
    );
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

  function gameHoldPct(gameEl) {
    if (!gameEl) return null;
    const holds = gameEl.querySelectorAll(':scope > .cell.cHold');
    for (let i = 0; i < holds.length; i++) {
      const hold = holds[i];
      if (hold.classList.contains('none')) continue;
      const pct = parseHoldPct(hold);
      if (pct != null) return pct;
    }
    return null;
  }

  function takeRecFingerprint(recs) {
    const parts = [];
    const push = (role, rows) => {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        parts.push(
          role,
          r.gameId || '',
          r.team || '',
          r.hold != null ? String(r.hold) : '',
          r.ratio != null ? String(r.ratio) : '',
          r.againstTake != null ? String(r.againstTake) : '',
          r.otcSide || '',
          r.otcLabel || ''
        );
      }
    };
    push('f', (recs && recs.favs) || []);
    push('d', (recs && recs.dogs) || []);
    parts.push(recs && recs.steamBoost ? '1' : '0');
    return parts.join('\x1f');
  }

  function zRatioFromTeam(el) {
    if (!el) return null;
    const n = parseFloat(String(el.getAttribute('data-pc-zratio') || '').replace(/[^\d.]/g, ''));
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  }

  /** My Line cell must literally read Take X DOG or Take X FAV. */
  function myLineTakeRole(gameEl) {
    const fair = tradFairCell(gameEl);
    if (!fair) return null;
    const text = String(fair.getAttribute('data-pc-take') || '');
    const role = fair.getAttribute('data-pc-take-role');
    if (role === 'dog' && /^Take\s+.+\s+DOG\b/i.test(text)) return 'dog';
    if (role === 'fav' && /^Take\s+.+\s+FAV\b/i.test(text)) return 'fav';
    return null;
  }

  /**
   * Take picks (panel only; My Line overlay unchanged):
   *   hold ≤ +0.5% AND My Line says Take X DOG AND dog ratio ≤ fav ratio
   *   hold ≥ +1.5% AND fav ZCode ratio < 1 AND My Line says Take X FAV
   * When steamBoost: same list, sorted by how far O→C is from favoring the take
   * (most adverse steam first; O→C with the take sinks).
   */
  function collectTakeRatioRecs(opts) {
    const steamBoost = !!(opts && opts.steamBoost);
    const favs = [];
    const dogs = [];
    const zFresh = zcodeLiveIsFresh();
    const games = tradBoardGames();
    for (let gi = 0; gi < games.length; gi++) {
      const gameEl = games[gi];
      const hold = gameHoldPct(gameEl);
      if (hold == null) continue;

      let role = null;
      if (hold <= TAKE_REC_DOG_HOLD_MAX) role = 'dog';
      else if (hold >= TAKE_REC_FAV_HOLD_MIN) role = 'fav';
      else continue;
      // Dogs only when My Line says Take X DOG; favs only when it says Take X FAV.
      if (myLineTakeRole(gameEl) !== role) continue;

      const nOut = tradOutcomeCount(gameEl);
      const favIdx = tradFavSideIndex(gameEl, nOut);
      if (favIdx == null) continue;
      const homeIdx = nOut >= 3 ? 2 : 1;
      const dogIdx = favIdx === 0 ? homeIdx : 0;
      const takeSideIdx = role === 'fav' ? favIdx : dogIdx;
      const takeTeamIdx = outcomeToTeamIndex(takeSideIdx, nOut);
      if (takeTeamIdx == null) continue;
      const names = tradTeamNames(gameEl);
      if (!names || names.length < 2) continue;
      const team = names[takeTeamIdx];
      if (!team) continue;

      const favChip = gameEl.querySelector(
        ':scope > .cGame .team[data-pc-zrole="fav"], .team[data-pc-zrole="fav"]'
      );
      const dogChip = gameEl.querySelector(
        ':scope > .cGame .team[data-pc-zrole="dog"], .team[data-pc-zrole="dog"]'
      );
      const ratio = zRatioFromTeam(favChip);
      const dogRatio = zRatioFromTeam(dogChip);
      // Favs always need ratio < 1 (skip until ZCode is on the board).
      if (role === 'fav') {
        if (ratio == null || !(ratio < 1)) continue;
      }
      // Dogs: skip when the dog's % ratio is higher than the favorite's (Bruins case).
      if (role === 'dog' && dogRatio != null && ratio != null && dogRatio > ratio) continue;

      const otcMark = gameEl.querySelector('.team[data-pc-otc]');
      const otcSideRaw = otcMark ? otcMark.getAttribute('data-pc-otc') : '';
      const otcSide = otcSideRaw === 'fav' || otcSideRaw === 'dog' ? otcSideRaw : '';
      const otc = steamBoost
        ? readOtcMove(gameEl)
        : { againstDog: 0, againstFav: 0, favors: otcSide || null, label: '' };
      // + = O→C moved against the take (boost); − = O→C favored the take (sink)
      const againstTake =
        role === 'dog'
          ? (otc.againstDog || 0) - (otc.againstFav || 0)
          : (otc.againstFav || 0) - (otc.againstDog || 0);

      const gameId = String(gameEl.getAttribute('data-game') || gameEl.id || '');
      const tEl = gameEl.querySelector(
        ':scope > .cGame .tStar .t, :scope > .cGame .when .t, :scope > .cGame span.t, .cGame .t'
      );
      const time = String((tEl && tEl.textContent) || '')
        .replace(/\s+/g, ' ')
        .trim();
      const tipMs = tipSortMs(gameEl, time);
      const day = tipDayLabel(gameEl, tipMs);
      const sportKey = takeSportKeyForGame(gameEl);
      const opponent = pickTakeOpponent(team, names, sportKey);
      const row = {
        team: team,
        opponent: opponent,
        hold: hold,
        ratio: ratio,
        gameId: gameId,
        gameEl: gameEl,
        time: time,
        day: day,
        tipMs: tipMs,
        boardIdx: gi,
        otcSide: otcSide,
        otcFavors: otc.favors,
        againstDog: otc.againstDog || 0,
        againstFav: otc.againstFav || 0,
        againstTake: againstTake,
        otcLabel: otc.label || '',
        sportKey: sportKey,
        strRaw: null,
        strScore: null,
        strRecord: '',
        strWeekly: atsIsWeekly(sportKey),
      };
      if (role === 'fav') favs.push(row);
      else dogs.push(row);
    }
    const byTip = (a, b) =>
      a.tipMs - b.tipMs ||
      a.boardIdx - b.boardIdx ||
      (a.hold != null && b.hold != null ? a.hold - b.hold : 0);
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
      requireRatio: true,
      zFresh: zFresh,
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
    const wasCollapsed = wrap.classList.contains('pc-tr-collapsed');
    wrap.classList.toggle('pc-tr-collapsed', !!collapsed);
    const tog = wrap.querySelector('.pc-tr-tog');
    if (tog) tog.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    try {
      sessionStorage.setItem('pcTakeRecCollapsed', collapsed ? '1' : '0');
    } catch (_) {}
    // Expanding: force a body paint (collapsed path only updates the title count).
    if (wasCollapsed && !collapsed) {
      takeRecLastFp = '';
      scheduleTakeRecRefresh(0);
    }
  }

  function ensureTakeRecUi() {
    if (!IS_4C || !TAKE_REC_PANEL_ENABLED) {
      const old = document.getElementById(TAKE_REC_UI_ID);
      if (old) old.remove();
      return null;
    }
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
    sub.textContent = 'Take DOG ≤+0.5% · Take FAV ≥+1.5% + ratio <1';
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
    // Always start minimised; session can expand for this tab only.
    let preferCollapsed = true;
    try {
      const saved = sessionStorage.getItem('pcTakeRecCollapsed');
      if (saved === '0') preferCollapsed = false;
      if (saved === '1') preferCollapsed = true;
    } catch (_) {}
    setTakeRecCollapsed(wrap, preferCollapsed);
    (document.body || document.documentElement).appendChild(wrap);
    return wrap;
  }

  function takeRecOtcMark(side) {
    const otcEl = document.createElement('span');
    otcEl.className = 'pc-tr-otc ' + side;
    otcEl.textContent = 'O->C';
    otcEl.title = side === 'fav' ? 'O->C → FAV' : 'O->C → DOG';
    return otcEl;
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
        const atsLabel = fmtStrScore(r.strRecord);
        const atsScope = r.strWeekly ? '7d ATS' : 'Season ATS';
        const coverBit =
          r.strRaw != null && Number.isFinite(r.strRaw)
            ? ' · ' + Math.round(r.strRaw * 1000) / 10 + '% cover'
            : '';
        btn.title =
          whenLabel +
          ' · ' +
          atsScope +
          ' ' +
          atsLabel +
          coverBit +
          ' · Take ' +
          r.team +
          (r.opponent ? ' vs ' + r.opponent : '') +
          ' ' +
          (role === 'fav' ? 'FAV' : 'DOG') +
          (r.hold != null ? ' · hold ' + (r.hold > 0 ? '+' : '') + r.hold + '%' : '') +
          (r.ratio != null ? ' · fav ratio ' + fmtRatioChip(r.ratio) : '') +
          (r.otcSide ? ' · O->C ' + (r.otcSide === 'fav' ? 'FAV' : 'DOG') : '') +
          (r.otcLabel ? ' · O→C ' + r.otcLabel : '');
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
        const showStr = !!(r.strRecord || (r.strRaw != null && Number.isFinite(r.strRaw)));
        const main = document.createElement('span');
        main.className = 'pc-tr-main';
        const takeWord = document.createElement('span');
        takeWord.className = 'pc-tr-take';
        takeWord.textContent = 'Take';
        const team = document.createElement('span');
        team.className = 'pc-tr-team';
        team.textContent = r.team;
        if (r.otcSide === role) team.appendChild(takeRecOtcMark(r.otcSide));
        const roleEl = document.createElement('span');
        roleEl.className = 'pc-tr-role';
        roleEl.textContent = role === 'fav' ? 'FAV' : 'DOG';
        main.appendChild(takeWord);
        main.appendChild(team);
        main.appendChild(roleEl);
        const meta = document.createElement('span');
        meta.className = 'pc-tr-meta';
        meta.appendChild(whenWrap);
        if (showStr) {
          const strEl = document.createElement('span');
          strEl.className = 'pc-tr-str ' + strTierClass(r.strRaw);
          strEl.title = atsScope + (r.strRecord ? ' · ' + r.strRecord : '') + coverBit;
          const strNum = document.createElement('span');
          strNum.className = 'pc-tr-str-num';
          strNum.textContent = atsLabel;
          const strDen = document.createElement('span');
          strDen.className = 'pc-tr-str-den';
          strDen.textContent = atsWindowLabel(r.sportKey);
          strEl.appendChild(strNum);
          strEl.appendChild(strDen);
          meta.appendChild(strEl);
        }
        if (r.opponent) {
          const opp = document.createElement('span');
          opp.className = 'pc-tr-opp';
          opp.textContent = 'vs ' + r.opponent;
          if (r.otcSide && r.otcSide !== role) opp.appendChild(takeRecOtcMark(r.otcSide));
          meta.appendChild(opp);
        }
        if (r.hold != null) {
          const holdEl = document.createElement('span');
          holdEl.className =
            'pc-tr-hold' +
            (r.hold < 0 ? ' arb' : r.hold <= TAKE_REC_DOG_HOLD_MAX ? ' tight' : ' wide');
          holdEl.textContent =
            (r.hold > 0 ? '+' : '') +
            (Math.round(r.hold * 100) / 100) +
            '%';
          holdEl.title = 'Hold ' + holdEl.textContent;
          meta.appendChild(holdEl);
        }
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
          meta.appendChild(move);
        }
        if (r.ratio != null) {
          const ratio = document.createElement('span');
          const tier = takeRecRatioTier(r.ratio);
          ratio.className = 'pc-tr-ratio ' + tier;
          ratio.textContent = fmtRatioChip(r.ratio);
          meta.appendChild(ratio);
        }
        btn.appendChild(main);
        btn.appendChild(meta);
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

    const favLabel = recs.steamBoost
      ? 'Take X FAV · hold ≥+1.5% · ratio <1 · O→C'
      : 'Take X FAV · hold ≥+1.5% · ratio <1';
    const dogLabel = recs.steamBoost
      ? 'Take X DOG · hold ≤+0.5% · ratio ≤ fav · O→C'
      : 'Take X DOG · hold ≤+0.5% · ratio ≤ fav';
    const emptyTxt = 'None right now';
    // Dogs first (tight/arb hold is the main use case)
    if (recs.steamBoost) {
      renderTakeRecSection(next, dogLabel, 'dog', recs.dogs, emptyTxt, true);
      renderTakeRecSection(next, favLabel, 'fav', recs.favs, emptyTxt, true);
    } else {
      renderTakeRecSection(next, dogLabel, 'dog', recs.dogs, emptyTxt, false);
      renderTakeRecSection(next, favLabel, 'fav', recs.favs, emptyTxt, false);
    }
    body.textContent = '';
    body.appendChild(next);
  }

  function scheduleTakeRecRefresh(ms) {
    if (!TAKE_REC_PANEL_ENABLED || !IS_4C) return;
    if (takeRecRefreshTimer) clearTimeout(takeRecRefreshTimer);
    takeRecRefreshTimer = setTimeout(() => {
      takeRecRefreshTimer = 0;
      refreshTakeRecPanel();
    }, ms == null ? 180 : ms);
  }

  function refreshTakeRecPanel() {
    if (!IS_4C || !TAKE_REC_PANEL_ENABLED) {
      const old = document.getElementById(TAKE_REC_UI_ID);
      if (old) old.remove();
      takeRecLastFp = '';
      return;
    }
    const wrap = ensureTakeRecUi();
    if (!wrap) return;
    const body = wrap.querySelector('.pc-tr-body');
    if (!body) return;
    const collapsed = wrap.classList.contains('pc-tr-collapsed');
    const recs = collectTakeRatioRecs({ steamBoost: takeRecSteamBoost });
    const n = (recs.favs.length || 0) + (recs.dogs.length || 0);
    const title = wrap.querySelector('.pc-tr-title');
    const sub = wrap.querySelector('.pc-tr-sub');
    if (title) title.textContent = n ? 'Take picks · ' + n : 'Take picks';
    if (sub) {
      if (recs.steamBoost) {
        sub.textContent = 'O→C · Take DOG ≤+0.5 · Take FAV ≥+1.5 + ratio<1';
      } else if (!recs.zFresh) {
        sub.textContent = 'Take DOG ≤+0.5 · Take FAV needs ratio<1';
      } else {
        sub.textContent = 'Take DOG ≤+0.5 · Take FAV ≥+1.5 + ratio<1';
      }
    }
    // Collapsed: title count only — no DOM rebuild / ATS work.
    if (collapsed) {
      takeRecLastFp = '';
      return;
    }
    const fp = takeRecFingerprint(recs) + '|exp';
    if (fp === takeRecLastFp && body.childNodes.length) return;
    takeRecLastFp = fp;
    // Cache-only ATS (no ESPN storm from the panel).
    attachStrengthToRecs(recs);
    const headZ = wrap.querySelector('.pc-tr-zcode-head');
    if (headZ) {
      const sports = boardZcodeSportsNeeded();
      headZ.title =
        'Open ZCode for ' + (sports.length ? sports.join(' + ') : 'this board');
    }
    paintTakeRecBody(body, recs);
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
      let snaps = Array.isArray(payload.snaps) ? payload.snaps.slice() : [];
      const cur = window.__BOOK_LEAGUE_DATA__;
      if (cur && Array.isArray(cur.snaps) && countGradedSnaps(snaps) < countGradedSnaps(cur.snaps)) {
        // Never paint a weaker local cache over a richer Pages/GitHub payload.
        snaps = mergeLeagueSnaps(snaps, cur.snaps);
      }
      const data = {
        updatedAt: payload.updatedAt || null,
        snaps: snaps,
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

  function countGradedSnaps(snaps) {
    let n = 0;
    (snaps || []).forEach((s) => {
      if (blSnapIsGraded(s)) n++;
    });
    return n;
  }

  /** Prefer whichever side has cover/spread/scores; never let ungraded local wipe graded file/GitHub. */
  function mergeSnapPair(prev, next) {
    if (!prev) return next;
    if (!next) return prev;
    const prevGraded = blSnapIsGraded(prev);
    const nextGraded = blSnapIsGraded(next);
    const newer = (Number(next.at) || 0) >= (Number(prev.at) || 0) ? next : prev;
    const older = newer === next ? prev : next;
    const gradedSrc = nextGraded ? next : prevGraded ? prev : null;
    const spreadSrc =
      newer.spread != null
        ? newer
        : older.spread != null
          ? older
          : null;
    const base = Object.assign({}, older, newer);
    if (gradedSrc) {
      base.coverTeamIdx = gradedSrc.coverTeamIdx;
      base.gradeKind = gradedSrc.gradeKind;
      base.favCovered = gradedSrc.favCovered;
      base.gradedAt = gradedSrc.gradedAt;
      if (gradedSrc.winnerTeamIdx != null) base.winnerTeamIdx = gradedSrc.winnerTeamIdx;
    } else if (prev.winnerTeamIdx != null && base.winnerTeamIdx == null) {
      base.winnerTeamIdx = prev.winnerTeamIdx;
    }
    if (spreadSrc) {
      base.spread = spreadSrc.spread;
      if (spreadSrc.awayLine != null) base.awayLine = spreadSrc.awayLine;
      if (spreadSrc.homeLine != null) base.homeLine = spreadSrc.homeLine;
    }
    if (base.awayScore == null && older.awayScore != null) base.awayScore = older.awayScore;
    if (base.homeScore == null && older.homeScore != null) base.homeScore = older.homeScore;
    if (!base.status && older.status) base.status = older.status;
    if (!base.open && older.open) base.open = older.open;
    return base;
  }

  function mergeLeagueSnaps(existing, incoming) {
    const byKey = new Map();
    (existing || []).forEach((s) => {
      if (s && s.id) byKey.set(snapStoreKey(s), s);
    });
    (incoming || []).forEach((s) => {
      if (!s || !s.id) return;
      const k = snapStoreKey(s);
      byKey.set(k, mergeSnapPair(byKey.get(k), s));
    });
    // Same game/market can exist under different `at` keys; keep the graded copy when prune drops one.
    const groups = new Map();
    byKey.forEach((s) => {
      const gk = gameMarketKey(s);
      if (!groups.has(gk)) groups.set(gk, []);
      groups.get(gk).push(s);
    });
    groups.forEach((list) => {
      if (list.length < 2) return;
      const best = list.reduce((a, b) => {
        const ag = blSnapIsGraded(a);
        const bg = blSnapIsGraded(b);
        if (ag !== bg) return ag ? a : b;
        const as = a.spread != null;
        const bs = b.spread != null;
        if (as !== bs) return as ? a : b;
        return (Number(a.at) || 0) >= (Number(b.at) || 0) ? a : b;
      });
      list.forEach((s) => {
        if (s === best) return;
        const k = snapStoreKey(s);
        byKey.set(k, mergeSnapPair(s, best));
      });
    });
    return pruneRollingHourSnaps(Array.from(byKey.values()));
  }

  /** NBA nicknames — used to keep college games on basketball/All out of the NBA bucket. */
  const NBA_NICK_RE =
    /\b(hawks|celtics|nets|hornets|bulls|cavaliers?|mavericks|nuggets|pistons|warriors|rockets|pacers|clippers|lakers|grizzlies|heat|bucks|timberwolves|pelicans|knicks|thunder|magic|76ers|sixers|suns|trail\s*blazers|blazers|kings|spurs|raptors|jazz|wizards)\b/i;

  function looksLikeNbaTeams(teams) {
    if (!Array.isArray(teams) || teams.length < 2) return false;
    let hits = 0;
    for (let i = 0; i < teams.length; i++) {
      if (NBA_NICK_RE.test(String(teams[i] || ''))) hits++;
    }
    return hits >= 2;
  }

  function looksLikeSoccerLeague(league) {
    const lg = String(league || '');
    if (!lg) return false;
    if (
      /CHAMPIONS\s*LEAGUE|EUROPA\s*LEAGUE|CONFERENCE\s*LEAGUE|PREMIER\s*LEAGUE|LA\s*LIGA|SERIE\s*A|LIGUE\s*1|BUNDESLIGA|EREDIVISIE|PRIMEIRA|JUPILER|BRASILEIR|SERIE\s*B|MLS\b|LIGA\s*MX|PRIMERA|SUPER\s*LIG|SUPERLIGA|ALLSVENSKAN|ELITESERIEN|J\.?\s*LEAGUE|K\s*LEAGUE|A-?LEAGUE|SCOTTISH\s*PREM|SUPER\s*LEAGUE|NATIONS\s*LEAGUE|COPA\s|CHAMPIONSHIP|LEAGUE\s*ONE|LEAGUE\s*1\b|HNL\b|EKSTRAKLASA|NB\s*1|USL\b|CANADIAN\s*PREM/i.test(
        lg
      )
    ) {
      return true;
    }
    return false;
  }

  function sportKeyFromSnap(s) {
    const league = String((s && s.league) || '').toUpperCase();
    const sport = String((s && s.sport) || '').toLowerCase();
    if (sport === 'soccer' || sport === 'football-soccer' || sport === 'football soccer') {
      return 'SOCCER';
    }
    if (looksLikeSoccerLeague(league) && sport !== 'football' && sport !== 'nfl' && sport !== 'ncaaf') {
      return 'SOCCER';
    }
    if (/MLB|SERIES/i.test(league) || sport === 'baseball' || sport === 'mlb') return 'MLB';
    if (/NHL/i.test(league) || sport === 'hockey' || sport === 'nhl') return 'NHL';
    // League-specific BEFORE generic sport: /football/ncaaf stores sport="football"
    if (/NCAAF|CFB/i.test(league) || sport === 'ncaaf') return 'NCAAF';
    // New-season / All-board labels: NCAA, College Basketball, MBB, CBB, …
    if (
      /NCAAB|CBB|\bMBB\b|NCAA\s*B\b|NCAA\s*BASKET|COLLEGE\s*BASKET|MEN'?S\s*BASKET|MEN'?S\s*COLLEGE/i.test(
        league
      ) ||
      sport === 'ncaab' ||
      sport === 'cbb'
    ) {
      return 'NCAAB';
    }
    if (/WNBA/i.test(league) || sport === 'wnba') return 'WNBA';
    if (/NFL/i.test(league) || sport === 'football' || sport === 'nfl') return 'NFL';
    // \bNBA\b so "NBA Cup" / "NBA IST" count as NBA (WNBA already returned above)
    if (/\bNBA\b/i.test(league) || sport === 'basketball' || sport === 'nba') {
      // Basketball All board with missing/odd .lg: college teams → NCAAB, not NBA.
      if (
        !/\bNBA\b/i.test(league) &&
        (sport === 'basketball' || sport === 'nba' || !sport) &&
        Array.isArray(s && s.teams) &&
        s.teams.length >= 2 &&
        !looksLikeNbaTeams(s.teams)
      ) {
        return 'NCAAB';
      }
      return 'NBA';
    }
    return null;
  }

  /** Hot / missing league: probe sports so finished games still grade. */
  function sportKeysToTry(s) {
    const k = sportKeyFromSnap(s);
    if (k) return [k];
    const sport = String((s && s.sport) || '').toLowerCase();
    if (sport === 'soccer' || looksLikeSoccerLeague((s && s.league) || '')) return ['SOCCER'];
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

  /** 4C soccer tour labels → ESPN soccer league slug (unknown still try ESPN all + other sources). */
  function espnSoccerSlug(league) {
    const lg = String(league || '')
      .toLowerCase()
      .replace(/['’]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!lg) return null;
    const rows = [
      [/champions league/, 'uefa.champions'],
      [/europa conference|conference league/, 'uefa.europa.conf'],
      [/europa league/, 'uefa.europa'],
      [/nations league/, 'uefa.nations'],
      [/premier league/, 'eng.1'],
      [/\bchampionship\b/, 'eng.2'],
      [/league one|england league 1/, 'eng.3'],
      [/la liga 2/, 'esp.2'],
      [/la liga/, 'esp.1'],
      [/brasileir|brazil serie a/, 'bra.1'],
      [/brazil serie b/, 'bra.2'],
      [/serie a/, 'ita.1'],
      [/serie b/, 'ita.2'],
      [/ligue 2/, 'fra.2'],
      [/ligue 1/, 'fra.1'],
      [/2\.?\s*bundesliga/, 'ger.2'],
      [/bundesliga/, 'ger.1'],
      [/eredivisie/, 'ned.1'],
      [/jupiler/, 'bel.1'],
      [/primeira liga/, 'por.1'],
      [/\bmls\b/, 'usa.1'],
      [/liga mx/, 'mex.1'],
      [/argentina primera/, 'arg.1'],
      [/peru primera/, 'per.1'],
      [/colombia primera/, 'col.1'],
      [/ecuador serie a/, 'ecu.1'],
      [/paraguay/, 'par.1'],
      [/chile primera/, 'chi.1'],
      [/bolivia/, 'bol.1'],
      [/\bj\.?\s*league/, 'jpn.1'],
      [/k league/, 'kor.1'],
      [/a league/, 'aus.1'],
      [/super lig|süper lig/, 'tur.1'],
      [/ekstraklasa/, 'pol.1'],
      [/eliteserien/, 'nor.1'],
      [/allsvenskan/, 'swe.1'],
      [/scottish prem/, 'sco.1'],
      [/switzerland super/, 'sui.1'],
      [/austria bundesliga/, 'aut.1'],
      [/danish superliga/, 'den.1'],
      [/greece super/, 'gre.1'],
      [/hungary nb/, 'hun.1'],
      [/croatia hnl/, 'cro.1'],
      [/russian premier/, 'rus.1'],
      [/saudi/, 'ksa.1'],
      [/china super/, 'chn.1'],
      [/usl championship/, 'usa.usl.1'],
      [/canadian premier/, 'can.1'],
    ];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][0].test(lg)) return rows[i][1];
    }
    return null;
  }

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

  async function fetchEspnScoreboard(sportKey, dateCompact, soccerSlug) {
    let path = ESPN_SPORT_PATH[sportKey];
    if (sportKey === 'SOCCER') {
      if (!soccerSlug) return [];
      path = 'soccer/' + soccerSlug;
    }
    if (!path || !dateCompact) return [];
    let url =
      'https://site.api.espn.com/apis/site/v2/sports/' + path + '/scoreboard?dates=' + dateCompact;
    if (sportKey === 'NCAAF') url += '&groups=80&limit=500';
    if (sportKey === 'NCAAB') url += '&groups=50&limit=500';
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
    return /postpon|cancel|suspend|washout|abandoned/i.test(String(status || ''));
  }

  const SCOREBOARD_MEMO = new Map();
  const SCOREBOARD_MEMO_MS = 8 * 60 * 1000;

  async function memoScoreboard(key, fn) {
    const now = Date.now();
    const prev = SCOREBOARD_MEMO.get(key);
    if (prev && now - prev.at < SCOREBOARD_MEMO_MS) return prev.events;
    let events = [];
    try {
      events = await fn();
    } catch (_) {
      if (prev) return prev.events;
      events = [];
    }
    SCOREBOARD_MEMO.set(key, { at: now, events: events });
    return events;
  }

  function soccerLooseCanon(s) {
    return String(canonTeam(s) || '')
      .replace(/\b(fc|cf|sc|ac|afc|ssc|cd|ca|fk|sk|bk|if|ud|ad|rcd|rc)\b/g, ' ')
      .replace(/\b(club|clube|de|da|do|the)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function matchScoreEventForSnap(s, events) {
    const direct = matchEspnEventForSnap(s, events);
    if (direct) return direct;
    const teams = Array.isArray(s.teams) ? s.teams : [];
    if (teams.length < 2) return null;
    const a = soccerLooseCanon(teams[0]);
    const h = soccerLooseCanon(teams[1]);
    if (!a || !h) return null;
    for (let j = 0; j < events.length; j++) {
      const e = events[j];
      const ea = soccerLooseCanon(e.awayCanon) || soccerLooseCanon(e.awayShort) || soccerLooseCanon(e.awayAbbr);
      const eh = soccerLooseCanon(e.homeCanon) || soccerLooseCanon(e.homeShort) || soccerLooseCanon(e.homeAbbr);
      if (ea && eh && blNameMatch(a, ea) && blNameMatch(h, eh)) return { ev: e, orient: 'ah' };
      if (ea && eh && blNameMatch(a, eh) && blNameMatch(h, ea)) return { ev: e, orient: 'ha' };
    }
    return null;
  }

  function applyMatchedScore(s, hit, drop) {
    const ev = hit && hit.ev;
    if (!ev) return false;
    if (!ev.completed) {
      if (isEspnPostponedStatus(ev.status)) {
        drop.add(s);
        return false;
      }
      if (ev.status) s.status = ev.status;
      return false;
    }
    if (ev.awayScore == null || ev.homeScore == null) return false;
    s.awayScore = ev.awayScore;
    s.homeScore = ev.homeScore;
    s.status = ev.status || 'Final';

    if (ev.awayScore === ev.homeScore) {
      s.winnerTeamIdx = 'void';
    } else {
      const awayWon = ev.awayScore > ev.homeScore;
      s.winnerTeamIdx = hit.orient === 'ah' ? (awayWon ? 0 : 1) : awayWon ? 1 : 0;
    }

    if (!blApplyCoverGrade(s, ev.awayScore, ev.homeScore, hit.orient)) {
      return false;
    }
    s.gradedAt = Date.now();
    return true;
  }

  function parseFourCBoardScoreEvent(gameEl) {
    if (!gameEl) return null;
    const scoreEl = gameEl.querySelector(':scope > .cGame .score, :scope > .cGame b.score');
    if (!scoreEl) return null;
    const raw = String(scoreEl.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();
    const m = raw.match(/(\d+)\s*[-–—:/]\s*(\d+)/);
    if (!m) return null;
    const tEl = gameEl.querySelector(
      ':scope > .cGame .tStar .t, :scope > .cGame .when .t, :scope > .cGame span.t'
    );
    const timeText = String((tEl && tEl.textContent) || '')
      .replace(/\s+/g, ' ')
      .trim();
    const status = timeText || raw;
    if (isEspnPostponedStatus(status)) {
      return {
        completed: false,
        status: status,
        awayCanon: '',
        homeCanon: '',
        awayAbbr: '',
        homeAbbr: '',
        awayShort: '',
        homeShort: '',
        awayScore: null,
        homeScore: null,
      };
    }
    if (!/\b(ft|aet|final|ended|full.?time|pen(?:alty)?s?)\b/i.test(status)) return null;
    const teams = gameTeamNames(gameEl);
    const a = Number(m[1]);
    const h = Number(m[2]);
    if (!Number.isFinite(a) || !Number.isFinite(h)) return null;
    return {
      completed: true,
      status: status || 'FT',
      awayCanon: canonTeam(teams[0] || ''),
      homeCanon: canonTeam(teams[1] || ''),
      awayAbbr: '',
      homeAbbr: '',
      awayShort: canonTeam(teams[0] || ''),
      homeShort: canonTeam(teams[1] || ''),
      awayScore: a,
      homeScore: h,
    };
  }

  function matchBoardScoreForSnap(s) {
    if (!IS_4C || typeof tradBoardGames !== 'function') return null;
    const games = tradBoardGames();
    const id = String((s && s.id) || '');
    let el = null;
    if (id) {
      for (let i = 0; i < games.length; i++) {
        if (gameIdFromEl(games[i]) === id) {
          el = games[i];
          break;
        }
      }
    }
    if (el) {
      const ev = parseFourCBoardScoreEvent(el);
      if (ev) return matchScoreEventForSnap(s, [ev]) || { ev: ev, orient: 'ah' };
    }
    const events = [];
    for (let i = 0; i < games.length; i++) {
      const ev = parseFourCBoardScoreEvent(games[i]);
      if (ev) events.push(ev);
    }
    return matchScoreEventForSnap(s, events);
  }

  function gmJson(url) {
    return gmRequest({
      method: 'GET',
      url: url,
      timeout: 30000,
      headers: { Accept: 'application/json' },
    }).then((res) => {
      if (res.status < 200 || res.status >= 300) return null;
      try {
        return JSON.parse(res.responseText);
      } catch (_) {
        return null;
      }
    });
  }

  function normScoreEvent(opts) {
    const awayScore = Number(opts.awayScore);
    const homeScore = Number(opts.homeScore);
    return {
      completed: !!opts.completed,
      status: opts.status || '',
      awayCanon: canonTeam(opts.awayName || ''),
      homeCanon: canonTeam(opts.homeName || ''),
      awayAbbr: canonTeam(opts.awayAbbr || ''),
      homeAbbr: canonTeam(opts.homeAbbr || ''),
      awayShort: canonTeam(opts.awayShort || opts.awayName || ''),
      homeShort: canonTeam(opts.homeShort || opts.homeName || ''),
      awayScore: Number.isFinite(awayScore) ? awayScore : null,
      homeScore: Number.isFinite(homeScore) ? homeScore : null,
    };
  }

  async function fetchFotmobSoccer(dateCompact) {
    if (!dateCompact) return [];
    const urls = [
      'https://www.fotmob.com/api/data/matches?date=' +
        dateCompact +
        '&timezone=' +
        encodeURIComponent('America/New_York'),
      'https://www.fotmob.com/api/matches?date=' + dateCompact,
    ];
    for (let u = 0; u < urls.length; u++) {
      const j = await gmJson(urls[u]);
      const leagues = (j && (j.leagues || (j.data && j.data.leagues))) || [];
      if (!leagues.length) continue;
      const out = [];
      leagues.forEach((lg) => {
        (lg.matches || []).forEach((m) => {
          const home = m.home || {};
          const away = m.away || {};
          const st = m.status || {};
          const reason = (st.reason && (st.reason.short || st.reason.long)) || '';
          const status = reason || st.scoreStr || '';
          const cancelled = !!(st.cancelled || isEspnPostponedStatus(status) || isEspnPostponedStatus(reason));
          const homeScore = home.score != null ? Number(home.score) : Number(m.homeScore);
          const awayScore = away.score != null ? Number(away.score) : Number(m.awayScore);
          out.push(
            normScoreEvent({
              completed: !!st.finished && !cancelled,
              status: cancelled ? status || 'Cancelled' : status || (st.finished ? 'FT' : ''),
              awayName: away.longName || away.name,
              homeName: home.longName || home.name,
              awayShort: away.name,
              homeShort: home.name,
              awayScore: awayScore,
              homeScore: homeScore,
            })
          );
        });
      });
      if (out.length) return out;
    }
    return [];
  }

  async function fetchLivescoreSoccer(dateCompact) {
    if (!dateCompact) return [];
    const j = await gmJson(
      'https://prod-cdn-public-api.livescore.com/v1/api/app/date/soccer/' + dateCompact + '/1?timezone=-5'
    );
    const stages = (j && j.Stages) || [];
    const out = [];
    stages.forEach((stage) => {
      (stage.Events || []).forEach((ev) => {
        const home = (ev.T1 && ev.T1[0] && ev.T1[0].Nm) || '';
        const away = (ev.T2 && ev.T2[0] && ev.T2[0].Nm) || '';
        const eps = String(ev.Eps || '');
        const postponed = isEspnPostponedStatus(eps) || /^(Postp|Canc|Abd|Susp)$/i.test(eps);
        const completed = /^(FT|AET|Pen|AP)$/i.test(eps);
        out.push(
          normScoreEvent({
            completed: completed && !postponed,
            status: postponed ? eps || 'Postponed' : eps,
            awayName: away,
            homeName: home,
            awayScore: ev.Tr2,
            homeScore: ev.Tr1,
          })
        );
      });
    });
    return out;
  }

  async function fetchSportsDbSoccer(dateCompact) {
    if (!dateCompact || String(dateCompact).length !== 8) return [];
    const iso =
      String(dateCompact).slice(0, 4) +
      '-' +
      String(dateCompact).slice(4, 6) +
      '-' +
      String(dateCompact).slice(6, 8);
    const j = await gmJson(
      'https://www.thesportsdb.com/api/v1/json/123/eventsday.php?d=' + encodeURIComponent(iso) + '&s=Soccer'
    );
    const out = [];
    (j && j.events ? j.events : []).forEach((ev) => {
      const status = String(ev.strStatus || '');
      const postponed =
        String(ev.strPostponed || '').toLowerCase() === 'yes' || isEspnPostponedStatus(status);
      const live = /^(ns|not started)$/i.test(status) || /\b(1h|2h|ht|live|in play|half)\b/i.test(status);
      const awayScore = Number(ev.intAwayScore);
      const homeScore = Number(ev.intHomeScore);
      const hasScores = Number.isFinite(awayScore) && Number.isFinite(homeScore);
      out.push(
        normScoreEvent({
          completed: !postponed && hasScores && !live,
          status: postponed ? status || 'Postponed' : status || (hasScores ? 'FT' : ''),
          awayName: ev.strAwayTeam,
          homeName: ev.strHomeTeam,
          awayScore: awayScore,
          homeScore: homeScore,
        })
      );
    });
    return out;
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

    async function cached(ck, loader) {
      if (!cache.has(ck)) {
        try {
          cache.set(ck, await memoScoreboard(ck, loader));
        } catch (_) {
          cache.set(ck, []);
        }
      }
      return cache.get(ck) || [];
    }

    for (let i = 0; i < need.length; i++) {
      const s = need[i];
      const sportKeys = sportKeysToTry(s);
      const days = daysToTryForSnap(s);
      if (!sportKeys.length || !days.length) continue;
      const isSoccer = sportKeys.indexOf('SOCCER') >= 0;

      let hit = isSoccer ? matchBoardScoreForSnap(s) : null;

      for (let si = 0; si < sportKeys.length && !hit; si++) {
        const sportKey = sportKeys[si];
        const soccerSlugs = [];
        if (sportKey === 'SOCCER') {
          const mapped = espnSoccerSlug(s.league);
          if (mapped) soccerSlugs.push(mapped);
          soccerSlugs.push('all');
        } else {
          soccerSlugs.push(null);
        }
        for (let gi = 0; gi < soccerSlugs.length && !hit; gi++) {
          const soccerSlug = soccerSlugs[gi];
          for (let di = 0; di < days.length && !hit; di++) {
            const day = days[di];
            const ck = 'espn|' + sportKey + '|' + (soccerSlug || '') + '|' + day;
            const events = await cached(ck, () => fetchEspnScoreboard(sportKey, day, soccerSlug));
            hit = matchScoreEventForSnap(s, events);
          }
        }
      }

      if (!hit && isSoccer) {
        const loaders = [
          ['fotmob', fetchFotmobSoccer],
          ['livescore', fetchLivescoreSoccer],
          ['sportsdb', fetchSportsDbSoccer],
        ];
        for (let li = 0; li < loaders.length && !hit; li++) {
          for (let di = 0; di < days.length && !hit; di++) {
            const day = days[di];
            const ck = loaders[li][0] + '|' + day;
            const events = await cached(ck, () => loaders[li][1](day));
            hit = matchScoreEventForSnap(s, events);
          }
        }
      }

      if (!hit) continue;
      if (applyMatchedScore(s, hit, drop)) graded++;
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
        // Remote/file grades win over stale local: merge local onto remote, then remote again.
        let snaps = mergeLeagueSnaps(remoteSnaps, local.snaps || []);
        snaps = mergeLeagueSnaps(snaps, remoteSnaps);
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
                const ri = routeInfo();
                const onSoccer = String((ri.sport || ri.board || '')).toLowerCase() === 'soccer';
                msg +=
                  ' · board ' +
                  games +
                  ' games, 0 eligible (need ≥' +
                  (onSoccer ? BOOK_LEAGUE_MIN_Y_SOCCER : BOOK_LEAGUE_MIN_Y) +
                  ' books priced, start <' +
                  (onSoccer ? '36' : '18') +
                  'h)';
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

  function boardOddsFp() {
    const games = tradBoardGames();
    let s = String(games.length);
    for (let i = 0; i < games.length; i++) {
      const g = games[i];
      s += '\n' + (g.getAttribute('data-game') || g.id || i);
      const hold = g.querySelector(':scope > .cell.cHold');
      if (hold) s += '|' + String(hold.textContent || '').trim();
    }
    return s;
  }

  function paintBoard() {
    painting = true;
    boardGamesCache = null;
    lastPaintAt = Date.now();
    try {
      ensureStyle();
      stripLegacyOverlayNodes();
      ensureBookLeagueUi();
      if (TAKE_REC_PANEL_ENABLED) ensureTakeRecUi();
      else {
        const old = document.getElementById(TAKE_REC_UI_ID);
        if (old) old.remove();
      }
      ensureBasketballAllChip();
      ensureDefaultMarket();
      ensureOpenerOn();
      boardGamesCache = tradBoardGames();
      markPriceRanksOnTradBoard();
      markZcodeRatioChips();
      markHoldGlows();
      // Coalesce take-panel rebuilds during load storms.
      if (TAKE_REC_PANEL_ENABLED) {
        const storm = Date.now() < moBurstWindowAt && moBurstHits > 10;
        scheduleTakeRecRefresh(storm ? 600 : 120);
      }
    } finally {
      boardGamesCache = null;
      painting = false;
    }
  }

  function scheduleBoardPaint(ms) {
    if (paintTimer) clearTimeout(paintTimer);
    const storm = Date.now() < moBurstWindowAt && moBurstHits > 10;
    const minGap = storm ? 700 : DISPLAY_TDR_RANKS ? 360 : 480;
    const wait = ms == null ? (storm ? 320 : 180) : ms;
    paintTimer = setTimeout(() => {
      paintTimer = 0;
      const since = Date.now() - lastPaintAt;
      if (painting || since < minGap) {
        scheduleBoardPaint(Math.max(60, minGap - since));
        return;
      }
      paintBoard();
    }, wait);
  }

  function boot4c() {
    if (fixBrokenBoardRoute()) return;
    scrubUnknownView();

    document.addEventListener(
      'click',
      (e) => {
        const t = e && e.target;
        if (!t || !t.closest) return;
        if (!marketAutoClick) {
          const btn = t.closest(
            '.seg[aria-label="Market"] .segBtn, [role="tablist"][aria-label="Market"] [role="tab"]'
          );
          if (btn) marketUserOverride = true;
        }
        if (basketballAllAutoClick) return;
        const chip = t.closest(
          'nav.leagueNav a.chip, nav.leagueNav button.chip, .leagueNav a.chip, .leagueNav button.chip, .scrollRow.leagues a.chip, .scrollRow.leagues button.chip'
        );
        if (chip) {
          const label = String(chip.textContent || '')
            .replace(/\s+/g, ' ')
            .trim();
          const href = String(chip.getAttribute('href') || '')
            .toLowerCase()
            .replace(/\/+$/, '');
          const isAll =
            /^All\b/i.test(label) || href === '/basketball' || href.endsWith('/basketball');
          basketballLeagueUserOverride = !isAll;
        }
      },
      true
    );

    try {
      if (typeof GM_addValueChangeListener === 'function') {
        let zcodeChipSyncTo = 0;
        GM_addValueChangeListener(ZCODE_LIVE_KEY, (_name, oldVal, newVal, remote) => {
          zcodeLiveCache = newVal && Array.isArray(newVal.games) ? newVal : null;
          zcodeLiveCacheAt = Date.now();
          const oldFp = oldVal && oldVal.fp != null ? String(oldVal.fp) : '';
          const newFp = newVal && newVal.fp != null ? String(newVal.fp) : '';
          const cleared = !(newVal && Array.isArray(newVal.games) && newVal.games.length);
          if (!(remote || oldFp !== newFp || (cleared && oldFp))) return;
          if (!cleared && oldFp === newFp && zcodeLiveFpSeen) return;
          if (zcodeChipSyncTo) clearTimeout(zcodeChipSyncTo);
          zcodeChipSyncTo = setTimeout(() => {
            zcodeChipSyncTo = 0;
            if (refreshZcodeRatioChipsFromGm(true)) {
              log(
                cleared ? 'ZCode ratios cleared (tab closed)' : 'ZCode ratios synced',
                newVal && newVal.gameCount,
                remote ? '(remote)' : ''
              );
            }
          }, 120);
        });
      }
    } catch (_) {}

    watchFourCSportRoute();
    scheduleBoardPaint(0);
    setInterval(() => {
      if (fixBrokenBoardRoute()) return;
      scrubUnknownView();
      const fp = boardOddsFp();
      if (fp === lastBoardOddsFp) return;
      lastBoardOddsFp = fp;
      dirtyAllGames = true;
      scheduleBoardPaint(220);
    }, 10000);
    // Safety net if a GM change listener is missed — cheap when fp is unchanged.
    setInterval(() => {
      refreshZcodeRatioChipsFromGm(false);
    }, ZCODE_POLL_MS);

    try {
      let moTimer = 0;
      let observedRoot = null;
      const ownRootSel =
        '#' +
        BOOK_LEAGUE_UI_ID +
        ', #' +
        TAKE_REC_UI_ID +
        ', #' +
        OPEN_ZCODE_UI_ID +
        ', #' +
        STYLE_ID;
      const boardObserveRoot = () =>
        document.querySelector('.gTable') ||
        document.querySelector('section.trad') ||
        document.querySelector('.boardPane.trad') ||
        document.getElementById('app') ||
        document.body;
      const mo = new MutationObserver((muts) => {
        if (painting) return;
        let hit = false;
        const now = Date.now();
        if (now - moBurstWindowAt > 1000) {
          moBurstHits = 0;
          moBurstWindowAt = now + 1000;
        }
        for (let i = 0; i < muts.length; i++) {
          const m = muts[i];
          const t = m && m.target;
          const el = t && (t.nodeType === 1 ? t : t.parentElement);
          if (!el || !el.closest) continue;
          if (el.closest(ownRootSel)) continue;
          if (el.closest('.hm, .hmBody, .mtable, .modal.wide[aria-label="Line history"]')) {
            continue;
          }
          if (!el.closest('.gRow.gGame, .gTable, section.trad, .boardPane.trad')) continue;
          const game = el.closest('.gRow.gGame[data-game]');
          if (game && !dirtyAllGames) dirtyGames.add(game);
          else dirtyAllGames = true;
          hit = true;
          moBurstHits++;
          // Prefer per-game dirties while streaming; only escalate after a big burst.
          if (dirtyGames.size > 24 || moBurstHits > 40) {
            dirtyAllGames = true;
            dirtyGames.clear();
            break;
          }
        }
        if (!hit) return;
        if (moTimer) clearTimeout(moTimer);
        const storm = moBurstHits > 10;
        moTimer = setTimeout(() => {
          moTimer = 0;
          scrubUnknownView();
          scheduleBoardPaint(storm ? 420 : 180);
        }, storm ? 650 : 280);
      });
      const start = () => {
        const root = boardObserveRoot();
        if (!root) return false;
        if (observedRoot === root) return true;
        try {
          mo.disconnect();
        } catch (_) {}
        observedRoot = root;
        mo.observe(root, { childList: true, subtree: true });
        return true;
      };
      if (!start()) {
        const w = setInterval(() => {
          if (start()) clearInterval(w);
        }, 500);
      } else {
        setInterval(start, 4000);
      }
    } catch (_) {}

    let lastPath = location.pathname + location.search;
    setInterval(() => {
      if (fixBrokenBoardRoute()) return;
      scrubUnknownView();
      const key = location.pathname + location.search;
      if (key === lastPath) return;
      lastPath = key;
      lastBoardOddsFp = '';
      headerBundleCache = { head: null, n: 0, sig: '', codes: [], names: [] };
      dirtyAllGames = true;
      dirtyGames.clear();
      zcodeLiveFpSeen = '';
      moBurstHits = 0;
      publishFourCSportWant(true);
      scheduleBoardPaint(80);
    }, 1500);

    ensureBookLeagueUi();
    ensureOpenZcodeBtn();
    if (TAKE_REC_PANEL_ENABLED) ensureTakeRecUi();
    else {
      const old = document.getElementById(TAKE_REC_UI_ID);
      if (old) old.remove();
    }
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
    // First sync after board has had time to stream prices; still runs while loading.
    scheduleBookLeagueSync(2500);
    setInterval(() => scheduleBookLeagueSync(0), BOOK_LEAGUE_SYNC_MS);
    log(
      'Ready (TDR ' +
        (DISPLAY_TDR_RANKS
          ? 'visible'
          : DISPLAY_TDR_BL_ENDS
            ? '2 Best-line · today only'
            : 'hidden→Book League') +
        ' · light-load paints · Take · OTC · Zcode · Book League ATS · v3.14.0)'
    );
  }

  function bootBookLeaguePage() {
    const local = readLocalBookLeague();
    const fileData =
      window.__BOOK_LEAGUE_DATA__ && typeof window.__BOOK_LEAGUE_DATA__ === 'object'
        ? window.__BOOK_LEAGUE_DATA__
        : null;
    const localSnaps = (local && local.snaps) || [];
    const fileSnaps = (fileData && fileData.snaps) || [];
    // Pages file holds historical ATS grades; re-merge it last so TM cache cannot wipe them.
    let snaps = mergeLeagueSnaps(fileSnaps, localSnaps);
    snaps = mergeLeagueSnaps(snaps, fileSnaps);
    const payload = {
      updatedAt:
        countGradedSnaps(fileSnaps) >= countGradedSnaps(localSnaps)
          ? (fileData && fileData.updatedAt) || new Date().toISOString()
          : (local && local.updatedAt) || new Date().toISOString(),
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
    log(
      'Book League page hydrated (pre-GitHub)',
      snaps.length,
      'graded',
      countGradedSnaps(snaps)
    );
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
