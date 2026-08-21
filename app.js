(function () {
  'use strict';

  try {
    localStorage.removeItem('pinnyFadeMlbSlate');
  } catch (_) {}

  const statusBar = document.getElementById('statusBar');
  const statusText = document.getElementById('statusText');
  const statusMeta = document.getElementById('statusMeta');
  const slateBody = document.getElementById('slateBody');
  const refreshBtn = document.getElementById('refreshBtn');
  const openZcodeBtn = document.getElementById('openZcodeBtn');
  const exportBtn = document.getElementById('exportBtn');
  const defaultSortBtn = document.getElementById('defaultSortBtn');

  const DEFAULT_ZCODE_SPORTS = ['MLB', 'NFL', 'WNBA'];
  const SPORT_ORDER = { MLB: 0, NFL: 1, WNBA: 2 };
  const ZCODE_URLS = {
    MLB: 'https://zcodesystem.com/linereversals.php?sport=MLB',
    NFL: 'https://zcodesystem.com/linereversals.php?sport=NFL',
    WNBA: 'https://zcodesystem.com/linereversals.php?sport=WNBA',
  };
  const BMR_ODDS_SCORES_URL = 'https://www.bookmakersreview.com/odds-scores/';

  function tmConnected() {
    return !!(
      document.getElementById('pinny-fade-tm-badge') ||
      window.__PINNY_FADE_SLATE__
    );
  }

  function openZcodeTabsFallback(sports) {
    window.open(BMR_ODDS_SCORES_URL, '_blank');
    const list = sports && sports.length ? sports : DEFAULT_ZCODE_SPORTS;
    list.forEach((sport) => {
      const url = ZCODE_URLS[sport];
      if (url) window.open(url, '_blank');
    });
  }

  function warnIfNoCompanion() {
    if (tmConnected()) return false;
    const isFile = location.protocol === 'file:';
    setStatus(
      'warn',
      'Tampermonkey not on this page',
      isFile
        ? 'Enable TM → allow access to file URLs, or serve via http://localhost (Live Server)'
        : 'Enable the Pinny Fade userscript for this URL, then hard-refresh'
    );
    return true;
  }

  function fmtAmerican(n) {
    if (n == null || !Number.isFinite(n)) return '—';
    const r = Math.round(n);
    return r > 0 ? '+' + r : String(r);
  }

  function fmtSpreadNum(n) {
    if (n == null || !Number.isFinite(n)) return '—';
    if (n === 0) return 'PK';
    const s = Number.isInteger(n) ? String(n) : String(n);
    return n > 0 ? '+' + s : s;
  }

  /** e.g. -6.5-110 */
  function fmtSpreadSide(spread, juice) {
    const s = fmtSpreadNum(spread);
    if (s === '—') return '—';
    const j = fmtAmerican(juice);
    return j === '—' ? s : `${s}${j}`;
  }

  function lineSides(g, which) {
    if (g.market === 'spread') {
      if (which === 'open') {
        return {
          away: fmtSpreadSide(g.openAway, g.openAwayJuice),
          home: fmtSpreadSide(g.openHome, g.openHomeJuice),
        };
      }
      return {
        away: fmtSpreadSide(g.currAway, g.currAwayJuice),
        home: fmtSpreadSide(g.currHome, g.currHomeJuice),
      };
    }
    if (which === 'open') {
      return { away: fmtAmerican(g.openAway), home: fmtAmerican(g.openHome) };
    }
    return { away: fmtAmerican(g.currAway), home: fmtAmerican(g.currHome) };
  }

  function fmtDelta(n, market) {
    if (n == null || !Number.isFinite(n)) return '—';
    if (market === 'spread') {
      const rounded = Math.round(n * 10) / 10;
      const s = Number.isInteger(rounded) ? String(rounded) : String(rounded);
      return (rounded > 0 ? '+' : '') + s + 'pt';
    }
    const r = Math.round(n);
    return (r > 0 ? '+' : '') + r + '¢';
  }

  /** ¢ from even: +105→+5, −101→−1 so +105→−101 = −6¢ */
  function americanCentsFromEven(a) {
    if (!Number.isFinite(a)) return null;
    if (a >= 100) return a - 100;
    if (a <= -100) return a + 100;
    return a;
  }

  function sideDelta(open, curr, market) {
    if (!Number.isFinite(open) || !Number.isFinite(curr)) return null;
    if (market === 'spread') return curr - open;
    const o = americanCentsFromEven(open);
    const c = americanCentsFromEven(curr);
    if (o == null || c == null) return null;
    return c - o;
  }

  function fmtMoveInline(n, market) {
    const cls =
      n == null || !Number.isFinite(n) ? 'muted' : n > 0 ? 'pos' : n < 0 ? 'neg' : '';
    return (
      `<span class="move-inline ${cls}">` +
      `<span class="move-delta">${fmtDelta(n, market)}</span>` +
      `<span class="move-arrow" aria-hidden="true">→</span>` +
      `</span>`
    );
  }

  /** Fallback when no real abbr: first 3 letters of the name (spaces ignored). */
  function fallbackAbbr(name) {
    const s = String(name || '')
      .replace(/\s+/g, '')
      .replace(/[^A-Za-z0-9]/g, '');
    return s.slice(0, 3).toUpperCase();
  }

  function oddsAbbr(g, side) {
    const abbr = side === 'away' ? g.awayAbbr : g.homeAbbr;
    const full = side === 'away' ? g.away : g.home;
    if (abbr && String(abbr).length <= 4 && !/\s/.test(String(abbr)) && String(abbr).toUpperCase() !== 'W') {
      return String(abbr).toUpperCase();
    }
    return fallbackAbbr(full) || '—';
  }

  function oddsTeamCell(label, hlMap, fullName) {
    const cls = hlMap && hlMap[fullName];
    const text = escapeHtml(label);
    const inner = cls ? `<span class="team-hl ${cls}">${text}</span>` : text;
    return `<span class="line-abbr">${inner}</span>`;
  }

  function linePair(teamCell, odds) {
    return (
      `<span class="line-pair">` +
      `${teamCell}` +
      `<span class="line-odds">${odds}</span>` +
      `</span>`
    );
  }

  /** One row: ABBR open  Δ→  ABBR now (tight abbr↔odds) */
  function fmtOddsFlow(g, hlMap) {
    if (!g.pinnyMatched) return '—';
    const open = lineSides(g, 'open');
    const curr = lineSides(g, 'curr');
    const dAway = sideDelta(g.openAway, g.currAway, g.market);
    const dHome = sideDelta(g.openHome, g.currHome, g.market);
    const aCell = oddsTeamCell(oddsAbbr(g, 'away'), hlMap, g.away);
    const hCell = oddsTeamCell(oddsAbbr(g, 'home'), hlMap, g.home);
    return (
      `<span class="line-stack">` +
      `<span class="line-row">` +
      `${linePair(aCell, open.away)}` +
      `${fmtMoveInline(dAway, g.market)}` +
      `${linePair(aCell, curr.away)}` +
      `</span>` +
      `<span class="line-row">` +
      `${linePair(hCell, open.home)}` +
      `${fmtMoveInline(dHome, g.market)}` +
      `${linePair(hCell, curr.home)}` +
      `</span>` +
      `</span>`
    );
  }

  function setStatus(kind, text, meta) {
    statusBar.classList.remove('ok', 'warn');
    if (kind) statusBar.classList.add(kind);
    statusText.textContent = text;
    statusMeta.textContent = meta || '';
  }

  function getPayload() {
    return window.__PINNY_FADE_SLATE__ || null;
  }

  function enrich(games) {
    const seen = {};
    return (games || [])
      .filter((g) => {
        const r1 = Number(g.publicRatio1);
        const r2 = Number(g.publicRatio2);
        const fav = Number(g.favRatio);
        const okSide = (Number.isFinite(r1) && r1 > 0) || (Number.isFinite(r2) && r2 > 0);
        const okFav = !Number.isFinite(fav) || fav > 0;
        if (!okSide || !okFav) return false;
        const start = String(g.gdate || '').trim();
        if (!start) return true;
        const key = [
          g.sport || '',
          start,
          String(g.away || '').toUpperCase(),
          String(g.home || '').toUpperCase(),
          g.publicRatio1,
          g.publicRatio2,
          g.favRatio,
          g.openAway,
          g.openHome,
          g.currAway,
          g.currHome,
          g.fadeTeam,
          g.publicTeam,
        ].join('\t');
        if (seen[key]) return false;
        seen[key] = true;
        return true;
      })
      .map((g) => {
        const notRespected = !!(g.pinnyMatched && g.pinnyToward === 'fade');
        return Object.assign({}, g, {
          notRespected,
          signal: !g.pinnyMatched
            ? 'no-pinny'
            : notRespected
              ? 'not-respected'
              : 'watch',
        });
      });
  }

  const TILE_RANK = { 'tile-red': 0, 'tile-yellow': 1, 'tile-green': 2 };

  /** 'default' | 'date' | 'move' */
  let sortMode = 'default';

  function parseGdateMs(raw) {
    if (!raw) return null;
    const m = String(raw)
      .trim()
      .match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    if (m) {
      return new Date(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        Number(m[4]),
        Number(m[5])
      ).getTime();
    }
    const t = Date.parse(String(raw).trim());
    return Number.isFinite(t) ? t : null;
  }

  function maxMoveAbs(g) {
    if (!g.pinnyMatched) return -1;
    const dA = sideDelta(g.openAway, g.currAway, g.market);
    const dH = sideDelta(g.openHome, g.currHome, g.market);
    const a = Number.isFinite(dA) ? Math.abs(dA) : 0;
    const h = Number.isFinite(dH) ? Math.abs(dH) : 0;
    return Math.max(a, h);
  }

  function sortGames(games) {
    const rows = games.map((g) => Object.assign({}, g, { tile: rowTileClass(g) }));

    if (sortMode === 'date') {
      const now = Date.now();
      return rows.sort((a, b) => {
        const ta = parseGdateMs(a.gdate);
        const tb = parseGdateMs(b.gdate);
        const aStarted = ta != null && ta <= now;
        const bStarted = tb != null && tb <= now;
        if (aStarted !== bStarted) return aStarted ? 1 : -1;
        if (ta == null && tb == null) return 0;
        if (ta == null) return 1;
        if (tb == null) return -1;
        return ta - tb;
      });
    }

    if (sortMode === 'move') {
      return rows.sort((a, b) => maxMoveAbs(b) - maxMoveAbs(a));
    }

    return rows.sort((a, b) => {
      const ta = a.tile ? TILE_RANK[a.tile] : 99;
      const tb = b.tile ? TILE_RANK[b.tile] : 99;
      if (ta !== tb) return ta - tb;
      const sa = SPORT_ORDER[a.sport] != null ? SPORT_ORDER[a.sport] : 9;
      const sb = SPORT_ORDER[b.sport] != null ? SPORT_ORDER[b.sport] : 9;
      if (sa !== sb) return sa - sb;
      const ra = Number(a.publicRatio) || 0;
      const rb = Number(b.publicRatio) || 0;
      return rb - ra;
    });
  }

  function syncSortHeaders() {
    document.querySelectorAll('th.sortable').forEach((th) => {
      const mode = th.getAttribute('data-sort');
      const on = sortMode === mode;
      th.classList.toggle('sort-active', on);
      const base = mode === 'date' ? 'Date' : 'Open → Now';
      th.textContent = on ? base + ' ▾' : base;
    });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Favorite: lower American (ML) or more negative spread. null if missing/tied. */
  function favoriteIsAway(g) {
    const a = Number.isFinite(g.currAway) ? g.currAway : g.openAway;
    const h = Number.isFinite(g.currHome) ? g.currHome : g.openHome;
    if (!Number.isFinite(a) || !Number.isFinite(h)) return null;
    if (a === h) return null;
    return a < h;
  }

  function underratedFavorite(g) {
    const r1 = Number(g.publicRatio1);
    const r2 = Number(g.publicRatio2);
    const favAway = favoriteIsAway(g);
    if (favAway === true && Number.isFinite(r1) && r1 < 1) {
      return { team: g.away, ratio: r1 };
    }
    if (favAway === false && Number.isFinite(r2) && r2 < 1) {
      return { team: g.home, ratio: r2 };
    }
    return null;
  }

  /**
   * Full-row tile:
   * - green: underrated fav (ratio &lt; 1) AND shortened ≥1¢ (ML) or ≥1pt (spread)
   * - yellow: public 2–4.99x AND line moved toward the other team (Take)
   * - red: public ≥5x AND line moved toward the other team (Take)
   */
  function rowTileClass(g) {
    const pub = Number(g.publicRatio);
    const towardTake = g.pinnyMatched && g.pinnyToward === 'fade';
    const underrated = underratedFavorite(g);
    const towardUnderratedFav =
      underrated &&
      Number.isFinite(g.centsMoved) &&
      g.centsMoved <= -1;

    if (Number.isFinite(pub) && pub >= 5 && towardTake) return 'tile-red';
    if (Number.isFinite(pub) && pub >= 2 && pub < 5 && towardTake) return 'tile-yellow';
    if (towardUnderratedFav) return 'tile-green';
    return '';
  }

  /**
   * Ratio highlight classes per team name.
   * ≥5 red on that (public) side; 2–4.99 yellow; &lt;1 on ML favorite → green.
   */
  function teamHighlightMap(g) {
    const map = {};
    const pub = Number(g.publicRatio);
    const underrated = underratedFavorite(g);

    if (g.publicTeam && Number.isFinite(pub)) {
      if (pub >= 5) map[g.publicTeam] = 'ratio-hi';
      else if (pub >= 2) map[g.publicTeam] = 'ratio-mid';
    }

    if (underrated) {
      map[underrated.team] = 'ratio-lo';
    } else if (g.publicTeam && Number.isFinite(pub) && pub < 1 && favoriteIsAway(g) == null) {
      map[g.publicTeam] = 'ratio-lo';
    }

    return map;
  }

  function shortTeamName(name) {
    if (!name) return '';
    const s = String(name)
      .trim()
      .replace(/\s+W$/i, '')
      .trim();
    if (/white\s*sox/i.test(s)) return 'White Sox';
    if (/blue\s*jays/i.test(s)) return 'Blue Jays';
    if (/red\s*sox/i.test(s)) return 'Red Sox';
    const parts = s.split(/\s+/).filter(Boolean);
    while (parts.length > 1 && /^[Ww]$/.test(parts[parts.length - 1])) parts.pop();
    return parts[parts.length - 1] || s;
  }

  /** fav | dog for a side vs current/open ML; null if unknown */
  function sideRole(g, team) {
    if (!team) return null;
    const favAway = favoriteIsAway(g);
    if (favAway == null) return null;
    if (team === g.away) return favAway ? 'fav' : 'dog';
    if (team === g.home) return favAway ? 'dog' : 'fav';
    return null;
  }

  /** Favorite's ZCode % ratio (ML fav from Bet105). */
  function favRatioOf(g) {
    if (Number.isFinite(Number(g.favRatio))) return Number(g.favRatio);
    const r1 = Number(g.publicRatio1);
    const r2 = Number(g.publicRatio2);
    const favAway = favoriteIsAway(g);
    if (favAway === true && Number.isFinite(r1)) return r1;
    if (favAway === false && Number.isFinite(r2)) return r2;
    return null;
  }

  function notRespectedLabel(g) {
    const team = shortTeamName(g.publicTeam) || 'Public';
    const ratio = Number.isFinite(Number(g.publicRatio))
      ? Number(g.publicRatio).toFixed(2)
      : '—';
    const role = sideRole(g, g.publicTeam);
    const roleBit = role ? ` (${role})` : '';
    return `${team} ${ratio}x ratio${roleBit} not respected`;
  }

  function fmtGdate(raw) {
    if (!raw) return '';
    const s = String(raw).trim();
    // "2026-08-21 21:00:00" → "8/21 9:00p"
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    if (!m) return s;
    const mo = parseInt(m[2], 10);
    const day = parseInt(m[3], 10);
    let h = parseInt(m[4], 10);
    const min = m[5];
    const ap = h >= 12 ? 'p' : 'a';
    h = h % 12;
    if (h === 0) h = 12;
    return `${mo}/${day} ${h}:${min}${ap}`;
  }

  function teamHtml(name, hlMap, hlKey) {
    if (!name) return '—';
    const cls = hlMap[hlKey != null ? hlKey : name];
    const text = escapeHtml(name);
    if (!cls) return text;
    return `<span class="team-hl ${cls}">${text}</span>`;
  }

  function publicBorderClass(g) {
    // Thick = ML tickets line shade; thin = ML/spread tickets-difference shade
    if (g.mlTicketsHl === 'red') return ' ml-tix-border-hi-thick';
    if (g.mlTicketsHl === 'yellow') return ' ml-tix-border-mid-thick';
    if (g.tixDiffHl === 'red') return ' ml-tix-border-hi';
    if (g.tixDiffHl === 'yellow') return ' ml-tix-border-mid';
    return '';
  }

  function render() {
    const payload = getPayload();

    if (!payload || !Array.isArray(payload.games) || payload.games.length === 0) {
      setStatus(
        'warn',
        'Waiting for Tampermonkey companion…',
        'Click Open ZCode tabs (logged in) · keep dashboard open with userscript'
      );
      slateBody.innerHTML =
        '<tr class="empty"><td colspan="10">No slate yet. Click Open ZCode tabs while logged in, keep this tab open with the userscript installed.</td></tr>';
      return;
    }

    const all = enrich(payload.games);
    const games = sortGames(all);
    syncSortHeaders();
    const ageSec = payload.updatedAt
      ? Math.max(0, Math.round((Date.now() - payload.updatedAt) / 1000))
      : null;
    const pinnyAge = payload.pinnyUpdatedAt
      ? Math.max(0, Math.round((Date.now() - payload.pinnyUpdatedAt) / 1000))
      : null;

    const nRed = games.filter((g) => g.tile === 'tile-red').length;
    const nYellow = games.filter((g) => g.tile === 'tile-yellow').length;
    const nGreen = games.filter((g) => g.tile === 'tile-green').length;
    const sports =
      (payload.sportsPresent && payload.sportsPresent.length
        ? payload.sportsPresent
        : [...new Set(games.map((g) => g.sport).filter(Boolean))]) || [];

    setStatus(
      'ok',
      `${games.length} games · ${nRed} red · ${nYellow} yellow · ${nGreen} green`,
      [
        sports.length ? sports.join('+') : null,
        ageSec != null ? `ZCode ${ageSec}s ago` : null,
        pinnyAge != null ? `Bet105 ${pinnyAge}s ago` : 'Bet105 pending',
        payload.pinnyError ? `Bet105: ${payload.pinnyError}` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    );

    slateBody.innerHTML = games
      .map((g, idx) => {
        const rowClass = g.tile || '';
        let signalHtml;
        if (g.signal === 'not-respected') {
          signalHtml =
            `<span class="signal-badge yes">${escapeHtml(notRespectedLabel(g))}</span>`;
        } else if (g.signal === 'no-pinny') {
          signalHtml = '<span class="signal-badge unknown">No Bet105 match</span>';
        } else {
          signalHtml = '<span class="signal-badge no">Watch</span>';
        }

        const favRatio = favRatioOf(g);
        const hl = teamHighlightMap(g);
        const oddsFlow = fmtOddsFlow(g, hl);

        const moveLabel =
          g.pinnyTowardTeam ||
          (g.pinnyToward === 'fade'
            ? g.fadeTeam
            : g.pinnyToward === 'public'
              ? g.publicTeam
              : g.pinnyToward === 'unchanged'
                ? 'Flat'
                : '—');

        const takeTeam = g.fadeTeam;
        const sport = g.sport || 'MLB';
        const sportCls =
          sport === 'NFL'
            ? 'sport-badge nfl'
            : sport === 'WNBA'
              ? 'sport-badge wnba'
              : 'sport-badge';

        return (
          `<tr class="${rowClass}">` +
          `<td>${idx + 1}</td>` +
          `<td><span class="${sportCls}">${escapeHtml(sport)}</span></td>` +
          `<td class="gdate">${g.gdate ? escapeHtml(fmtGdate(g.gdate)) : '—'}</td>` +
          `<td class="matchup">${teamHtml(g.away, hl)} @ ${teamHtml(g.home, hl)}</td>` +
          `<td class="public-cell"><span class="public-box${publicBorderClass(
            g
          )}">${teamHtml(g.publicTeam, hl)}${
            (() => {
              const pop = Number(g.popularNumber);
              // Number(null) === 0 — only show real ranks ≥ 1
              if (!Number.isFinite(pop) || pop < 1) return '';
              return `<span class="popular-num" title="ML tickets popular rank">(#${pop})</span>`;
            })()
          }</span></td>` +
          `<td class="ratio-val">${favRatio != null ? favRatio.toFixed(2) : '—'}x</td>` +
          `<td class="take-pick">${teamHtml(takeTeam, hl)}</td>` +
          `<td class="odds">${oddsFlow}</td>` +
          `<td>${escapeHtml(moveLabel)}</td>` +
          `<td>${signalHtml}</td>` +
          `</tr>`
        );
      })
      .join('');
  }

  window.addEventListener('pinny-fade-slate', function (e) {
    if (e && e.detail) {
      window.__PINNY_FADE_SLATE__ = e.detail;
    }
    render();
  });

  document.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', function () {
      const mode = th.getAttribute('data-sort');
      sortMode = sortMode === mode ? 'default' : mode;
      render();
    });
  });

  if (defaultSortBtn) {
    defaultSortBtn.addEventListener('click', function () {
      sortMode = 'default';
      render();
    });
  }

  refreshBtn.addEventListener('click', function () {
    if (warnIfNoCompanion()) {
      render();
      return;
    }
    window.dispatchEvent(new CustomEvent('pinny-fade-request-refresh'));
    render();
  });

  if (openZcodeBtn) {
    openZcodeBtn.addEventListener('click', function () {
      const payload = getPayload();
      const sports =
        (payload && payload.sportsPresent && payload.sportsPresent.length
          ? payload.sportsPresent
          : DEFAULT_ZCODE_SPORTS);
      if (!tmConnected()) {
        openZcodeTabsFallback(sports);
        setStatus(
          'warn',
          'Opened odds-scores + ZCode — but Tampermonkey is not on this page',
          location.protocol === 'file:'
            ? 'Enable TM “Allow access to file URLs”, or use Live Server (localhost)'
            : 'Enable Pinny Fade userscript for this URL, then hard-refresh'
        );
        return;
      }
      window.dispatchEvent(
        new CustomEvent('pinny-fade-open-zcode', { detail: { sports } })
      );
      setStatus(
        'ok',
        'Opening ZCode…',
        `Tabs: ${(sports || DEFAULT_ZCODE_SPORTS).join(', ')}`
      );
    });
  }

  function nyDateKey(ms) {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(ms || Date.now()));
    } catch (_) {
      const d = new Date(ms || Date.now());
      return d.toISOString().slice(0, 10);
    }
  }

  function buildExportPayload(slate) {
    const date = nyDateKey(Date.now());
    const games = ((slate && slate.games) || []).map((g) =>
      Object.assign({}, g, {
        finalAway: g.finalAway != null ? g.finalAway : null,
        finalHome: g.finalHome != null ? g.finalHome : null,
        result: g.result || 'pending',
        resultNote: g.resultNote || '',
      })
    );
    return {
      date,
      exportedAt: Date.now(),
      sportsPresent: (slate && slate.sportsPresent) || [],
      games,
    };
  }

  function downloadJson(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (exportBtn) {
    exportBtn.addEventListener('click', function () {
      const slate = getPayload();
      if (!slate || !Array.isArray(slate.games) || !slate.games.length) {
        setStatus('warn', 'Nothing to export', 'Wait for the live slate to fill first');
        return;
      }
      const payload = buildExportPayload(slate);
      downloadJson(`pinny-fade-${payload.date}.json`, payload);
      setStatus(
        'ok',
        `Exported ${payload.games.length} games`,
        `${payload.date} · drop into history/ or rely on TM GitHub backup`
      );
      window.dispatchEvent(
        new CustomEvent('pinny-fade-request-backup', { detail: payload })
      );
    });
  }

  window.addEventListener('pinny-fade-backup-status', function (e) {
    const d = (e && e.detail) || {};
    if (d.ok) {
      setStatus(
        'ok',
        d.message || 'GitHub backup saved',
        d.meta || ''
      );
    } else if (d.message) {
      setStatus('warn', d.message, d.meta || '');
    }
  });

  setTimeout(function () {
    if (!tmConnected() && !getPayload()) warnIfNoCompanion();
  }, 1200);

  setInterval(render, 2000);
  render();
})();
