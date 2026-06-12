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
    var verb = L.direction === 'long' ? 'Buy near' : 'Short near';
    var movePct = (L.move_pct != null ? ' <small class="pmv">(' + pct(L.direction === 'long' ? L.move_pct : -L.move_pct) + ')</small>' : '');
    return '<div class="plevels">' +
      '<div class="plvl"><span>' + verb + '</span><b>' + money(L.entry) + '</b></div>' +
      '<div class="plvl"><span>Sell / target</span><b class="d-up">' + money(L.target) + movePct + '</b></div>' +
      '<div class="plvl"><span>Stop</span><b class="d-dn">' + money(L.stop) + '</b></div>' +
      '<div class="plvl"><span>Reward:Risk</span><b>' + L.risk_reward.toFixed(2) + '×</b></div>' +
      '</div>';
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
      '<div class="pcard-foot">' + aiBadge([]) + '</div>';
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

  // ---- orchestration -------------------------------------------------------
  async function load(symbol, ctx) {
    ctx = ctx || {};
    var cards = { intraday: el('predIntraday'), outlook: el('predOutlook'),
                  position: el('predPosition'), portfolio: el('predPortfolio') };
    if (!cards.intraday) return;   // section not present

    loadingCard(cards.intraday, 'Today'); loadingCard(cards.outlook, 'Weeks–Months');

    getJSON('/api/insight/intraday/' + encodeURIComponent(symbol))
      .then(function (d) { insightCard(cards.intraday, d, 'Today'); })
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
        .then(function (d) { positionCard(cards.position, d); })
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

  window.Predictions = { load: load };
})();
