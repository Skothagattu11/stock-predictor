// public/paper.js — Paper Trading panel: account, open positions, history, auto-mode.
(function () {
  function el(id) { return document.getElementById(id); }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  function money(x){ return '$' + Number(x).toFixed(2); }
  function signMoney(x){ return (x>=0?'+':'') + money(x); }

  function renderHistory(h) {
    var closed = (h && h.closed) || [];
    el('paperHistory').innerHTML = closed.length
      ? '<div class="pmuted">Closed trades</div>' + closed.map(function (p) {
          var pnl = (p.exit_price - p.entry) * p.shares;
          var cls = pnl >= 0 ? 'pp-up' : 'pp-down';
          return '<div class="pp-row"><span><b>' + esc(p.symbol) + '</b> ' + p.shares + ' sh ' +
            money(p.entry) + ' → ' + money(p.exit_price) + ' <span class="pmuted">(' + esc(p.exit_reason) + ')</span></span>' +
            '<span class="' + cls + '">' + signMoney(pnl) + '</span></div>';
        }).join('')
      : '<div class="pmuted">No closed trades yet.</div>';
  }

  function render(d) {
    var a = d.account, st = d.stats || {};
    el('paperAccount').innerHTML =
      'Equity <b>' + money(a.equity) + '</b> · Cash ' + money(a.cash) +
      ' · Realized <b class="' + (st.realized_pnl>=0?'pp-up':'pp-down') + '">' + signMoney(st.realized_pnl||0) + '</b>' +
      ' · Win rate <b>' + (st.win_rate!=null ? Math.round(st.win_rate*100)+'%' : '—') + '</b>' +
      ' (' + (st.wins||0) + 'W / ' + (st.losses||0) + 'L)';
    el('paperOpen').innerHTML = (d.open && d.open.length)
      ? '<div class="pmuted">Open positions</div>' + d.open.map(function(p){
          var cls = p.unrealized_pnl_abs>=0?'pp-up':'pp-down';
          return '<div class="pp-row"><span><b>'+esc(p.symbol)+'</b> '+p.shares+' sh @ '+money(p.entry)+
            ' → '+money(p.last_price)+'</span>'+
            '<span class="'+cls+'">'+signMoney(p.unrealized_pnl_abs)+'</span>'+
            '<button data-analyst="'+esc(p.symbol)+'">Analyst</button>'+
            '<button data-close="'+esc(p.id)+'">Close</button></div>';
        }).join('')
      : '<div class="pmuted">No open paper positions.</div>';
    Array.prototype.forEach.call(el('paperOpen').querySelectorAll('button[data-close]'), function(b){
      b.addEventListener('click', function(){
        fetch('/api/paper/close/'+encodeURIComponent(b.getAttribute('data-close')),{method:'POST'})
          .then(load); });
    });
    Array.prototype.forEach.call(el('paperOpen').querySelectorAll('button[data-analyst]'), function(b){
      b.addEventListener('click', function(){
        window.open('/analyst.html?ticker='+encodeURIComponent(b.getAttribute('data-analyst')),'_blank'); });
    });
  }

  function load() {
    fetch('/api/paper/portfolio').then(function(r){return r.json();}).then(render)
      .catch(function(){ el('paperAccount').textContent = 'Paper service unavailable.'; });
    fetch('/api/paper/history').then(function(r){return r.json();}).then(renderHistory)
      .catch(function(){});
  }

  function init() {
    if (!el('paperPanel')) return;
    fetch('/api/paper/settings').then(function(r){return r.json();}).then(function(s){
      el('paperAuto').checked = !!s.auto_enabled;
      el('paperBudget').value = s.budget; el('paperTarget').value = s.target; el('paperRisk').value = s.risk;
    }).catch(function(){});
    function saveSettings(){
      fetch('/api/paper/settings',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({auto_enabled:el('paperAuto').checked,budget:Number(el('paperBudget').value),
          target:Number(el('paperTarget').value),risk:el('paperRisk').value})});
    }
    ['paperAuto','paperBudget','paperTarget','paperRisk'].forEach(function(id){
      el(id).addEventListener('change', saveSettings); });
    el('paperReset').addEventListener('click', function(){
      if (confirm('Reset paper account to $10,000 and clear positions?'))
        fetch('/api/paper/reset',{method:'POST'}).then(load); });
    load();
    setInterval(function(){ if (!document.hidden) load(); }, 30000);
  }
  if (document.readyState !== 'loading') init(); else document.addEventListener('DOMContentLoaded', init);
  window.Paper = { reload: load };
})();
