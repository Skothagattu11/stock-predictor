// public/opportunities.js — Goal Planner: budget+target -> ranked, timed picks.
(function () {
  function el(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function pct(x) { return (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%'; }
  function money(x) { return '$' + Number(x).toFixed(2); }
  var HLABEL = { intraday: 'Today', swing: '~1 week', position: '~3 weeks' };

  function row(p) {
    var statusCls = p.entry_status === 'buy_now' ? 'gp-buy' : 'gp-wait';
    var statusTxt = p.entry_status === 'buy_now' ? '✅ buy now' : '⏳ wait for dip';
    return '<div class="gp-row" data-sym="' + esc(p.symbol) + '">' +
      '<div><span class="sym">' + esc(p.symbol) + '</span> ' + money(p.price) +
        ' <span class="gp-tag">PE ' + (p.pe != null ? p.pe.toFixed(1) : '—') + ' · ' + esc(p.pe_tag) + '</span>' +
        ' <span class="gp-tag">' + p.shares + ' sh · ' + money(p.invested) + '</span></div>' +
      '<div>Need <b class="gp-up">' + pct(p.required_move_pct) + '</b> → ' + money(p.target_dollars) +
        ' · <b>' + Math.round(p.probability * 100) + '%</b> · ' + esc(HLABEL[p.horizon] || p.horizon) + '</div>' +
      '<div>Entry ' + money(p.entry_low) + '–' + money(p.entry_high) +
        ' <span class="' + statusCls + '">' + statusTxt + '</span></div>' +
      '<div><span class="gp-up">+' + money(p.target_dollars) + '</span> / ' +
        '<span class="gp-down">−' + money(p.risk_dollars) + '</span> · R:R ' + p.reward_risk +
        ' · conv ' + Math.round(p.conviction * 100) + '%' +
        '  <button class="gp-paper" data-sym="' + esc(p.symbol) +
          '" data-budget="' + p.invested.toFixed(2) +
          '" data-target="' + (p.price * (1 + p.required_move_pct)).toFixed(4) +
          '" data-stop="' + (p.price * (1 - (p.risk_dollars / p.invested))).toFixed(4) +
          '">Paper Trade</button></div>' +
    '</div>';
  }

  function render(data) {
    var node = el('gpResults');
    if (!data.picks || !data.picks.length) {
      node.innerHTML = '<div class="pmuted">No picks clear your target right now (scanned ' +
        (data.scanned || 0) + '). Try a higher risk tier or a smaller target.</div>';
      return;
    }
    node.innerHTML = data.picks.map(row).join('');
    Array.prototype.forEach.call(node.querySelectorAll('.gp-row'), function (r) {
      r.addEventListener('click', function () {
        var sym = r.getAttribute('data-sym');
        if (window.selectSymbol) window.selectSymbol(sym);   // deep-dive: existing cards run all 4 LLMs
      });
    });
    Array.prototype.forEach.call(node.querySelectorAll('.gp-paper'), function (b) {
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        fetch('/api/paper/order', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ symbol: b.getAttribute('data-sym'),
            budget: Number(b.getAttribute('data-budget')),
            target: Number(b.getAttribute('data-target')),
            stop: Number(b.getAttribute('data-stop')) }) })
          .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
          .then(function (res) {
            b.textContent = res.ok ? '✓ Paper traded' : (res.j.detail || 'rejected');
            if (res.ok && window.Paper) window.Paper.reload();
          })
          .catch(function () { b.textContent = 'error'; });
      });
    });
    if (window.Alerts && window.Alerts.watchOpportunities) window.Alerts.watchOpportunities(data.picks);
  }

  function scan() {
    var b = el('gpBudget').value || 150, t = el('gpTarget').value || 12, r = el('gpRisk').value || 'balanced';
    el('gpResults').innerHTML = '<div class="pmuted">Scanning…</div>';
    fetch('/api/predict/opportunities?budget=' + encodeURIComponent(b) +
          '&target=' + encodeURIComponent(t) + '&risk=' + encodeURIComponent(r))
      .then(function (res) { if (!res.ok) throw new Error('scan failed (' + res.status + ')'); return res.json(); })
      .then(render)
      .catch(function (e) { el('gpResults').innerHTML = '<div class="pmuted">Could not scan (' + esc(e.message) + ').</div>'; });
  }

  function init() { var btn = el('gpScan'); if (btn) btn.addEventListener('click', scan); }
  if (document.readyState !== 'loading') init(); else document.addEventListener('DOMContentLoaded', init);
  window.GoalPlanner = { scan: scan };
})();
