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

  const statusBar = document.getElementById('statusBar');
  const statusText = document.getElementById('statusText');
  const statusMeta = document.getElementById('statusMeta');
  const snapBody = document.getElementById('snapBody');
  const standingsBody = document.getElementById('standingsBody');
  const searchInput = document.getElementById('searchInput');
  const filterUngraded = document.getElementById('filterUngraded');
  const reloadBtn = document.getElementById('reloadBtn');

  let snaps = [];
  let updatedAt = null;
  const openDetail = new Set();
  let espnCache = new Map();

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

  function aggregateStandings() {
    const map = new Map();
    snaps.forEach((s) => {
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
        '<tr class="empty"><td colspan="7">Waiting for graded snaps…</td></tr>';
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
      setStatus('warn', 'No snaps yet', 'Open 4codds · TM menu → Book League: Set GitHub token');
    } else {
      setStatus(
        'ok',
        snaps.length + ' snap' + (snaps.length === 1 ? '' : 's') + ' · ' + graded + ' graded',
        'Data ' + when + ' · ESPN poll ' + LIVE_POLL_MS / 1000 + 's'
      );
    }
    renderStandings();
    renderSnaps();
  }

  function loadFromWindow() {
    const data = window.__BOOK_LEAGUE_DATA__;
    if (!data || typeof data !== 'object') {
      snaps = [];
      updatedAt = null;
      return false;
    }
    snaps = Array.isArray(data.snaps) ? data.snaps.slice() : [];
    snaps.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
    updatedAt = data.updatedAt || null;
    return true;
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

  /** Common board abbrevs → tokens that appear in ESPN display names. */
  const TEAM_ABBR = {
    lad: ['lad', 'dodgers'],
    mil: ['mil', 'brewers'],
    nyy: ['nyy', 'yankees'],
    bos: ['bos', 'red sox'],
    chc: ['chc', 'cubs'],
    chw: ['chw', 'white sox'],
    cle: ['cle', 'guardians'],
    det: ['det', 'tigers'],
    kc: ['kc', 'royals'],
    min: ['min', 'twins'],
    hou: ['hou', 'astros'],
    sea: ['sea', 'mariners'],
    tex: ['tex', 'rangers'],
    oak: ['oak', 'athletics'],
    ath: ['ath', 'athletics'],
    laa: ['laa', 'angels'],
    sd: ['sd', 'padres'],
    sf: ['sf', 'giants'],
    ari: ['ari', 'diamondbacks'],
    col: ['col', 'rockies'],
    atl: ['atl', 'braves'],
    phi: ['phi', 'phillies'],
    nym: ['nym', 'mets'],
    wsh: ['wsh', 'nationals'],
    mia: ['mia', 'marlins'],
    cin: ['cin', 'reds'],
    pit: ['pit', 'pirates'],
    stl: ['stl', 'cardinals'],
    tb: ['tb', 'rays'],
    tor: ['tor', 'blue jays'],
    bal: ['bal', 'orioles'],
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
    if (/NFL/i.test(league) || sport === 'football' || sport === 'nfl') return 'NFL';
    if (/NCAAF|CFB/i.test(league) || sport === 'ncaaf') return 'NCAAF';
    if (/NBA/i.test(league) || sport === 'basketball' || sport === 'nba') return 'NBA';
    if (/WNBA/i.test(league)) return 'WNBA';
    if (/NCAAB|CBB/i.test(league)) return 'NCAAB';
    return null;
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

  function applyEspnToSnap(s, ev) {
    if (!ev) return false;
    let dirty = false;
    if (ev.status && s.status !== ev.status) {
      s.status = ev.status;
      dirty = true;
    }
    if (!ev.completed) return dirty;
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
      const sportKey = sportKeyFromSnap(s);
      const day = ymdCompactFromTs(s.at);
      if (!sportKey || !day) continue;
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
      const ev = matchEspnEvent(s, (pack && pack.events) || []);
      if (applyEspnToSnap(s, ev)) changed = true;
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

  if (searchInput) searchInput.addEventListener('input', renderSnaps);
  if (filterUngraded) filterUngraded.addEventListener('change', renderSnaps);
  if (reloadBtn) {
    reloadBtn.addEventListener('click', () => {
      location.reload();
    });
  }

  if (loadFromWindow()) {
    // Show every book's prices + TDRs by default (collapse still works).
    snaps.forEach((s) => openDetail.add(snapKey(s)));
    render();
    pollEspn();
    setInterval(pollEspn, LIVE_POLL_MS);
  } else {
    setStatus('warn', 'No data file', 'Missing book-league/book-league-data.js');
    render();
  }
})();
