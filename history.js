(function () {
  'use strict';

  const statusBar = document.getElementById('statusBar');
  const statusText = document.getElementById('statusText');
  const statusMeta = document.getElementById('statusMeta');
  const daySelect = document.getElementById('daySelect');
  const histBody = document.getElementById('histBody');
  const slamBody = document.getElementById('slamBody');

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

  function fmtAmerican(n) {
    if (n == null || !Number.isFinite(n)) return '—';
    const r = Math.round(n);
    return r > 0 ? '+' + r : String(r);
  }

  function fmtSpreadNum(n) {
    if (n == null || !Number.isFinite(n)) return '—';
    if (n === 0) return 'PK';
    const abs = Math.abs(n);
    const half = Math.abs(abs - Math.floor(abs) - 0.5) < 1e-9;
    const core = half
      ? `${Math.floor(abs)}½`
      : Number.isInteger(n)
        ? String(abs)
        : String(abs);
    return (n > 0 ? '+' : '-') + core;
  }

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

  function sideDelta(open, curr, market) {
    if (!Number.isFinite(open) || !Number.isFinite(curr)) return null;
    return curr - open;
  }

  function fmtMoveInline(d, market) {
    if (!Number.isFinite(d) || d === 0) return '';
    const unit = market === 'spread' ? 'pt' : '¢';
    const sign = d > 0 ? '+' : '';
    const n = market === 'spread' ? d.toFixed(1).replace(/\.0$/, '') : String(Math.round(d));
    return `<span class="move-inline">${sign}${n}${unit}</span>`;
  }

  function fmtOddsFlow(g) {
    if (!g.pinnyMatched) return '—';
    const open = lineSides(g, 'open');
    const curr = lineSides(g, 'curr');
    const dAway = sideDelta(g.openAway, g.currAway, g.market);
    const dHome = sideDelta(g.openHome, g.currHome, g.market);
    return (
      `<span class="odds-flow">` +
      `<span class="odds-side">${escapeHtml(g.awayAbbr || g.away)} ` +
      `${escapeHtml(open.away)}${fmtMoveInline(dAway, g.market)}${escapeHtml(curr.away)}</span>` +
      `<span class="odds-side">${escapeHtml(g.homeAbbr || g.home)} ` +
      `${escapeHtml(open.home)}${fmtMoveInline(dHome, g.market)}${escapeHtml(curr.home)}</span>` +
      `</span>`
    );
  }

  function resultBadge(r) {
    const v = String(r || 'pending').toUpperCase();
    if (v === 'W') return '<span class="result-badge w">W</span>';
    if (v === 'P') return '<span class="result-badge p">P</span>';
    if (v === 'L') return '<span class="result-badge l">L</span>';
    return '<span class="result-badge pending">—</span>';
  }

  function scoreCell(g) {
    if (g.finalAway != null && g.finalHome != null) {
      return `${g.finalAway}–${g.finalHome}`;
    }
    if (g.scoreAway != null && g.scoreHome != null) {
      return `${g.scoreAway}–${g.scoreHome}`;
    }
    return '—';
  }

  function fmtSlamTime(ms) {
    if (!ms) return '—';
    try {
      return new Date(ms).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
    } catch (_) {
      return String(ms);
    }
  }

  function fmtSlamLine(from, to, market) {
    if (market === 'spread') {
      return `${fmtSpreadNum(from)}→${fmtSpreadNum(to)}`;
    }
    return `${fmtAmerican(from)}→${fmtAmerican(to)}`;
  }

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

  function teamSame(a, b, g) {
    if (!a || !b) return false;
    if (a === b) return true;
    const au = String(a).trim().toUpperCase();
    const bu = String(b).trim().toUpperCase();
    if (au === bu) return true;
    if (au.indexOf(bu) >= 0 || bu.indexOf(au) >= 0) return true;
    const sides = [
      [g.away, g.awayAbbr],
      [g.home, g.homeAbbr],
    ];
    let aSide = false;
    let bSide = false;
    sides.forEach(([full, abbr]) => {
      const fu = String(full || '').toUpperCase();
      const ab = String(abbr || '').toUpperCase();
      if (au === fu || au === ab || fu.indexOf(au) >= 0) aSide = true;
      if (bu === fu || bu === ab || fu.indexOf(bu) >= 0) bSide = true;
    });
    return aSide && bSide;
  }

  function ratioBandClass(ratio, game, team) {
    const r = Number(ratio);
    if (!Number.isFinite(r) || r <= 0) return '';
    if (game && team) {
      const underrated = underratedFavorite(game);
      if (underrated && teamSame(team, underrated.team, game)) return 'ratio-lo';
    } else if (game && r < 1) {
      return 'ratio-lo';
    }
    if (r >= 5) return 'ratio-hi';
    if (r >= 2) return 'ratio-mid';
    return '';
  }

  function favRatioOf(g) {
    if (Number.isFinite(Number(g.favRatio))) return Number(g.favRatio);
    const r1 = Number(g.publicRatio1);
    const r2 = Number(g.publicRatio2);
    const favAway = favoriteIsAway(g);
    if (favAway === true && Number.isFinite(r1)) return r1;
    if (favAway === false && Number.isFinite(r2)) return r2;
    return null;
  }

  function fmtRatioBadge(ratio, band) {
    if (ratio == null || !Number.isFinite(Number(ratio))) return '—';
    const cls = band ? `ratio-badge ${band}` : 'ratio-badge';
    return `<span class="${cls}">${Number(ratio).toFixed(2)}x</span>`;
  }

  function fmtSlamSpan(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    if (ms < 60000) return `${Math.round(ms / 1000)}s`;
    return `${(ms / 60000).toFixed(1).replace(/\.0$/, '')}m`;
  }

  function fmtSlamTowardHtml(s, games) {
    const team = s.towardTeam || '—';
    const ratio = Number(s.towardRatio);
    const pop = Number(s.towardPopular);
    const game = (games || []).find(
      (g) =>
        (g.eventId && s.eventId && String(g.eventId) === String(s.eventId)) ||
        ((g.sport || '') === (s.sport || '') &&
          String(g.away || '').toUpperCase() === String(s.away || '').toUpperCase() &&
          String(g.home || '').toUpperCase() === String(s.home || '').toUpperCase())
    );
    const band = ratioBandClass(ratio, game, team);
    const ratioHtml =
      Number.isFinite(ratio) && ratio > 0 ? fmtRatioBadge(ratio, band) : '';
    const popHtml =
      Number.isFinite(pop) && pop >= 1
        ? `<span class="popular-num" title="ML tickets popular rank">(#${Math.round(pop)})</span>`
        : '';
    if (!ratioHtml && !popHtml) {
      return escapeHtml(team);
    }
    return (
      `<span class="slam-toward-team">${escapeHtml(team)}</span>` +
      `<span class="slam-zcode-meta">${ratioHtml}${popHtml}</span>`
    );
  }

  function renderSlams(payload) {
    if (!slamBody) return;
    const games = (payload && payload.games) || [];
    const slams = ((payload && payload.slams) || [])
      .slice()
      .sort((a, b) => (b.slamTime || 0) - (a.slamTime || 0));
    if (!slams.length) {
      slamBody.innerHTML =
        '<tr class="empty"><td colspan="7">No slams in this archive.</td></tr>';
      return;
    }
    slamBody.innerHTML = slams
      .map((s) => {
        const sport = s.sport || 'MLB';
        const sportCls =
          sport === 'NFL'
            ? 'sport-badge nfl'
            : sport === 'WNBA'
              ? 'sport-badge wnba'
              : 'sport-badge';
        const matchup = `${escapeHtml(s.awayAbbr || s.away)} @ ${escapeHtml(
          s.homeAbbr || s.home
        )}`;
        const books = (s.books || []).map(escapeHtml).join(', ');
        const moves = (s.moves || [])
          .map(
            (m) =>
              `<span class="slam-move">${escapeHtml(m.book)} ${escapeHtml(
                fmtSlamLine(m.from, m.to, m.market || s.market)
              )}</span>`
          )
          .join(' ');
        return (
          `<tr>` +
          `<td class="slam-time">${escapeHtml(fmtSlamTime(s.slamTime))}</td>` +
          `<td><span class="${sportCls}">${escapeHtml(sport)}</span></td>` +
          `<td class="matchup">${matchup}</td>` +
          `<td class="take-pick slam-toward">${fmtSlamTowardHtml(s, games)}</td>` +
          `<td>${books || '—'}</td>` +
          `<td class="slam-moves">${moves || '—'}</td>` +
          `<td>${escapeHtml(fmtSlamSpan(s.spanMs))}</td>` +
          `</tr>`
        );
      })
      .join('');
  }

  function dayRecord(games) {
    let w = 0;
    let l = 0;
    let p = 0;
    let pending = 0;
    (games || []).forEach((g) => {
      const r = String(g.result || 'pending').toUpperCase();
      if (r === 'W') w++;
      else if (r === 'L') l++;
      else if (r === 'P') p++;
      else pending++;
    });
    const decided = w + l + p;
    const rate = decided ? ((w + p * 0.5) / decided) * 100 : null;
    return { w, l, p, pending, decided, rate };
  }

  function renderDay(payload) {
    const games = (payload && payload.games) || [];
    if (!games.length) {
      histBody.innerHTML =
        '<tr class="empty"><td colspan="11">No games in this archive.</td></tr>';
      renderSlams(payload);
      setStatus('warn', `Archive ${payload.date || ''}`, 'Empty day file');
      return;
    }

    const rec = dayRecord(games);
    const rateStr =
      rec.rate != null ? `${rec.rate.toFixed(1)}% Take units` : 'no finals yet';
    const nSlams = ((payload && payload.slams) || []).length;
    setStatus(
      'ok',
      `${games.length} games · Take ${rec.w}-${rec.l}-${rec.p}` +
        (rec.pending ? ` · ${rec.pending} pending` : '') +
        (nSlams ? ` · ${nSlams} slam${nSlams === 1 ? '' : 's'}` : ''),
      [
        payload.date,
        payload.exportedAt
          ? `exported ${new Date(payload.exportedAt).toLocaleString()}`
          : null,
        rateStr,
        (payload.sportsPresent || []).join('+') || null,
      ]
        .filter(Boolean)
        .join(' · ')
    );

    histBody.innerHTML = games
      .map((g, idx) => {
        const sport = g.sport || 'MLB';
        const sportCls =
          sport === 'NFL'
            ? 'sport-badge nfl'
            : sport === 'WNBA'
              ? 'sport-badge wnba'
              : 'sport-badge';
        const favRatio = favRatioOf(g);
        const pub = g.publicTeam || '—';
        const take = g.fadeTeam || '—';
        const moveLabel =
          g.pinnyTowardTeam ||
          (g.pinnyToward === 'unchanged' ? 'Flat' : g.pinnyToward || '—');
        let signalHtml = '<span class="signal-badge no">Watch</span>';
        if (g.notRespected || g.pinnyToward === 'fade') {
          signalHtml = '<span class="signal-badge yes">Not respected</span>';
        } else if (!g.pinnyMatched) {
          signalHtml = '<span class="signal-badge unknown">No Bet105</span>';
        }

        return (
          `<tr>` +
          `<td>${idx + 1}</td>` +
          `<td><span class="${sportCls}">${escapeHtml(sport)}</span></td>` +
          `<td class="matchup">${escapeHtml(g.awayAbbr || g.away)} @ ${escapeHtml(
            g.homeAbbr || g.home
          )}</td>` +
          `<td>${escapeHtml(pub)}${
            Number.isFinite(Number(g.popularNumber)) && Number(g.popularNumber) >= 1
              ? ` <span class="popular-num">(#${Number(g.popularNumber)})</span>`
              : ''
          }</td>` +
          `<td class="ratio-val">${fmtRatioBadge(favRatio, ratioBandClass(favRatio, g))}</td>` +
          `<td class="take-pick">${escapeHtml(take)}</td>` +
          `<td class="odds">${fmtOddsFlow(g)}</td>` +
          `<td>${escapeHtml(moveLabel)}</td>` +
          `<td>${signalHtml}</td>` +
          `<td class="score-cell">${escapeHtml(scoreCell(g))}</td>` +
          `<td title="${escapeHtml(g.resultNote || '')}">${resultBadge(g.result)}</td>` +
          `</tr>`
        );
      })
      .join('');

    renderSlams(payload);
  }

  const PUBLIC_HISTORY_BASE = 'https://jacobtulster.github.io/pinny-fade';
  const RAW_HISTORY_BASE =
    'https://raw.githubusercontent.com/jacobtulster/pinny-fade/main';

  function companionBundle() {
    return window.__PINNY_FADE_HISTORY__ || null;
  }

  function uniqDays(list) {
    const out = [];
    const seen = {};
    (list || []).forEach((d) => {
      if (!d || seen[d]) return;
      seen[d] = true;
      out.push(d);
    });
    return out;
  }

  async function fetchJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${url} → ${res.status}`);
    return res.json();
  }

  async function loadIndex() {
    const days = [];
    const bundle = companionBundle();
    if (bundle && Array.isArray(bundle.days)) {
      days.push.apply(days, bundle.days);
    }

    const urls = [
      'history/index.json',
      `${PUBLIC_HISTORY_BASE}/history/index.json`,
      `${RAW_HISTORY_BASE}/history/index.json`,
    ];
    for (let i = 0; i < urls.length; i++) {
      try {
        const data = await fetchJson(urls[i]);
        if (data && Array.isArray(data.days)) {
          days.push.apply(days, data.days.filter(Boolean));
        }
      } catch (_) {}
    }

    return uniqDays(days).sort(function (a, b) {
      return a < b ? 1 : a > b ? -1 : 0;
    });
  }

  async function loadDay(date) {
    const bundle = companionBundle();
    if (bundle && bundle.byDate && bundle.byDate[date]) {
      return bundle.byDate[date];
    }

    const urls = [
      `history/${date}.json`,
      `${PUBLIC_HISTORY_BASE}/history/${date}.json`,
      `${RAW_HISTORY_BASE}/history/${date}.json`,
    ];
    let lastErr = null;
    for (let i = 0; i < urls.length; i++) {
      try {
        return await fetchJson(urls[i]);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error(`Missing history/${date}.json`);
  }

  async function applyDays(days) {
    daySelect.innerHTML = '';
    if (!days.length) {
      daySelect.innerHTML = '<option value="">—</option>';
      setStatus(
        'warn',
        'No archive days yet',
        'Keep the live slate open with userscript v1.7.5+ · TM menu → Set GitHub token to publish'
      );
      histBody.innerHTML =
        '<tr class="empty"><td colspan="11">No archive days yet. Open the live dashboard with Tampermonkey — archives save locally even before GitHub is configured.</td></tr>';
      return;
    }

    days.forEach((d) => {
      const opt = document.createElement('option');
      opt.value = d;
      opt.textContent = d;
      daySelect.appendChild(opt);
    });

    const params = new URLSearchParams(location.search);
    const want = params.get('date');
    if (want && days.indexOf(want) >= 0) daySelect.value = want;
    else daySelect.value = days[0];

    await showSelected();
  }

  async function showSelected() {
    const date = daySelect.value;
    if (!date) return;
    try {
      const payload = await loadDay(date);
      renderDay(payload);
      const url = new URL(location.href);
      url.searchParams.set('date', date);
      history.replaceState(null, '', url.pathname + url.search);
    } catch (e) {
      histBody.innerHTML =
        '<tr class="empty"><td colspan="11">Failed to load this day.</td></tr>';
      setStatus('warn', 'Load failed', e && e.message);
    }
  }

  async function init() {
    daySelect.addEventListener('change', showSelected);

    window.addEventListener('pinny-fade-history', async function (e) {
      if (e && e.detail) window.__PINNY_FADE_HISTORY__ = e.detail;
      try {
        const days = await loadIndex();
        await applyDays(days);
      } catch (_) {}
    });
    document.addEventListener('pinny-fade-history', async function (e) {
      if (e && e.detail) window.__PINNY_FADE_HISTORY__ = e.detail;
      try {
        const days = await loadIndex();
        await applyDays(days);
      } catch (_) {}
    });

    window.addEventListener('pinny-fade-backup-status', function (e) {
      const d = (e && e.detail) || {};
      if (d.message) setStatus(d.ok ? 'ok' : 'warn', d.message, d.meta || '');
    });
    document.addEventListener('pinny-fade-backup-status', function (e) {
      const d = (e && e.detail) || {};
      if (d.message) setStatus(d.ok ? 'ok' : 'warn', d.message, d.meta || '');
    });

    let days = [];
    try {
      days = await loadIndex();
    } catch (e) {
      setStatus('warn', 'No archives yet', e && e.message);
      return;
    }
    await applyDays(days);

    // Companion may inject a moment later
    setTimeout(async function () {
      try {
        const again = await loadIndex();
        if (again.length && again.join('|') !== days.join('|')) {
          await applyDays(again);
        }
      } catch (_) {}
    }, 1500);
  }

  init();
})();
