/* Predictions section: multi-horizon, multi-model. Self-contained.
   Exposes window.Predictions.load(symbol, ctx) where ctx may include
   { position: {cost_basis, shares, portfolio_value}, holdings: [{symbol,value}] }. */
(function () {
  'use strict';

  function el(id) { return document.getElementById(id); }
  function h(html) { var d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function pct(x) { return (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%'; }
  function money(x) { return '$' + Number(x).toFixed(2); }

  async function getJSON(url) {
    var r = await fetch(url);
    if (!r.ok) { var e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
    return r.json();
  }

  // ---- honesty primitives (return HTML strings) ----------------------------
  var STANCE_META = {
    bullish: { label: 'BULLISH', icon: '▲', cls: 'st-bull' },
    bearish: { label: 'BEARISH', icon: '▼', cls: 'st-bear' },
    neutral: { label: 'NEUTRAL', icon: '▬', cls: 'st-neu' },
  };
  var ACTION_META = {
    HOLD: { icon: '▬', cls: 'st-neu' }, ADD: { icon: '▲', cls: 'st-bull' },
    TRIM: { icon: '▼', cls: 'st-warn' }, EXIT: { icon: '✖', cls: 'st-bear' },
  };
  function signalChip(label, icon, cls, lowConf) {
    return '<span class="pchip ' + cls + (lowConf ? ' pchip-dim' : '') + '">' +
      '<span class="pchip-ic">' + icon + '</span>' + esc(label) + '</span>';
  }
  function band(conf) { return conf >= 0.66 ? 'High' : conf >= 0.33 ? 'Moderate' : 'Low'; }
  function confidenceMeter(conf) {
    var b = band(conf);
    return '<span class="pconf pconf-' + b.toLowerCase() + '">' + b +
      ' · ' + Math.round(conf * 100) + '%</span>';
  }
  function freshnessTag(asOf) {
    var t = asOf ? new Date(asOf) : null;
    var label = t && !isNaN(t) ? t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
    return '<span class="pfresh">as of ' + esc(label) + '</span>';
  }
  function aiBadge(sources) {
    var n = (sources || []).length;
    return '<span class="pai" title="AI estimate — not investment advice">AI estimate · not advice' +
      (n ? ' · ' + n + ' src' : '') + '</span>';
  }
  function driverPills(drivers) {
    if (!drivers || !drivers.length) return '';
    return '<div class="pdrivers">' + drivers.slice(0, 4).map(function (d) {
      var a = d.direction === 'up' ? '▲' : d.direction === 'down' ? '▼' : '▬';
      return '<span class="pdriver ' + (d.direction === 'up' ? 'd-up' : d.direction === 'down' ? 'd-dn' : '') +
        '">' + esc(d.name) + ' ' + a + '</span>';
    }).join('') + '</div>';
  }
  function consensusRows(consensus) {
    if (!consensus || !consensus.votes) return '';
    var rows = consensus.votes.map(function (v) {
      var m = STANCE_META[v.stance] || STANCE_META.neutral;
      return '<div class="prow"><span class="prow-name">' + esc(v.name) + '</span>' +
        '<span class="prow-stance ' + m.cls + '">' + m.icon + ' ' + m.label + '</span>' +
        '<span class="prow-conf">' + Math.round((v.confidence || 0) * 100) + '%</span></div>';
    }).join('');
    var div = consensus.divergence
      ? '<span class="pdiverge">models split · low conviction</span>' : '';
    return '<div class="pconsensus"><div class="pconsensus-h">Predictors · ' +
      Math.round(consensus.agreement * 100) + '% agree ' + div + '</div>' + rows + '</div>';
  }

  // ---- card renderers ------------------------------------------------------
  function insightCard(node, data, horizon) {
    if (horizon === 'Today') lastTodayInsight = data;
    var c = data.consensus || { stance: 'neutral', agreement: 0, divergence: true, votes: [] };
    var m = STANCE_META[c.stance] || STANCE_META.neutral;
    var conf = c.agreement || 0;
    var html =
      '<div class="pcard-head"><span class="phbadge">' + esc(horizon) + '</span>' + freshnessTag(data.quant && data.quant.as_of) + '</div>' +
      '<div class="pcard-sig">' + signalChip(m.label, m.icon, m.cls, conf < 0.33) + confidenceMeter(conf) +
      convictionTag(data.quant) + '</div>' +
      driverPills(data.quant && data.quant.drivers) +
      (horizon.indexOf('Week') > -1 ? scenarioFan(data.quant) : '') +
      (horizon === 'Today' ? tradeLevels(data.quant) : '') +
      consensusRows(c) +
      '<div class="pcard-foot">' + aiBadge(collectSources(data.models)) + '</div>';
    node.innerHTML = html;
  }
  function convictionTag(quant) {
    if (!quant || typeof quant.conviction !== 'number') return '';
    return '<span class="pconv" title="How far the prediction is from a coin-flip">conviction ' +
      Math.round(quant.conviction * 100) + '%</span>';
  }
  function tradeLevels(quant) {
    var L = quant && quant.levels;
    if (!L) {
      return '<div class="pmuted plvl-wait">No directional edge right now (neutral) — wait for a clearer signal.</div>';
    }
    var isLong = L.direction === 'long';
    var verb = isLong ? 'Buy near' : 'Short near';
    var winPct = Math.abs(L.target - L.entry) / L.entry;
    var lossPct = Math.abs(L.entry - L.stop) / L.entry;
    var dirNote = isLong
      ? 'Model leans <b class="d-up">UP</b> — long setup (profit if it rises).'
      : 'Model leans <b class="d-dn">DOWN</b> — this is a <b>SHORT</b> (profit if it falls). If you only buy, treat it as <b>avoid / wait</b>.';
    return '<div class="plvl-hd">Day-trade plan · <b>today’s session</b> (intraday)</div>' +
      '<div class="plvl-dir">' + dirNote + '</div>' +
      '<div class="plevels">' +
      '<div class="plvl"><span>' + verb + '</span><b>' + money(L.entry) + '</b></div>' +
      '<div class="plvl"><span>Target (profit)</span><b class="d-up">' + money(L.target) + ' <small class="pmv">(+' + (winPct * 100).toFixed(1) + '%)</small></b></div>' +
      '<div class="plvl"><span>Stop (loss)</span><b class="d-dn">' + money(L.stop) + ' <small class="pmv">(−' + (lossPct * 100).toFixed(1) + '%)</small></b></div>' +
      '<div class="plvl"><span>Reward:Risk</span><b>' + L.risk_reward.toFixed(2) + '×</b></div>' +
      '</div>' +
      '<div class="plvl-out">If it works: <b class="d-up">+' + (winPct * 100).toFixed(1) + '%</b> to target · If it fails: <b class="d-dn">−' + (lossPct * 100).toFixed(1) + '%</b> to stop</div>' +
      rrFeasibility(L);
  }
  // Is the user's desired R:R achievable within today's realistic move?
  function rrFeasibility(L) {
    var want = getMinRR();
    var risk = Math.abs(L.entry - L.stop);
    if (!risk || !want) return '';
    if (want <= L.risk_reward) {
      var tgt = L.direction === 'long' ? L.entry + want * risk : L.entry - want * risk;
      var mp = (want * risk) / L.entry;
      return '<div class="prrfeas ok">✓ Your ' + want + '× is reachable — take profit at ' + money(tgt) +
        ' (' + pct(L.direction === 'long' ? mp : -mp) + '), within today’s expected move.</div>';
    }
    var needPct = (want * risk) / L.entry, havePct = L.move_pct || 0;
    return '<div class="prrfeas no">✗ Your ' + want + '× needs ' + pct(L.direction === 'long' ? needPct : -needPct) +
      ' — beyond today’s realistic ' + pct(L.direction === 'long' ? havePct : -havePct) +
      ' move (model max ≈ ' + L.risk_reward.toFixed(1) + '×).</div>';
  }
  function collectSources(models) {
    var s = []; (models || []).forEach(function (m) { (m.sources || []).forEach(function (x) { if (s.indexOf(x) < 0) s.push(x); }); });
    return s;
  }
  function scenarioFan(quant) {
    if (!quant || !quant.scenarios) return '';
    var byCase = {}; quant.scenarios.forEach(function (s) { byCase[s.case] = s; });
    function row(label, s, cls) {
      if (!s) return '';
      return '<div class="pscn ' + cls + '"><span>' + label + '</span>' +
        '<span>' + money(s.target_price) + '</span><span>' + pct(s.target_return_pct) +
        '</span><span>' + Math.round(s.probability * 100) + '%</span></div>';
    }
    return '<div class="pfan">' + row('Bull', byCase.bull, 'pscn-bull') +
      row('Base', byCase.base, 'pscn-base') + row('Bear', byCase.bear, 'pscn-bear') + '</div>';
  }
  function positionCard(node, data) {
    var m = ACTION_META[data.action] || ACTION_META.HOLD;
    node.innerHTML =
      '<div class="pcard-head"><span class="phbadge">Your position</span>' + freshnessTag(data.as_of) + '</div>' +
      '<div class="pcard-sig">' + signalChip(data.action, m.icon, m.cls, false) +
      '<span class="ppnl ' + (data.unrealized_pnl_pct >= 0 ? 'd-up' : 'd-dn') + '">' + pct(data.unrealized_pnl_pct) +
      ' (' + money(data.unrealized_pnl_abs) + ')</span></div>' +
      driverPills(data.drivers) +
      exitPlanView(data.exit_plan) +
      '<div class="pcard-foot">' + aiBadge([]) + '</div>';
  }
  function exitPlanView(ep) {
    if (!ep) return '';
    var rows = ep.targets.map(function (x) {
      return '<div class="plvl"><span>' + esc(x.label) + ' · sell ' + Math.round(x.sell_portion * 100) + '%' +
        (x.shares ? ' (' + x.shares + ' sh)' : '') + (x.basis === 'resistance' ? ' @ resistance' : '') + '</span>' +
        '<b class="d-up">' + money(x.price) + ' <small class="pmv">(+' + (x.pct_move * 100).toFixed(1) + '%)</small></b></div>';
    }).join('');
    return '<div class="plvl-hd">Exit plan · scale out + trail</div>' +
      '<div class="plevels">' +
      '<div class="plvl"><span>Protect / stop · ' + esc(ep.stop.basis) + '</span>' +
      '<b class="d-dn">' + money(ep.stop.price) + ' <small class="pmv">(' + (ep.stop.pct * 100).toFixed(1) + '%)</small></b></div>' +
      rows +
      '<div class="plvl"><span>Trail remainder</span><b>' + Math.round(ep.trail_remainder * 100) + '%</b></div>' +
      '</div>' +
      '<div class="plvl-out">' + esc(ep.rationale) + '</div>';
  }
  function portfolioCard(node, data) {
    var flags = (data.flags || []).map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('');
    node.innerHTML =
      '<div class="pcard-head"><span class="phbadge">Across holdings</span>' + freshnessTag(data.as_of) + '</div>' +
      '<div class="pcard-sig"><span class="pchip ' + ((data.flags || []).length ? 'st-warn' : 'st-neu') + '">' +
      ((data.flags || []).length ? '⚠ REVIEW' : '✓ BALANCED') + '</span>' +
      '<span class="pconf">HHI ' + (data.concentration_hhi != null ? data.concentration_hhi.toFixed(2) : '—') + '</span></div>' +
      (flags ? '<ul class="pflags">' + flags + '</ul>' : '<div class="pmuted">No concentration/correlation issues.</div>') +
      '<div class="pcard-foot">' + aiBadge([]) + '</div>';
  }
  function errorCard(node, horizon, e) {
    var msg;
    if (e && e.status === 422) msg = 'Forming — not enough session data yet. Updates automatically as the session builds.';
    else if (e && e.status === 503) msg = 'Live model unavailable (sidecar/keys not reachable).';
    else msg = 'Could not load (' + (e && e.message || 'error') + ').';
    node.innerHTML = '<div class="pcard-head"><span class="phbadge">' + esc(horizon) + '</span></div>' +
      '<div class="pmuted">' + esc(msg) + '</div>';
  }
  function loadingCard(node, horizon) {
    node.innerHTML = '<div class="pcard-head"><span class="phbadge">' + esc(horizon) + '</span></div>' +
      '<div class="pmuted">Analyzing…</div>';
  }

  // ---- R:R setting + setup track-record (localStorage) ---------------------
  var LS_MINRR = 'csd_min_rr_v1';
  var LS_JOURNAL = 'csd_setup_journal_v1';
  var lastTimeline = null;
  var lastTodayInsight = null;
  var lastSymbol = null;
  var selectedPhase = null;
  var LS_WIN_TF = 'csd_win_tf_v1';
  function getWinTF() { return localStorage.getItem(LS_WIN_TF) === '5m' ? '5m' : '1m'; }
  function setWinTF(v) { try { localStorage.setItem(LS_WIN_TF, v); } catch (e) {} }
  function nowMs() { return new Date().getTime(); }
  function getMinRR() { var v = parseFloat(localStorage.getItem(LS_MINRR)); return (isFinite(v) && v > 0) ? v : 1.5; }
  function setMinRR(v) { try { localStorage.setItem(LS_MINRR, String(v)); } catch (e) {} }
  function loadJournal() { try { return JSON.parse(localStorage.getItem(LS_JOURNAL)) || []; } catch (e) { return []; } }
  function saveJournal(j) { try { localStorage.setItem(LS_JOURNAL, JSON.stringify(j.slice(-500))); } catch (e) {} }

  // Record each setup the dashboard surfaces; update its outcome on later refreshes.
  function logSetups(symbol, setups) {
    if (!setups || !setups.length) return;
    var j = loadJournal(), byId = {};
    j.forEach(function (e) { byId[e.id] = e; });
    setups.forEach(function (s) {
      var id = symbol + '|' + s.time + '|' + s.type + '|' + s.direction;
      if (byId[id]) { byId[id].status = s.status; byId[id].lastSeen = nowMs(); }
      else {
        var e = { id: id, symbol: symbol, time: s.time, type: s.type, direction: s.direction,
          entry: s.entry, target: s.target, stop: s.stop, rr: s.risk_reward, status: s.status,
          firstSeen: nowMs(), lastSeen: nowMs() };
        j.push(e); byId[id] = e;
      }
    });
    saveJournal(j);
  }

  function trackStats() {
    var j = loadJournal(), DAY = 16 * 3600 * 1000, groups = {};
    var overall = { type: 'All', n: 0, win: 0, loss: 0, pending: 0, rrSum: 0 };
    j.forEach(function (e) {
      var st = e.status;
      if (st === 'active' && nowMs() - e.firstSeen > DAY) st = 'expired';   // unresolved by EOD
      var g = groups[e.type] || (groups[e.type] = { type: e.type, n: 0, win: 0, loss: 0, pending: 0, rrSum: 0 });
      g.n++; overall.n++; g.rrSum += e.rr || 0; overall.rrSum += e.rr || 0;
      if (st === 'triggered_win') { g.win++; overall.win++; }
      else if (st === 'triggered_loss') { g.loss++; overall.loss++; }
      else { g.pending++; overall.pending++; }
    });
    return { groups: Object.keys(groups).map(function (k) { return groups[k]; }), overall: overall };
  }

  function _localStats() {
    var raw = trackStats();
    function norm(g) {
      var res = g.win + g.loss;
      return { type: g.type, n: g.n, win: g.win, loss: g.loss, pending: g.pending,
               hit_rate: res ? Math.round(g.win / res * 100) / 100 : null,
               avg_rr: g.n ? Math.round((g.rrSum / g.n) * 10) / 10 : null };
    }
    return { groups: raw.groups.map(norm), overall: norm(raw.overall) };
  }

  function renderTrackFrom(node, st, durable) {
    var o = st.overall;
    var src = durable ? '· durable' : '· this browser';
    var head = '<div class="pcard-head"><span class="phbadge">Setup track record <span class="pmuted" style="font-weight:normal;font-size:0.82em">' + src + '</span></span>' +
      (o.n ? '<button class="pt-clear" id="ptClear">Clear</button>' : '') + '</div>';
    if (!o.n) {
      node.innerHTML = head + '<div class="pmuted">No setups logged yet. As windows appear they\'re recorded here and marked hit / stopped, so you can see whether the predicted R:R is actually met.</div>';
      return;
    }
    function rate(hr) { return hr != null ? Math.round(hr * 100) + '%' : '—'; }
    function rowH(g, cls) {
      return '<div class="ptrow ' + (cls || '') + '"><span>' + esc(g.type) + '</span><span>' + g.n +
        '</span><span class="d-up">' + g.win + '</span><span class="d-dn">' + g.loss + '</span><span>' + g.pending +
        '</span><span><b>' + rate(g.hit_rate) + '</b></span><span>' + (g.avg_rr != null ? g.avg_rr.toFixed(1) : '—') + '×</span></div>';
    }
    var rows = st.groups.slice().sort(function (a, b) { return b.n - a.n; }).map(function (g) { return rowH(g); }).join('');
    node.innerHTML = head +
      '<div class="pmuted" style="margin-bottom:8px">Was the predicted reward:risk met? (target hit ✓ vs stopped ✗)</div>' +
      '<div class="ptrow ptrow-h"><span>Setup</span><span>#</span><span>✓</span><span>✗</span><span>pend</span><span>R:R met</span><span>avg R:R</span></div>' +
      rows + rowH(o, 'ptotal');
  }

  function renderTrack() {
    var node = el('predTrack'); if (!node) return;
    fetch('/api/predict/calibration/stats').then(function (r) {
      if (!r.ok) throw new Error('no'); return r.json();
    }).then(function (st) {
      if (st && st.overall && st.overall.n > 0) renderTrackFrom(node, st, true);
      else renderTrackFrom(node, _localStats(), false);
    }).catch(function () { renderTrackFrom(node, _localStats(), false); });
  }

  // ---- Intraday Windows panel ----------------------------------------------
  var PHASE_LABEL = { pre: 'Pre-market', open_drive: 'Open drive', morning: 'Morning trend',
    midday: 'Midday (avoid)', afternoon: 'Afternoon', power_hour: 'Power hour', closed: 'Closed' };
  var PHASES = ['open_drive', 'morning', 'midday', 'afternoon', 'power_hour'];

  function phaseStrip(current, selected) {
    var btns = PHASES.map(function (p) {
      var cls = p === current ? ' pwp-now' : ''; cls += (p === 'midday' ? ' pwp-bad' : '');
      cls += (p === selected ? ' pwp-sel' : '');
      return '<button class="pwp' + cls + '" data-phase="' + p + '">' + PHASE_LABEL[p] + '</button>';
    }).join('<span class="pwp-sep">›</span>');
    var all = '<button class="pwp pwp-all' + (selected ? '' : ' pwp-sel') + '" data-phase="all">All</button>';
    return '<div class="pwphase">' + all + '<span class="pwp-sep">›</span>' + btns + '</div>';
  }
  function setupRow(s, minRR) {
    var dirCls = s.direction === 'long' ? 'd-up' : 'd-dn';
    var statusMap = { triggered_win: '✓ hit target', triggered_loss: '✗ stopped', active: '● live' };
    var t = new Date(s.time);
    var hhmm = isNaN(t) ? '' : t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    var qcls = s.quality === 'high' ? 'pq-high' : s.quality === 'low' ? 'pq-low' : 'pq-med';
    var meets = s.risk_reward >= minRR;       // does it clear YOUR min R:R?
    return '<div class="pwrow ' + (s.status === 'active' ? 'pwrow-active ' : '') + (meets ? '' : 'pwrow-dim') +
      '" title="' + (meets ? 'meets your ' + minRR + '× min' : 'below your ' + minRR + '× min') + '">' +
      '<span class="pw-t">' + hhmm + '</span>' +
      '<span class="pw-type">' + esc(s.type) + ' <i class="' + dirCls + '">' + (s.direction === 'long' ? 'LONG' : 'SHORT') + '</i></span>' +
      '<span class="pw-lv">' + money(s.entry) + ' → <b class="d-up">' + money(s.target) + '</b> / <b class="d-dn">' + money(s.stop) + '</b></span>' +
      '<span class="pw-rr ' + (meets ? 'd-up' : 'd-dn') + '">' + s.risk_reward.toFixed(1) + '×</span>' +
      '<span class="pw-st ' + qcls + '">' + (statusMap[s.status] || s.status) + '</span></div>';
  }
  function keyLevels(levels) {
    if (!levels || !levels.length) return '';
    var res = levels.filter(function (l) { return l.kind === 'resistance'; });
    var sup = levels.filter(function (l) { return l.kind === 'support'; });
    function chips(arr, cls) {
      return arr.map(function (l) {
        return '<span class="pkl ' + cls + '" title="' + esc(l.label) + '">' + money(l.price) + '</span>';
      }).join('');
    }
    return '<div class="pkeylv">' +
      '<div class="pkl-row"><span>Sell / resistance</span>' + chips(res, 'pkl-res') + '</div>' +
      '<div class="pkl-row"><span>Buy / support</span>' + chips(sup, 'pkl-sup') + '</div></div>';
  }
  function windowsCard(node, data) {
    lastTimeline = data;
    var minRR = getMinRR();
    var all = data.setups || [];
    var setups = selectedPhase ? all.filter(function (s) { return s.phase === selectedPhase; }) : all;
    var meet = setups.filter(function (s) { return s.risk_reward >= minRR; }).length;
    var head = '<div class="pcard-head"><span class="phbadge">Intraday windows</span>' + freshnessTag(data.as_of) + '</div>';
    var strip = phaseStrip(data.phase, selectedPhase);
    var watch = data.watch ? '<div class="pwwatch">' + esc(data.watch) + '</div>' : '';
    var tf = getWinTF();
    var tfToggle = '<span class="pwtf">' + ['1m', '5m'].map(function (x) {
      return '<button class="pwtf-b' + (x === tf ? ' on' : '') + '" data-tf="' + x + '">' + x + '</button>';
    }).join('') + '</span>';
    var settings = '<div class="pwset">' + tfToggle + '<span>Min reward:risk</span>' +
      '<input type="number" id="pwMinRR" min="0.5" step="0.1" value="' + minRR + '" />' +
      '<span class="pmuted">' + meet + ' of ' + setups.length + ' meet it' +
      (selectedPhase ? ' · ' + PHASE_LABEL[selectedPhase] : '') + '</span></div>';
    var levels = keyLevels(data.levels);
    var rows = setups.length
      ? '<div class="pwrows">' + setups.slice().reverse().map(function (s) { return setupRow(s, minRR); }).join('') + '</div>'
      : '<div class="pmuted">' + (selectedPhase ? 'No setups fired during ' + PHASE_LABEL[selectedPhase] + '.' : 'No setups triggered yet this session.') + '</div>';
    node.innerHTML = head + strip + watch + settings + levels + rows + '<div class="pcard-foot">' + aiBadge([]) + '</div>';
  }
  function loadWindows(symbol, interval) {
    var node = el('predWindows');
    if (!node) { renderTrack(); return; }
    loadingCard(node, 'Intraday windows');
    getJSON('/api/predict/setups/' + encodeURIComponent(symbol) + '?interval=' + encodeURIComponent(interval || getWinTF()))
      .then(function (d) { windowsCard(node, d); logSetups(symbol, d.setups); renderTrack();
        if (window.Alerts) window.Alerts.check(symbol, { setups: d.setups }); })
      .catch(function (e) { errorCard(node, 'Intraday windows', e); renderTrack(); });
  }

  // ---- orchestration -------------------------------------------------------
  async function load(symbol, ctx) {
    ctx = ctx || {};
    var cards = { intraday: el('predIntraday'), outlook: el('predOutlook'),
                  position: el('predPosition'), portfolio: el('predPortfolio') };
    if (!cards.intraday) return;   // section not present

    loadingCard(cards.intraday, 'Today'); loadingCard(cards.outlook, 'Weeks–Months');
    lastSymbol = symbol;
    if (window.Alerts) { window.Alerts.noteCtx(symbol, ctx.position || null); window.Alerts.syncEmail(symbol, ctx.position || null); }
    loadWindows(symbol, getWinTF());

    getJSON('/api/insight/intraday/' + encodeURIComponent(symbol))
      .then(function (d) {
        insightCard(cards.intraday, d, 'Today');
        if (window.Alerts) window.Alerts.check(symbol, { bias: d.consensus && d.consensus.stance, price: d.quant && d.quant.levels && d.quant.levels.entry });
      })
      .catch(function (e) { errorCard(cards.intraday, 'Today', e); });

    getJSON('/api/insight/outlook/' + encodeURIComponent(symbol))
      .then(function (d) { insightCard(cards.outlook, d, 'Weeks–Months'); })
      .catch(function (e) { errorCard(cards.outlook, 'Weeks–Months', e); });

    var pos = ctx.position;
    if (pos && pos.cost_basis && cards.position) {
      // Do NOT send current_price — the sidecar fetches the real live price so P/L
      // doesn't depend on the chart feed (which may be simulated/missing).
      var q = new URLSearchParams({ cost_basis: pos.cost_basis });
      if (pos.shares) q.set('shares', pos.shares);
      if (pos.portfolio_value) q.set('portfolio_value', pos.portfolio_value);
      getJSON('/api/predict/position/' + encodeURIComponent(symbol) + '?' + q.toString())
        .then(function (d) {
          positionCard(cards.position, d);
          if (window.Alerts) window.Alerts.check(symbol, { exitPlan: d.exit_plan,
            price: pos.cost_basis * (1 + (d.unrealized_pnl_pct || 0)) });
        })
        .catch(function (e) { errorCard(cards.position, 'Your position', e); });
    } else if (cards.position) {
      cards.position.innerHTML = '<div class="pcard-head"><span class="phbadge">Your position</span></div>' +
        '<div class="pmuted">Save a position to get a personalized call.</div>';
    }

    var holdings = ctx.holdings || [];
    if (holdings.length && cards.portfolio) {
      fetch('/api/predict/portfolio', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ holdings: holdings }) })
        .then(function (r) { if (!r.ok) { var e = new Error('HTTP ' + r.status); e.status = r.status; throw e; } return r.json(); })
        .then(function (d) { portfolioCard(cards.portfolio, d); })
        .catch(function (e) { errorCard(cards.portfolio, 'Across holdings', e); });
    } else if (cards.portfolio) {
      cards.portfolio.innerHTML = '<div class="pcard-head"><span class="phbadge">Across holdings</span></div>' +
        '<div class="pmuted">Add holdings to see portfolio fit.</div>';
    }
  }

  // Live edits: change min R:R re-renders the windows from the cached timeline; Clear wipes the journal.
  document.addEventListener('change', function (e) {
    if (e.target && e.target.id === 'pwMinRR') {
      setMinRR(e.target.value);
      if (lastTimeline) windowsCard(el('predWindows'), lastTimeline);
      if (lastTodayInsight && el('predIntraday')) insightCard(el('predIntraday'), lastTodayInsight, 'Today');
    }
  });
  document.addEventListener('click', function (e) {
    if (!e.target) return;
    if (e.target.id === 'ptClear') {
      try { localStorage.removeItem(LS_JOURNAL); } catch (err) {}
      renderTrack();
    } else if (e.target.getAttribute && e.target.getAttribute('data-tf')) {
      setWinTF(e.target.getAttribute('data-tf'));
      if (lastSymbol) loadWindows(lastSymbol, getWinTF());
    } else if (e.target.getAttribute && e.target.getAttribute('data-phase')) {
      var p = e.target.getAttribute('data-phase');
      selectedPhase = (p === 'all' || p === selectedPhase) ? null : p;
      if (lastTimeline) windowsCard(el('predWindows'), lastTimeline);
    }
  });

  window.Predictions = { load: load };
})();
