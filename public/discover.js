/* Market discovery: Hot / Penny / Scope-to-shine. Clicking a row loads that ticker. */
(function () {
  'use strict';
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  function money(x){ return x==null?'—':'$'+Number(x).toFixed(2); }

  var LANES = [
    { key: 'hot', label: '🔥 Hot / trending' },
    { key: 'penny', label: '🪙 Penny movers' },
    { key: 'shine', label: '🌱 Scope to shine' },
  ];

  function row(it) {
    var chg = it.change_pct == null ? '' : '<span class="' + (it.change_pct >= 0 ? 'd-up' : 'd-dn') + '">' +
      (it.change_pct >= 0 ? '+' : '') + it.change_pct.toFixed(1) + '%</span>';
    return '<button class="dvrow" data-sym="' + esc(it.symbol) + '">' +
      '<span class="dv-sym">' + esc(it.symbol) + '</span>' +
      '<span class="dv-name">' + esc(it.name || '') + '</span>' +
      '<span class="dv-px">' + money(it.price) + ' ' + chg + '</span>' +
      '<span class="dv-why">' + esc(it.reason || '') + '</span></button>';
  }
  function render(node, data) {
    var lanes = LANES.map(function (l) {
      var items = (data[l.key] || []);
      var body = items.length ? items.map(row).join('') : '<div class="pmuted">Nothing notable right now.</div>';
      return '<div class="dvlane"><div class="dvlane-h">' + l.label + '</div>' + body + '</div>';
    }).join('');
    var t = data.as_of ? new Date(data.as_of) : null;
    var ts = (t && !isNaN(t)) ? t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
    node.innerHTML = '<div class="dvhead"><b>Discover</b><span class="pmuted">scanned ' + ts +
      ' · ' + esc((data.sources || []).join(', ') || 'no source') + '</span></div>' +
      '<div class="dvgrid">' + lanes + '</div>' +
      '<div class="pmuted" style="margin-top:8px">Descriptive screen, not advice. Penny names are high-risk.</div>';
  }
  function load() {
    var node = document.getElementById('discoverBody');
    if (!node) return;
    if (!node.innerHTML) node.innerHTML = '<div class="pmuted">Scanning the market…</div>';
    fetch('/api/predict/discover').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status); return r.json();
    }).then(function (d) { render(node, d); })
      .catch(function () { node.innerHTML = '<div class="pmuted">Discovery unavailable (screener key/rate-limit). Add FMP_API_KEY on the sidecar.</div>'; });
  }
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest && e.target.closest('.dvrow');
    if (b && b.getAttribute('data-sym') && window.selectSymbol) window.selectSymbol(b.getAttribute('data-sym'));
  });
  load();
  setInterval(function () { if (document.visibilityState !== 'hidden') load(); }, 5 * 60 * 1000);
  window.Discover = { load: load };
})();
