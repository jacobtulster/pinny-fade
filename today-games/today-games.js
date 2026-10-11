(function () {
  'use strict';

  const ALL_SPORTS = ['NFL', 'NCAAF', 'NHL', 'MLB', 'NBA', 'WNBA', 'NCAAB'];

  const SPORT_META = {
    NFL: { path: 'football/nfl', metric: 'spread' },
    NCAAF: {
      path: 'football/college-football',
      groups: '80',
      metric: 'spread',
    },
    NHL: {
      path: 'hockey/nhl',
      metric: 'mlEdge',
      coreLeague: 'hockey/leagues/nhl',
    },
    MLB: {
      path: 'baseball/mlb',
      metric: 'mlEdge',
      coreLeague: 'baseball/leagues/mlb',
    },
    NBA: { path: 'basketball/nba', metric: 'spread' },
    WNBA: { path: 'basketball/wnba', metric: 'spread' },
    NCAAB: {
      path: 'basketball/mens-college-basketball',
      groups: '50',
      metric: 'spread',
    },
  };

  const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';

  const LIVE_POLL_MS = 20000;

  const statusText = document.getElementById('statusText');
  const statusMeta = document.getElementById('statusMeta');
  const sportFilters = document.getElementById('sportFilters');
  const searchInput = document.getElementById('searchInput');
  const reloadBtn = document.getElementById('reloadBtn');
  const historySelect = document.getElementById('historySelect');
  const body = document.getElementById('tableBody');

  let days = {
    today: { dateEt: null, sportsPresent: [], games: [] },
    tomorrow: { dateEt: null, sportsPresent: [], games: [] },
  };
  let activeDay = 'today';
  let rawGames = [];
  let sportsPresent = [];
  let dayEt = null;
  let activeSport = 'ALL';
  let sortKey = 'time';
  let sortDir = 'asc';
  let lastScoreSync = null;
  let liveTimer = null;
  let liveInFlight = false;
  let viewingArchive = null; // YYYY-MM-DD or null for live
  let currentFetchedAt = null;
  let archiveDays = [];

  function applyActiveDay() {
    const block = days[activeDay] || { dateEt: null, sportsPresent: [], games: [] };
    rawGames = Array.isArray(block.games) ? block.games : [];
    sportsPresent = block.sportsPresent || [];
    dayEt = block.dateEt || null;
    activeSport = 'ALL';
  }

  function updateDayTabs() {
    document.querySelectorAll('.day-tab').forEach((btn) => {
      const day = btn.getAttribute('data-day');
      btn.classList.toggle('active', day === activeDay);
      const n = ((days[day] && days[day].games) || []).length;
      if (day === 'today') btn.textContent = 'Today' + (n ? ' (' + n + ')' : '');
      if (day === 'tomorrow') {
        btn.textContent = 'Tomorrow' + (n ? ' (' + n + ')' : '');
      }
    });
  }

  function updateStatus(fetchedAt) {
    const when = fetchedAt ? new Date(fetchedAt).toLocaleString() : '';
    const label = viewingArchive
      ? 'Archive'
      : activeDay === 'tomorrow'
        ? 'Tomorrow'
        : 'Today';
    statusText.textContent =
      label +
      ' · ' +
      (dayEt || '—') +
      ' ET · ' +
      rawGames.length +
      ' games · ' +
      (sportsPresent.join(', ') || 'no sports');
    const liveBit = lastScoreSync
      ? ' · scores ' + new Date(lastScoreSync).toLocaleTimeString()
      : '';
    if (viewingArchive) {
      statusMeta.textContent =
        (when ? 'Snapshot ' + when : 'Archived slate') +
        liveBit +
        ' · polling finals for grades';
      return;
    }
    statusMeta.textContent =
      (when ? 'Snapshot ' + when : '') +
      liveBit +
      ' · live poll 20s · fills missing lines';
  }

  function parseEspnScore(raw) {
    if (raw == null || raw === '') return null;
    if (typeof raw === 'object') {
      const n = Number(raw.value != null ? raw.value : raw.displayValue);
      return Number.isFinite(n) ? n : null;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  function gradeHotterResult(g) {
    if (!g || !g.completed) return null;
    if (!g.edgeSide || g.edgeTeam === 'tie') return null;
    if (g.awayScore == null || g.homeScore == null) return null;
    if (!Number.isFinite(g.awayScore) || !Number.isFinite(g.homeScore)) {
      return null;
    }

    if (g.metric === 'mlEdge') {
      if (g.awayScore === g.homeScore) return 'P';
      const hotterWon =
        g.edgeSide === 'away'
          ? g.awayScore > g.homeScore
          : g.homeScore > g.awayScore;
      return hotterWon ? 'W' : 'L';
    }

    let homeSpread = g.homeSpread;
    if (homeSpread == null && g.awaySpread != null) homeSpread = -g.awaySpread;
    if (homeSpread == null || !Number.isFinite(Number(homeSpread))) return null;
    homeSpread = Number(homeSpread);
    const teamSpread = g.edgeSide === 'away' ? -homeSpread : homeSpread;
    const teamScore = g.edgeSide === 'away' ? g.awayScore : g.homeScore;
    const oppScore = g.edgeSide === 'away' ? g.homeScore : g.awayScore;
    const cover = teamScore - oppScore + teamSpread;
    if (Math.abs(cover) < 1e-9) return 'P';
    return cover > 0 ? 'W' : 'L';
  }

  function ymdToCompact(ymd) {
    return String(ymd || '').replace(/-/g, '');
  }

  async function fetchEspnBoard(sportId, dateCompact) {
    const meta = SPORT_META[sportId];
    if (!meta || !dateCompact) return [];
    let url =
      'https://site.api.espn.com/apis/site/v2/sports/' +
      meta.path +
      '/scoreboard?dates=' +
      dateCompact;
    if (meta.groups) url += '&groups=' + meta.groups;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('ESPN ' + res.status);
    const j = await res.json();
    const out = [];
    for (const ev of j.events || []) {
      const c = (ev.competitions || [])[0];
      if (!c) continue;
      const st = c.status && c.status.type;
      const comps = c.competitors || [];
      const home = comps.find((x) => x.homeAway === 'home');
      const away = comps.find((x) => x.homeAway === 'away');
      if (!home || !away) continue;
      out.push({
        gameId: String(ev.id),
        completed: !!(st && st.completed),
        status: (st && (st.shortDetail || st.description || st.name)) || '',
        state: (st && st.state) || '',
        awayScore: parseEspnScore(away.score),
        homeScore: parseEspnScore(home.score),
      });
    }
    return out;
  }

  function mergeLiveIntoGames(games, liveById) {
    let changed = 0;
    for (const g of games || []) {
      const live = liveById.get(String(g.gameId));
      if (!live) continue;
      let dirty = false;
      if (g.completed !== live.completed) {
        g.completed = live.completed;
        dirty = true;
      }
      if (live.status && g.status !== live.status) {
        g.status = live.status;
        dirty = true;
      }
      if (live.state && g.state !== live.state) {
        g.state = live.state;
        dirty = true;
      }
      if (live.awayScore != null && g.awayScore !== live.awayScore) {
        g.awayScore = live.awayScore;
        dirty = true;
      }
      if (live.homeScore != null && g.homeScore !== live.homeScore) {
        g.homeScore = live.homeScore;
        dirty = true;
      }
      if (dirty || g.completed) {
        const graded = gradeHotterResult(g);
        if (g.hotterResult !== graded) {
          g.hotterResult = graded;
          dirty = true;
        }
      }
      if (dirty) changed++;
    }
    return changed;
  }

  function parseAmerican(v) {
    if (v == null || v === '') return null;
    const n = Number(String(v).replace(/^\+/, ''));
    return Number.isFinite(n) ? n : null;
  }

  function fmtAmerican(n) {
    if (n == null || !Number.isFinite(n)) return null;
    return (n > 0 ? '+' : '') + String(n);
  }

  function needsLine(g) {
    if (!g || g.completed) return false;
    if (g.line) return false;
    const metric = g.metric || (SPORT_META[g.sport] && SPORT_META[g.sport].metric);
    if (metric === 'mlEdge') {
      return g.awayMl == null || g.homeMl == null;
    }
    return g.homeSpread == null && g.awaySpread == null;
  }

  async function fetchSummaryOdds(sportPath, gameId) {
    try {
      const res = await fetch(
        ESPN + '/' + sportPath + '/summary?event=' + gameId,
        { cache: 'no-store' }
      );
      if (!res.ok) return null;
      const j = await res.json();
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
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return null;
      const j = await res.json();
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

  async function fetchGameOdds(sportId, gameId) {
    const meta = SPORT_META[sportId];
    if (!meta) return null;
    if (meta.coreLeague) {
      const core = await fetchCoreMlOdds(meta.coreLeague, gameId);
      if (core) return core;
    }
    return fetchSummaryOdds(meta.path, gameId);
  }

  function oddsLabel(g, odds) {
    if (!odds) return null;
    const metric = g.metric || (SPORT_META[g.sport] && SPORT_META[g.sport].metric);
    if (metric === 'mlEdge') {
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

  function applyOddsToGame(g, odds) {
    if (!g || !odds) return false;
    const line = oddsLabel(g, odds);
    const ml = mlLabel(odds);
    const hasSpread = odds.homeSpread != null || odds.awaySpread != null;
    const hasMl = odds.awayMl != null && odds.homeMl != null;
    if (!line && !hasSpread && !hasMl) return false;

    let dirty = false;
    if (line && g.line !== line) {
      g.line = line;
      dirty = true;
    }
    if (ml && g.ml !== ml) {
      g.ml = ml;
      dirty = true;
    }
    if (odds.awayMl != null && g.awayMl !== odds.awayMl) {
      g.awayMl = odds.awayMl;
      dirty = true;
    }
    if (odds.homeMl != null && g.homeMl !== odds.homeMl) {
      g.homeMl = odds.homeMl;
      dirty = true;
    }
    if (odds.homeSpread != null && g.homeSpread !== odds.homeSpread) {
      g.homeSpread = odds.homeSpread;
      dirty = true;
    }
    if (odds.awaySpread != null && g.awaySpread !== odds.awaySpread) {
      g.awaySpread = odds.awaySpread;
      dirty = true;
    }
    if (odds.provider && g.oddsProvider !== odds.provider) {
      g.oddsProvider = odds.provider;
      dirty = true;
    }
    if (odds.overUnder != null && g.overUnder !== odds.overUnder) {
      g.overUnder = odds.overUnder;
      dirty = true;
    }
    if (dirty || g.completed) {
      const graded = gradeHotterResult(g);
      if (g.hotterResult !== graded) {
        g.hotterResult = graded;
        dirty = true;
      }
    }
    return dirty;
  }

  async function fillMissingOdds() {
    const missing = [];
    ['today', 'tomorrow'].forEach((dayKey) => {
      const block = days[dayKey];
      if (!block || !block.games) return;
      block.games.forEach((g) => {
        if (needsLine(g)) missing.push(g);
      });
    });
    if (!missing.length) return 0;

    let filled = 0;
    const CONCURRENCY = 4;
    for (let i = 0; i < missing.length; i += CONCURRENCY) {
      const batch = missing.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (g) => {
          const odds = await fetchGameOdds(g.sport, g.gameId);
          return { g, odds };
        })
      );
      results.forEach(({ g, odds }) => {
        if (applyOddsToGame(g, odds)) filled++;
      });
    }
    return filled;
  }

  async function syncLiveScores() {
    if (liveInFlight) return;
    liveInFlight = true;
    try {
      const jobs = [];
      ['today', 'tomorrow'].forEach((dayKey) => {
        const block = days[dayKey];
        if (!block || !block.dateEt || !block.games || !block.games.length) {
          return;
        }
        const compact = ymdToCompact(block.dateEt);
        const sports = new Set(
          block.games.filter((g) => !g.completed).map((g) => g.sport)
        );
        // Always refresh sports that still have open games; also refresh
        // any sport that has games (catches just-finalized boards).
        block.games.forEach((g) => sports.add(g.sport));
        sports.forEach((sportId) => {
          jobs.push(
            fetchEspnBoard(sportId, compact).then((rows) => ({
              dayKey,
              rows,
            }))
          );
        });
      });

      let changed = 0;
      if (jobs.length) {
        const results = await Promise.allSettled(jobs);
        const byDay = { today: new Map(), tomorrow: new Map() };
        results.forEach((r) => {
          if (r.status !== 'fulfilled') return;
          const { dayKey, rows } = r.value;
          rows.forEach((row) => byDay[dayKey].set(row.gameId, row));
        });

        changed += mergeLiveIntoGames(days.today.games, byDay.today);
        changed += mergeLiveIntoGames(days.tomorrow.games, byDay.tomorrow);
      }

      changed += await fillMissingOdds();

      lastScoreSync = Date.now();
      // Keep the active view pointing at the same (mutated) array.
      rawGames = (days[activeDay] && days[activeDay].games) || [];
      updateDayTabs();
      if (changed > 0) render();
      else updateStatus(currentFetchedAt);
    } catch (err) {
      statusMeta.textContent =
        'Live scores failed: ' + ((err && err.message) || String(err));
    } finally {
      liveInFlight = false;
    }
  }

  function stopLiveScores() {
    if (liveTimer) {
      clearInterval(liveTimer);
      liveTimer = null;
    }
  }

  function startLiveScores() {
    stopLiveScores();
    // Archives also poll so mid-slate snapshots get finals + W/P/L.
    syncLiveScores();
    liveTimer = setInterval(syncLiveScores, LIVE_POLL_MS);
  }

  function applyPayload(data) {
    const hasToday =
      data &&
      ((data.today && Array.isArray(data.today.games)) ||
        Array.isArray(data.games));
    if (!data || !hasToday) {
      statusText.textContent = 'No data';
      statusMeta.textContent = 'Run node today-games/fetch.js';
      body.innerHTML =
        '<tr class="empty"><td colspan="10">No data yet. Run node today-games/fetch.js then reload.</td></tr>';
      updateDayTabs();
      buildFilters();
      return false;
    }

    days.today = data.today || {
      dateEt: data.todayEt || null,
      sportsPresent: data.sportsPresent || [],
      games: data.games || [],
    };
    days.tomorrow = data.tomorrow || {
      dateEt: data.tomorrowEt || null,
      sportsPresent: data.tomorrowSportsPresent || [],
      games: data.tomorrowGames || [],
    };

    currentFetchedAt = data.fetchedAt || null;
    applyActiveDay();
    updateDayTabs();
    updateStatus(currentFetchedAt);
    buildFilters();
    render();
    return true;
  }

  function fillHistorySelect() {
    if (!historySelect) return;
    const prev = historySelect.value || 'live';
    historySelect.innerHTML = '';
    const liveOpt = document.createElement('option');
    liveOpt.value = 'live';
    liveOpt.textContent = 'Live (today / tomorrow)';
    historySelect.appendChild(liveOpt);

    const newestFirst = archiveDays.slice().reverse();
    newestFirst.forEach((d) => {
      const opt = document.createElement('option');
      opt.value = d;
      opt.textContent = d;
      historySelect.appendChild(opt);
    });

    const keep =
      prev === 'live' || archiveDays.indexOf(prev) >= 0 ? prev : 'live';
    historySelect.value = keep;
  }

  async function loadHistoryIndex() {
    try {
      const res = await fetch('history/index.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const idx = await res.json();
      archiveDays = Array.isArray(idx.days) ? idx.days.slice() : [];
    } catch (_) {
      archiveDays = [];
    }
    fillHistorySelect();
  }

  async function loadArchiveDay(dateEt) {
    statusText.textContent = 'Loading archive…';
    statusMeta.textContent = dateEt;
    try {
      const res = await fetch('history/' + dateEt + '.json', {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      viewingArchive = dateEt;
      activeDay = 'today';
      if (!applyPayload(data)) return;
      // Archived "tomorrow" tab still useful for that snapshot
      updateDayTabs();
      startLiveScores();
    } catch (err) {
      statusText.textContent = 'Archive failed';
      statusMeta.textContent = (err && err.message) || String(err);
      body.innerHTML =
        '<tr class="empty"><td colspan="10">Could not load history/' +
        escapeHtml(dateEt) +
        '.json</td></tr>';
    }
  }

  function loadLive() {
    viewingArchive = null;
    activeDay = 'today';
    if (!applyPayload(window.__TODAY_GAMES_DATA__)) return;
    startLiveScores();
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtAvg(n) {
    if (n == null || !Number.isFinite(n)) return '—';
    return (n > 0 ? '+' : '') + n.toFixed(2);
  }

  /** True if kickoff is within the next hour from local system time. */
  function isStartingSoon(g) {
    if (!g || g.completed || !g.startDate) return false;
    const start = new Date(g.startDate).getTime();
    if (!Number.isFinite(start)) return false;
    const now = Date.now();
    return start >= now && start <= now + 60 * 60 * 1000;
  }

  /** true = hotter is favorite, false = hotter is dog, null = unknown/pick'em */
  function hotterIsFavorite(g) {
    if (!g || !g.edgeSide || g.edgeTeam === 'tie') return null;

    const aMl = g.awayMl;
    const hMl = g.homeMl;
    if (aMl != null && hMl != null && Number.isFinite(aMl) && Number.isFinite(hMl)) {
      if (aMl === hMl) return null;
      const favSide = aMl < hMl ? 'away' : 'home';
      return g.edgeSide === favSide;
    }

    let homeSpread = g.homeSpread;
    let awaySpread = g.awaySpread;
    if (homeSpread == null && awaySpread == null) return null;
    if (awaySpread == null) awaySpread = -Number(homeSpread);
    if (homeSpread == null) homeSpread = -Number(awaySpread);
    if (!Number.isFinite(homeSpread) || !Number.isFinite(awaySpread)) return null;
    if (homeSpread === 0 && awaySpread === 0) return null;

    if (g.edgeSide === 'away') return awaySpread < 0;
    return homeSpread < 0;
  }

  function gapGlowClass(g) {
    if (g.gap == null || !(g.gap >= 5)) return '';
    const fav = hotterIsFavorite(g);
    if (fav === true) return ' gap-glow-fav';
    if (fav === false) return ' gap-glow-dog';
    return ' gap-glow';
  }

  function buildFilters() {
    sportFilters.innerHTML = '';
    const present = new Set(sportsPresent);
    const make = (id, label, enabled) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip' + (activeSport === id ? ' active' : '');
      btn.textContent = label;
      btn.disabled = !enabled;
      if (enabled) {
        btn.addEventListener('click', () => {
          activeSport = id;
          buildFilters();
          render();
        });
      }
      sportFilters.appendChild(btn);
    };

    make('ALL', 'All', true);
    ALL_SPORTS.forEach((s) => {
      const n = rawGames.filter((g) => g.sport === s).length;
      make(s, s + (n ? ' (' + n + ')' : ''), present.has(s) || n > 0);
    });
  }

  function filtered() {
    const q = (searchInput.value || '').trim().toLowerCase();
    return rawGames.filter((g) => {
      if (activeSport !== 'ALL' && g.sport !== activeSport) return false;
      if (!q) return true;
      return (
        (g.awayTeam && g.awayTeam.toLowerCase().indexOf(q) >= 0) ||
        (g.homeTeam && g.homeTeam.toLowerCase().indexOf(q) >= 0) ||
        (g.sport && g.sport.toLowerCase().indexOf(q) >= 0) ||
        (g.line && g.line.toLowerCase().indexOf(q) >= 0)
      );
    });
  }

  function sorted(list) {
    const dir = sortDir === 'asc' ? 1 : -1;
    const copy = list.slice();
    copy.sort((a, b) => {
      if (sortKey === 'time') {
        const at = a.startDate || '';
        const bt = b.startDate || '';
        if (at === bt) {
          const ag = a.gap;
          const bg = b.gap;
          if (ag == null && bg == null) return 0;
          if (ag == null) return 1;
          if (bg == null) return -1;
          return bg - ag;
        }
        return at < bt ? -dir : dir;
      }
      const ag = a.gap;
      const bg = b.gap;
      if (ag == null && bg == null) {
        return String(a.startDate || '').localeCompare(String(b.startDate || ''));
      }
      if (ag == null) return 1;
      if (bg == null) return -1;
      if (ag === bg) {
        return String(a.startDate || '').localeCompare(String(b.startDate || ''));
      }
      return ag < bg ? -dir : dir;
    });
    return copy;
  }

  function updateSortHeaders() {
    document.querySelectorAll('th.sortable').forEach((th) => {
      const key = th.getAttribute('data-sort');
      const active = key === sortKey;
      th.classList.toggle('sort-active', active);
      th.setAttribute(
        'data-dir',
        active ? (sortDir === 'desc' ? '↓' : '↑') : ''
      );
    });
  }

  function render() {
    updateSortHeaders();
    const list = sorted(filtered());
    body.innerHTML = '';

    if (!list.length) {
      body.innerHTML =
        '<tr class="empty"><td colspan="10">' +
        (rawGames.length
          ? 'No games match this filter.'
          : 'No data yet. Run node today-games/fetch.js then reload.') +
        '</td></tr>';
      return;
    }

    list.forEach((g, i) => {
      const tr = document.createElement('tr');
      if (g.completed) tr.classList.add('done');

      let hotter = '—';
      if (g.edgeTeam && g.edgeTeam !== 'tie') {
        const fav = hotterIsFavorite(g);
        const role =
          fav === true ? 'fav' : fav === false ? 'dog' : g.edgeSide || '';
        hotter =
          escapeHtml(g.edgeTeam) + (role ? ' (' + role + ')' : '');
      } else if (g.gap === 0) {
        hotter = 'Even';
      }
      if (g.completed && g.hotterResult) {
        const cls =
          g.hotterResult === 'W'
            ? 'res-w'
            : g.hotterResult === 'P'
              ? 'res-p'
              : 'res-l';
        hotter +=
          ' <span class="res-badge ' +
          cls +
          '">' +
          escapeHtml(g.hotterResult) +
          '</span>';
      }

      const scoreBit =
        g.completed && g.awayScore != null && g.homeScore != null
          ? ' · ' + g.awayScore + '-' + g.homeScore
          : '';

      tr.innerHTML =
        '<td class="num" data-label="#">' +
        (i + 1) +
        '</td>' +
        '<td data-label="Sport"><span class="sport-pill ' +
        escapeHtml(String(g.sport || '').toLowerCase()) +
        '">' +
        escapeHtml(g.sport) +
        '</span></td>' +
        '<td class="kickoff' +
        (isStartingSoon(g) ? ' time-soon' : '') +
        '" data-label="Kickoff">' +
        escapeHtml(g.kickoffEt || '—') +
        '</td>' +
        '<td class="matchup" data-label="Matchup">' +
        escapeHtml(g.awayTeam) +
        '<span class="vs">@</span>' +
        escapeHtml(g.homeTeam) +
        '</td>' +
        '<td class="odds" data-label="Line">' +
        escapeHtml(g.line || '—') +
        '</td>' +
        '<td class="num" data-label="Away avg">' +
        fmtAvg(g.awayAvg) +
        '</td>' +
        '<td class="num" data-label="Home avg">' +
        fmtAvg(g.homeAvg) +
        '</td>' +
        '<td class="num gap' +
        gapGlowClass(g) +
        '" data-label="Gap">' +
        (g.gap == null ? '—' : g.gap.toFixed(2)) +
        '</td>' +
        '<td class="edge" data-label="Hotter">' +
        hotter +
        '</td>' +
        '<td data-label="Status">' +
        escapeHtml((g.status || '') + scoreBit) +
        '</td>';
      body.appendChild(tr);
    });
    updateMobileSortChips();
  }

  function updateMobileSortChips() {
    document.querySelectorAll('.sort-chip').forEach((btn) => {
      const key = btn.getAttribute('data-sort');
      const active = key === sortKey;
      btn.classList.toggle('active', active);
      const arrow = active ? (sortDir === 'desc' ? ' ↓' : ' ↑') : '';
      if (key === 'time') btn.textContent = 'Kickoff' + arrow;
      if (key === 'gap') btn.textContent = 'Gap' + arrow;
    });
  }

  function setSort(key) {
    if (!key) return;
    if (sortKey === key) {
      sortDir = sortDir === 'desc' ? 'asc' : 'desc';
    } else {
      sortKey = key;
      sortDir = key === 'time' ? 'asc' : 'desc';
    }
    render();
  }

  document.querySelectorAll('.day-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const day = btn.getAttribute('data-day');
      if (!day || day === activeDay) return;
      activeDay = day;
      sortKey = 'time';
      sortDir = 'asc';
      applyActiveDay();
      updateDayTabs();
      updateStatus(currentFetchedAt);
      buildFilters();
      render();
    });
  });

  document.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      setSort(th.getAttribute('data-sort'));
    });
  });

  document.querySelectorAll('.sort-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      setSort(btn.getAttribute('data-sort'));
    });
  });

  searchInput.addEventListener('input', render);
  reloadBtn.addEventListener('click', () => location.reload());

  if (historySelect) {
    historySelect.addEventListener('change', () => {
      const v = historySelect.value;
      if (!v || v === 'live') loadLive();
      else loadArchiveDay(v);
    });
  }

  loadLive();
  loadHistoryIndex();
})();
