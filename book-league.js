(function () {
  'use strict';

  const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
  const SPORT_META = {
    MLB: { path: 'baseball/mlb' },
    NHL: { path: 'hockey/nhl' },
    NFL: { path: 'football/nfl' },
    NCAAF: { path: 'football/college-football', groups: '80' },
    NBA: { path: 'basketball/nba' },
    WNBA: { path: 'basketball/wnba' },
    NCAAB: { path: 'basketball/mens-college-basketball', groups: '50' },
  };
  const LIVE_POLL_MS = 60000;

  const SPORT_ORDER = ['NFL', 'NCAAF', 'NHL', 'MLB', 'NBA', 'WNBA', 'NCAAB'];
  const SPORT_FILTER_KEY = 'bookLeagueSportFilter';

  const statusBar = document.getElementById('statusBar');
  const statusText = document.getElementById('statusText');
  const statusMeta = document.getElementById('statusMeta');
  const snapBody = document.getElementById('snapBody');
  const standingsBody = document.getElementById('standingsBody');
  const sportFilters = document.getElementById('sportFilters');
  const searchInput = document.getElementById('searchInput');
  const filterUngraded = document.getElementById('filterUngraded');
  const reloadBtn = document.getElementById('reloadBtn');

  let snaps = [];
  let updatedAt = null;
  let dataSource = 'file';
  let sportFilter = '';
  const openDetail = new Set();
  let espnCache = new Map();
  let espnStarted = false;

  try {
    sportFilter = String(sessionStorage.getItem(SPORT_FILTER_KEY) || '');
  } catch (_) {
    sportFilter = '';
  }

  function setStatus(kind, text, meta) {
    statusBar.classList.remove('ok', 'warn');
    if (kind) statusBar.classList.add(kind);
    statusText.textContent = text;
    statusMeta.textContent = meta || '';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtWhen(at) {
    const n = Number(at);
    if (!Number.isFinite(n) || n <= 0) return '—';
    const d = new Date(n);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  function fmtAm(a) {
    if (a == null || !Number.isFinite(a)) return '—';
    a = Math.round(a);
    if (a === -100) return '+100';
    return a > 0 ? '+' + a : String(a);
  }

  function snapKey(s) {
    return [
      s.id || '',
      s.market || '',
      s.hourBucket != null ? s.hourBucket : Math.floor((Number(s.at) || 0) / 3600000),
    ].join('|');
  }

  function midRank(y) {
    const n = Number(y);
    if (!Number.isFinite(n) || n < 1) return null;
    return Math.ceil(n / 2);
  }

  function pointsForBook(favRank, y, favWon) {
    if (favRank == null || !Number.isFinite(favRank)) return null;
    const mid = midRank(y);
    if (mid == null) return null;
    const base = mid - favRank;
    return favWon ? -base : base;
  }

  function isGraded(s) {
    return s && s.winnerTeamIdx != null && s.winnerTeamIdx !== '';
  }

  function favWonSnap(s) {
    if (!isGraded(s) || s.winnerTeamIdx === 'void') return null;
    const teams = Array.isArray(s.teams) ? s.teams : [];
    const favTeam = s.favTeam;
    const winnerIdx = Number(s.winnerTeamIdx);
    if (!Number.isFinite(winnerIdx) || winnerIdx < 0 || winnerIdx > 1) return null;
    const winnerName = teams[winnerIdx];
    if (favTeam && winnerName) return winnerName === favTeam;
    if (s.favSide === 0 || s.favSide === 1) return winnerIdx === s.favSide;
    return null;
  }

  function ptsClass(pts) {
    if (pts == null) return 'bl-pts-zero';
    if (pts > 0) return 'bl-pts-pos';
    if (pts < 0) return 'bl-pts-neg';
    return 'bl-pts-zero';
  }

  function fmtPts(pts) {
    if (pts == null) return '—';
    if (pts > 0) return '+' + pts;
    return String(pts);
  }

  function bookRows(s) {
    const books = s && s.books && typeof s.books === 'object' ? s.books : {};
    return Object.keys(books)
      .map((code) => {
        const b = books[code] || {};
        return {
          code: code,
          name: b.name || code,
          favPrice: b.favPrice,
          favRank: b.favRank,
          favJoint: !!b.favJoint,
          dogPrice: b.dogPrice,
          dogRank: b.dogRank,
          dogJoint: !!b.dogJoint,
        };
      })
      .filter((b) => b.favRank != null || b.favPrice != null || b.dogPrice != null)
      .sort((a, b) => {
        const ra = a.favRank == null ? 999 : a.favRank;
        const rb = b.favRank == null ? 999 : b.favRank;
        return ra - rb || String(a.name).localeCompare(String(b.name));
      });
  }

  /** Same tier rules as 4codds-consensus attachPriceRankBadge. */
  function priceRankTierClass(rank) {
    if (rank === 1) return 'tier-best';
    if (rank >= 2 && rank <= 4) return 'tier-green';
    if (rank >= 10) return 'tier-deep';
    return '';
  }

  function tdrBadgeHtml(rank, joint, y, role) {
    if (rank == null || !y) return '<span class="pc-price-rank muted">—</span>';
    const tier = priceRankTierClass(rank);
    const cls =
      'pc-price-rank' +
      (role === 'dog' ? ' role-dog' : '') +
      (tier ? ' ' + tier : '') +
      (joint ? ' is-joint' : '');
    const label = (joint ? 'J' : '') + rank + '/' + y;
    const title = (joint ? 'joint ' : '') + role + ' ' + rank + ' of ' + y;
    return (
      '<span class="' +
      cls +
      '" title="' +
      escapeHtml(title) +
      '">' +
      escapeHtml(label) +
      '</span>'
    );
  }

  function snapSport(s) {
    return sportKeyFromSnap(s) || 'OTHER';
  }

  function sportsInData() {
    const set = new Set();
    snaps.forEach((s) => {
      if (s) set.add(snapSport(s));
    });
    const ordered = SPORT_ORDER.filter((k) => set.has(k));
    const rest = Array.from(set)
      .filter((k) => k !== 'OTHER' && !SPORT_ORDER.includes(k))
      .sort();
    if (set.has('OTHER')) rest.push('OTHER');
    return ordered.concat(rest);
  }

  function isAllSportFilter() {
    return !sportFilter || sportFilter === 'ALL';
  }

  function matchesSportFilter(s) {
    return isAllSportFilter() || snapSport(s) === sportFilter;
  }

  function ensureSportFilter() {
    const sports = sportsInData();
    if (!sports.length) {
      sportFilter = 'ALL';
      return sports;
    }
    if (sportFilter !== 'ALL' && (!sportFilter || !sports.includes(sportFilter))) {
      // Prefer sport with the most graded snaps
      let best = sports[0];
      let bestN = -1;
      sports.forEach((k) => {
        const n = snaps.filter((s) => snapSport(s) === k && isGraded(s)).length;
        if (n > bestN) {
          bestN = n;
          best = k;
        }
      });
      sportFilter = best;
    }
    try {
      sessionStorage.setItem(SPORT_FILTER_KEY, sportFilter);
    } catch (_) {}
    return sports;
  }

  function setSportFilter(key) {
    sportFilter = String(key || 'ALL');
    try {
      sessionStorage.setItem(SPORT_FILTER_KEY, sportFilter);
    } catch (_) {}
    render();
  }

  function renderSportFilters() {
    if (!sportFilters) return;
    const sports = ensureSportFilter();
    if (!sports.length) {
      sportFilters.innerHTML = '';
      return;
    }
    const tabs = ['ALL'].concat(sports);
    sportFilters.innerHTML = tabs
      .map((k) => {
        const all = k === 'ALL';
        const n = all
          ? snaps.length
          : snaps.filter((s) => snapSport(s) === k).length;
        const graded = all
          ? snaps.filter(isGraded).length
          : snaps.filter((s) => snapSport(s) === k && isGraded(s)).length;
        const active = all ? isAllSportFilter() : k === sportFilter;
        return (
          '<button type="button" class="bl-chip' +
          (active ? ' is-active' : '') +
          '" role="tab" aria-selected="' +
          (active ? 'true' : 'false') +
          '" data-sport="' +
          escapeHtml(k) +
          '" title="' +
          escapeHtml(graded + ' graded / ' + n + ' snaps') +
          '">' +
          escapeHtml(k) +
          ' <span style="opacity:.65;font-weight:600">' +
          graded +
          '</span></button>'
        );
      })
      .join('');
  }

  function aggregateStandings() {
    const map = new Map();
    snaps.forEach((s) => {
      if (!matchesSportFilter(s)) return;
      const won = favWonSnap(s);
      if (won == null) return;
      bookRows(s).forEach((b) => {
        if (b.favRank == null) return;
        const pts = pointsForBook(b.favRank, s.y, won);
        if (pts == null) return;
        const key = b.code || b.name;
        let row = map.get(key);
        if (!row) {
          row = { code: b.code, name: b.name, games: 0, pts: 0, correct: 0, wrong: 0 };
          map.set(key, row);
        }
        row.games += 1;
        row.pts += pts;
        if (pts > 0) row.correct += 1;
        else if (pts < 0) row.wrong += 1;
      });
    });
    return Array.from(map.values()).sort((a, b) => {
      if (b.pts !== a.pts) return b.pts - a.pts;
      const avgA = a.games ? a.pts / a.games : 0;
      const avgB = b.games ? b.pts / b.games : 0;
      if (avgB !== avgA) return avgB - avgA;
      return b.games - a.games || String(a.name).localeCompare(String(b.name));
    });
  }

  function renderStandings() {
    const rows = aggregateStandings();
    if (!rows.length) {
      standingsBody.innerHTML =
        '<tr class="empty"><td colspan="7">' +
        (isAllSportFilter()
          ? 'Waiting for graded snaps…'
          : 'No graded ' + escapeHtml(sportFilter) + ' snaps yet…') +
        '</td></tr>';
      return;
    }
    standingsBody.innerHTML = rows
      .map((r, i) => {
        const avg = r.games ? r.pts / r.games : 0;
        return (
          '<tr>' +
          '<td class="rank">' +
          (i + 1) +
          '</td>' +
          '<td>' +
          escapeHtml(r.name || r.code) +
          '</td>' +
          '<td>' +
          r.games +
          '</td>' +
          '<td class="' +
          ptsClass(r.pts) +
          '">' +
          escapeHtml(fmtPts(r.pts)) +
          '</td>' +
          '<td class="' +
          ptsClass(avg) +
          '">' +
          escapeHtml((avg > 0 ? '+' : '') + avg.toFixed(2)) +
          '</td>' +
          '<td>' +
          r.correct +
          '</td>' +
          '<td>' +
          r.wrong +
          '</td>' +
          '</tr>'
        );
      })
      .join('');
  }

  function filtered() {
    const q = String((searchInput && searchInput.value) || '')
      .trim()
      .toLowerCase();
    const onlyUngraded = !!(filterUngraded && filterUngraded.checked);
    return snaps.filter((s) => {
      if (!matchesSportFilter(s)) return false;
      if (onlyUngraded && isGraded(s)) return false;
      if (!q) return true;
      const bookBlob = bookRows(s)
        .map((b) => [b.code, b.name].join(' '))
        .join(' ');
      const blob = [
        (s.teams || []).join(' '),
        s.favTeam,
        s.dogTeam,
        s.league,
        s.sport,
        s.market,
        s.best && s.best.fav && s.best.fav.book,
        s.best && s.best.dog && s.best.dog.book,
        bookBlob,
      ]
        .join(' ')
        .toLowerCase();
      return blob.includes(q);
    });
  }

  function bestCell(side) {
    if (!side || side.price == null) return '—';
    return (
      escapeHtml(side.book || '?') +
      ' <b>' +
      escapeHtml(fmtAm(side.price)) +
      '</b>'
    );
  }

  function openCell(s) {
    const o = s && s.open;
    if (!o) return '—';
    const a = o.away != null ? o.away : o.fav;
    const b = o.home != null ? o.home : o.dog;
    if (a == null && b == null) return '—';
    return (
      '<span class="bl-best" title="Pinnacle open (away / home)">' +
      escapeHtml(fmtAm(a)) +
      ' / ' +
      escapeHtml(fmtAm(b)) +
      '</span>'
    );
  }

  function scoreCell(s) {
    if (s.awayScore != null && s.homeScore != null) {
      return (
        '<span class="bl-score">' +
        escapeHtml(String(s.awayScore)) +
        '–' +
        escapeHtml(String(s.homeScore)) +
        '</span>'
      );
    }
    if (s.status) return '<span class="bl-score">' + escapeHtml(s.status) + '</span>';
    return '—';
  }

  function gradeLabel(s) {
    if (s.winnerTeamIdx === 'void') {
      return '<span class="bl-grade pending">void / tie</span>';
    }
    const won = favWonSnap(s);
    if (won == null) {
      if (s.status && !isGraded(s)) {
        return '<span class="bl-grade live">' + escapeHtml(s.status) + '</span>';
      }
      return '<span class="bl-grade pending">pending</span>';
    }
    return (
      '<span class="bl-grade ok">' + (won ? 'fav won' : 'fav lost') + '</span>'
    );
  }

  function detailHtml(s) {
    const won = favWonSnap(s);
    const rows = bookRows(s);
    const y = s.y;
    if (!rows.length) {
      return '<div style="padding:10px 12px;opacity:.7">No book prices.</div>';
    }
    return (
      '<table class="bl-books"><thead><tr>' +
      '<th>Book</th><th>Fav</th><th>Fav TDR</th><th>Dog</th><th>Dog TDR</th><th>Pts</th>' +
      '</tr></thead><tbody>' +
      rows
        .map((b) => {
          const pts =
            won == null || b.favRank == null ? null : pointsForBook(b.favRank, s.y, won);
          return (
            '<tr>' +
            '<td>' +
            escapeHtml(b.name || b.code) +
            '</td>' +
            '<td class="bl-px">' +
            escapeHtml(fmtAm(b.favPrice)) +
            '</td>' +
            '<td>' +
            tdrBadgeHtml(b.favRank, b.favJoint, y, 'fav') +
            '</td>' +
            '<td class="bl-px">' +
            escapeHtml(fmtAm(b.dogPrice)) +
            '</td>' +
            '<td>' +
            tdrBadgeHtml(b.dogRank, b.dogJoint, y, 'dog') +
            '</td>' +
            '<td class="' +
            ptsClass(pts) +
            '">' +
            escapeHtml(fmtPts(pts)) +
            '</td>' +
            '</tr>'
          );
        })
        .join('') +
      '</tbody></table>'
    );
  }

  function renderSnaps() {
    const rows = filtered();
    if (!rows.length) {
      snapBody.innerHTML =
        '<tr class="empty"><td colspan="10">' +
        (snaps.length
          ? 'No snaps match this filter.'
          : 'No snaps yet — open 4codds with the userscript.') +
        '</td></tr>';
      return;
    }
    const html = [];
    rows.forEach((s) => {
      const k = snapKey(s);
      const open = openDetail.has(k);
      const matchup = Array.isArray(s.teams) ? s.teams.join(' @ ') : '—';
      html.push(
        '<tr data-row="' +
          escapeHtml(k) +
          '">' +
          '<td><button type="button" class="bl-expand" data-toggle="' +
          escapeHtml(k) +
          '">' +
          (open ? 'Hide' : 'Books') +
          '</button></td>' +
          '<td class="bl-when">' +
          escapeHtml(fmtWhen(s.at)) +
          '</td>' +
          '<td>' +
          escapeHtml(matchup) +
          (s.league || s.market
            ? '<div style="opacity:.55;font-size:11px;margin-top:2px">' +
              escapeHtml([s.league, s.market].filter(Boolean).join(' · ')) +
              '</div>'
            : '') +
          '</td>' +
          '<td>' +
          escapeHtml(s.favTeam || '—') +
          '</td>' +
          '<td>' +
          (s.y != null ? s.y : '—') +
          '</td>' +
          '<td class="bl-best">' +
          bestCell(s.best && s.best.fav) +
          '</td>' +
          '<td class="bl-best">' +
          bestCell(s.best && s.best.dog) +
          '</td>' +
          '<td>' +
          openCell(s) +
          '</td>' +
          '<td>' +
          scoreCell(s) +
          '</td>' +
          '<td>' +
          gradeLabel(s) +
          '</td>' +
          '</tr>'
      );
      if (open) {
        html.push(
          '<tr class="bl-detail" data-detail="' +
            escapeHtml(k) +
            '"><td colspan="10">' +
            detailHtml(s) +
            '</td></tr>'
        );
      }
    });
    snapBody.innerHTML = html.join('');
  }

  function sourceLabel() {
    if (dataSource === 'local') return 'local Tampermonkey';
    if (dataSource === 'github') return 'GitHub (global)';
    if (dataSource === 'merged') return 'merged local + file';
    if (dataSource === 'file') return 'book-league-data.js';
    return dataSource || 'file';
  }

  function render() {
    const graded = snaps.filter(isGraded).length;
    const when = updatedAt
      ? new Date(updatedAt).toLocaleString([], {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })
      : '—';
    if (!snaps.length) {
      setStatus(
        'warn',
        'No snaps yet',
        'Open 4codds with the userscript (local store + optional GitHub token)'
      );
    } else {
      const sportBit = isAllSportFilter()
        ? ' · ALL ' + graded + '/' + snaps.length
        : ' · ' +
          sportFilter +
          ' ' +
          snaps.filter((s) => snapSport(s) === sportFilter && isGraded(s)).length +
          '/' +
          snaps.filter((s) => snapSport(s) === sportFilter).length;
      setStatus(
        'ok',
        snaps.length +
          ' snap' +
          (snaps.length === 1 ? '' : 's') +
          ' · ' +
          graded +
          ' graded' +
          sportBit,
        sourceLabel() + ' · ' + when + ' · ESPN ' + LIVE_POLL_MS / 1000 + 's'
      );
    }
    renderSportFilters();
    renderStandings();
    renderSnaps();
  }

  function applyPayload(data, sourceHint) {
    if (!data || typeof data !== 'object') return false;
    snaps = Array.isArray(data.snaps) ? data.snaps.slice() : [];
    snaps.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
    updatedAt = data.updatedAt || null;
    dataSource = sourceHint || data.source || 'file';
    snaps.forEach((s) => openDetail.add(snapKey(s)));
    render();
    if (!espnStarted) {
      espnStarted = true;
      pollEspn();
      setInterval(pollEspn, LIVE_POLL_MS);
    }
    return true;
  }

  function loadFromWindow() {
    const data = window.__BOOK_LEAGUE_DATA__;
    if (!data || typeof data !== 'object') {
      snaps = [];
      updatedAt = null;
      dataSource = 'file';
      return false;
    }
    return applyPayload(data, data.source || 'file');
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

  /** Common board abbrevs → ESPN abbr / name tokens (MLB + NHL board quirks). */
  const TEAM_ABBR = {
    lad: ['lad', 'dodgers'],
    mil: ['mil', 'brewers'],
    nyy: ['nyy', 'yankees'],
    bos: ['bos', 'red sox', 'bruins'],
    chc: ['chc', 'cubs'],
    chw: ['chw', 'white sox'],
    cle: ['cle', 'guardians'],
    det: ['det', 'tigers', 'red wings'],
    kc: ['kc', 'royals'],
    min: ['min', 'twins', 'wild'],
    hou: ['hou', 'astros'],
    sea: ['sea', 'mariners', 'kraken'],
    tex: ['tex', 'rangers'],
    oak: ['oak', 'athletics'],
    ath: ['ath', 'athletics', 'oak'],
    laa: ['laa', 'angels'],
    sd: ['sd', 'padres'],
    sf: ['sf', 'giants'],
    ari: ['ari', 'diamondbacks', 'pho'],
    pho: ['pho', 'ari'],
    col: ['col', 'rockies', 'avalanche'],
    atl: ['atl', 'braves'],
    phi: ['phi', 'phillies', 'flyers'],
    nym: ['nym', 'mets'],
    wsh: ['wsh', 'nationals', 'was', 'capitals'],
    was: ['was', 'wsh'],
    mia: ['mia', 'marlins'],
    cin: ['cin', 'reds'],
    pit: ['pit', 'pirates', 'penguins'],
    stl: ['stl', 'cardinals', 'blues'],
    tb: ['tb', 'rays', 'tbl', 'lightning'],
    tbl: ['tbl', 'tb', 'lightning'],
    tor: ['tor', 'blue jays', 'maple leafs'],
    bal: ['bal', 'orioles'],
    // NHL board ↔ ESPN
    njd: ['njd', 'nj', 'devils'],
    nj: ['nj', 'njd'],
    sjs: ['sjs', 'sj', 'sharks'],
    sj: ['sj', 'sjs'],
    lak: ['lak', 'la', 'kings'],
    la: ['la', 'lak'],
    mon: ['mon', 'mtl', 'canadiens'],
    mtl: ['mtl', 'mon'],
    vgk: ['vgk', 'golden knights'],
    uta: ['uta', 'mammoth'],
    nyi: ['nyi', 'islanders'],
    nyr: ['nyr', 'rangers'],
    buf: ['buf', 'sabres'],
    ott: ['ott', 'senators'],
    car: ['car', 'hurricanes'],
    wpg: ['wpg', 'jets'],
    van: ['van', 'canucks'],
    cgy: ['cgy', 'flames'],
    edm: ['edm', 'oilers'],
    nsh: ['nsh', 'predators'],
    chi: ['chi', 'blackhawks'],
    fla: ['fla', 'panthers'],
    ana: ['ana', 'ducks'],
    dal: ['dal', 'stars'],
    cbj: ['cbj', 'blue jackets'],
  };

  function teamTokens(s) {
    const n = normTeam(s);
    if (!n) return [];
    const out = new Set([n]);
    const compact = n.replace(/\s+/g, '');
    if (compact) out.add(compact);
    const alias = TEAM_ABBR[compact] || TEAM_ABBR[n];
    if (alias) alias.forEach((t) => out.add(t));
    n.split(' ').filter(Boolean).forEach((t) => out.add(t));
    return Array.from(out);
  }

  function teamsMatch(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    // Abbrev ↔ full name (e.g. "lad" vs "los angeles dodgers")
    const ta = teamTokens(a);
    const tb = teamTokens(b);
    for (let i = 0; i < ta.length; i++) {
      for (let j = 0; j < tb.length; j++) {
        if (ta[i] === tb[j] && ta[i].length >= 2) return true;
        if (ta[i].length >= 4 && tb[j].length >= 4 && (ta[i].includes(tb[j]) || tb[j].includes(ta[i])))
          return true;
      }
    }
    if (a.length >= 5 && b.length >= 5 && (a.includes(b) || b.includes(a))) return true;
    const wa = a.split(' ').filter(Boolean);
    const wb = b.split(' ').filter(Boolean);
    if (wa.length >= 2 && wb.length >= 2) {
      const setB = new Set(wb);
      let hit = 0;
      for (let i = 0; i < wa.length; i++) if (setB.has(wa[i])) hit++;
      if (hit >= Math.min(2, wa.length, wb.length) && hit / Math.max(wa.length, wb.length) >= 0.6) {
        return true;
      }
    }
    return false;
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
    // /^NBA$/ so "WNBA" does not match as NBA
    if (/^NBA$/i.test(league) || sport === 'basketball' || sport === 'nba') return 'NBA';
    return null;
  }

  function sportKeysToTry(s) {
    const k = sportKeyFromSnap(s);
    if (k) return [k];
    return ['NHL', 'MLB', 'NFL', 'NBA', 'NCAAF', 'NCAAB', 'WNBA'];
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

  function daysToTryForSnap(s) {
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
      add(shiftYmdCompact(primary, -1));
      add(shiftYmdCompact(primary, 1));
    }
    return out;
  }

  async function fetchEspnBoard(sportKey, dateCompact) {
    const meta = SPORT_META[sportKey];
    if (!meta || !dateCompact) return [];
    let url = ESPN + '/' + meta.path + '/scoreboard?dates=' + dateCompact;
    if (meta.groups) url += '&groups=' + meta.groups;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return [];
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
        awayName: awayName,
        homeName: homeName,
        awayCanon: normTeam(awayName),
        homeCanon: normTeam(homeName),
        awayAbbr: normTeam(awayAbbr),
        homeAbbr: normTeam(homeAbbr),
        awayShort: normTeam(awayShort),
        homeShort: normTeam(homeShort),
        awayScore: Number.isFinite(awayScore) ? awayScore : null,
        homeScore: Number.isFinite(homeScore) ? homeScore : null,
      });
    }
    return out;
  }

  function isEspnPostponedStatus(status) {
    return /postpon|cancel|suspend|washout/i.test(String(status || ''));
  }

  function applyEspnToSnap(s, ev) {
    if (!ev) return false;
    let dirty = false;
    if (ev.status && s.status !== ev.status) {
      s.status = ev.status;
      dirty = true;
    }
    if (!ev.completed) {
      if (isEspnPostponedStatus(ev.status)) s._blDrop = true;
      return dirty;
    }
    if (isGraded(s)) {
      if (s.awayScore !== ev.awayScore || s.homeScore !== ev.homeScore) {
        s.awayScore = ev.awayScore;
        s.homeScore = ev.homeScore;
        dirty = true;
      }
      return dirty;
    }
    if (ev.awayScore == null || ev.homeScore == null) return dirty;
    const teams = s.teams || [];
    const a = normTeam(teams[0]);
    const h = normTeam(teams[1]);
    if (ev.awayScore === ev.homeScore) {
      s.winnerTeamIdx = 'void';
      s.gradedAt = Date.now();
      s.awayScore = ev.awayScore;
      s.homeScore = ev.homeScore;
      return true;
    }
    const awayWon = ev.awayScore > ev.homeScore;
    let winnerTeamIdx = null;
    if (
      sideMatch(a, ev.awayCanon, ev.awayAbbr, ev.awayShort) &&
      sideMatch(h, ev.homeCanon, ev.homeAbbr, ev.homeShort)
    ) {
      winnerTeamIdx = awayWon ? 0 : 1;
    } else if (
      sideMatch(a, ev.homeCanon, ev.homeAbbr, ev.homeShort) &&
      sideMatch(h, ev.awayCanon, ev.awayAbbr, ev.awayShort)
    ) {
      winnerTeamIdx = awayWon ? 1 : 0;
    } else {
      return dirty;
    }
    s.winnerTeamIdx = winnerTeamIdx;
    s.gradedAt = Date.now();
    s.awayScore = ev.awayScore;
    s.homeScore = ev.homeScore;
    return true;
  }

  function sideMatch(snapSide, canon, abbr, shortName) {
    return (
      teamsMatch(snapSide, canon) ||
      teamsMatch(snapSide, abbr) ||
      teamsMatch(snapSide, shortName) ||
      (abbr && snapSide === abbr) ||
      (shortName && snapSide === shortName)
    );
  }

  function matchEspnEvent(snap, events) {
    const teams = Array.isArray(snap.teams) ? snap.teams : [];
    if (teams.length < 2) return null;
    const a = normTeam(teams[0]);
    const h = normTeam(teams[1]);
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (
        sideMatch(a, e.awayCanon, e.awayAbbr, e.awayShort) &&
        sideMatch(h, e.homeCanon, e.homeAbbr, e.homeShort)
      )
        return e;
      if (
        sideMatch(a, e.homeCanon, e.homeAbbr, e.homeShort) &&
        sideMatch(h, e.awayCanon, e.awayAbbr, e.awayShort)
      )
        return e;
    }
    return null;
  }

  async function pollEspn() {
    const need = snaps.filter((s) => s && !isGraded(s));
    if (!need.length) return;
    let changed = false;
    for (let i = 0; i < need.length; i++) {
      const s = need[i];
      const sportKeys = sportKeysToTry(s);
      const days = daysToTryForSnap(s);
      if (!sportKeys.length || !days.length) continue;
      let ev = null;
      for (let si = 0; si < sportKeys.length && !ev; si++) {
        const sportKey = sportKeys[si];
        for (let di = 0; di < days.length && !ev; di++) {
          const day = days[di];
          const ck = sportKey + '|' + day;
          if (!espnCache.has(ck) || Date.now() - (espnCache.get(ck).at || 0) > LIVE_POLL_MS) {
            try {
              const events = await fetchEspnBoard(sportKey, day);
              espnCache.set(ck, { at: Date.now(), events: events });
            } catch (_) {
              espnCache.set(ck, { at: Date.now(), events: [] });
            }
          }
          const pack = espnCache.get(ck);
          ev = matchEspnEvent(s, (pack && pack.events) || []);
        }
      }
      if (applyEspnToSnap(s, ev)) changed = true;
    }
    const kept = snaps.filter((s) => s && !s._blDrop);
    if (kept.length !== snaps.length) {
      snaps.length = 0;
      for (let i = 0; i < kept.length; i++) snaps.push(kept[i]);
      changed = true;
    }
    if (changed) render();
  }

  if (snapBody) {
    snapBody.addEventListener('click', (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      const btn = t.closest('[data-toggle]');
      if (!btn) return;
      const k = btn.getAttribute('data-toggle');
      if (openDetail.has(k)) openDetail.delete(k);
      else openDetail.add(k);
      renderSnaps();
    });
  }

  if (sportFilters) {
    sportFilters.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest && e.target.closest('[data-sport]');
      if (!btn) return;
      setSportFilter(btn.getAttribute('data-sport'));
    });
  }
  if (searchInput) searchInput.addEventListener('input', renderSnaps);
  if (filterUngraded) filterUngraded.addEventListener('change', renderSnaps);
  if (reloadBtn) {
    reloadBtn.addEventListener('click', () => {
      location.reload();
    });
  }

  window.addEventListener('4c-book-league-data', (ev) => {
    const detail = ev && ev.detail;
    if (detail) applyPayload(detail, (detail && detail.source) || 'local');
  });

  if (loadFromWindow()) {
    // Initial paint from file / userscript hydrate. ESPN starts inside applyPayload.
  } else {
    setStatus(
      'warn',
      'No data yet',
      'Open 4codds with userscript, or keep book-league/book-league-data.js'
    );
    render();
  }
})();
