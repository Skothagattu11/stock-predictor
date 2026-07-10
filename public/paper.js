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

  function loadPending() {
    fetch('/api/tv/pending').then(function(r){return r.json();}).then(function(list){
      var panel = el('pinePending');
      var countEl = el('pinePendingCount');
      var listEl = el('pinePendingList');
      if (!panel || !listEl) return;
      if (!list || !list.length) { panel.style.display = 'none'; return; }
      panel.style.display = 'block';
      if (countEl) countEl.textContent = '(' + list.length + ')';
      listEl.innerHTML = list.map(function(sig){
        var age = Math.round((Date.now() - sig.ts) / 60000);
        var ageStr = age < 1 ? 'just now' : age + ' min ago';
        var priceStr = sig.price ? ' $' + Number(sig.price).toFixed(2) : '';
        return '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line)">' +
          '<span><b>' + esc(sig.symbol) + '</b> ' + esc(sig.action.toUpperCase()) + priceStr +
          ' <span class="pmuted">' + esc(sig.strategy) + ' · ' + ageStr + '</span></span>' +
          '<span style="display:flex;gap:6px">' +
          '<button data-approve="' + esc(sig.id) + '" style="background:var(--green);color:#000;border:0;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px;font-weight:700">Approve</button>' +
          '<button data-reject="' + esc(sig.id) + '" style="background:var(--red);color:#fff;border:0;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px">Reject</button>' +
          '</span></div>';
      }).join('');
      Array.prototype.forEach.call(listEl.querySelectorAll('button[data-approve]'), function(b){
        b.addEventListener('click', function(){
          fetch('/api/tv/pending/' + encodeURIComponent(b.getAttribute('data-approve')) + '/approve', { method: 'POST' })
            .then(function(){ loadPending(); load(); });
        });
      });
      Array.prototype.forEach.call(listEl.querySelectorAll('button[data-reject]'), function(b){
        b.addEventListener('click', function(){
          fetch('/api/tv/pending/' + encodeURIComponent(b.getAttribute('data-reject')) + '/reject', { method: 'POST' })
            .then(function(){ loadPending(); });
        });
      });
    }).catch(function(){});
  }

  function init() {
    if (!el('paperPanel')) return;

    // Load existing + pine settings
    fetch('/api/paper/settings').then(function(r){return r.json();}).then(function(s){
      el('paperAuto').checked = !!s.auto_enabled;
      el('paperBudget').value = s.budget;
      el('paperTarget').value = s.target;
      el('paperRisk').value = s.risk;
      var pine = s.pine || {};
      el('pineEnabled').checked = !!pine.enabled;
      var mode = pine.mode || 'auto';
      if (el('pineModeAuto')) el('pineModeAuto').checked = (mode === 'auto');
      if (el('pineModeApproval')) el('pineModeApproval').checked = (mode === 'approval');
      var dup = pine.onDuplicate || 'skip';
      if (el('pineDupSkip')) el('pineDupSkip').checked = (dup === 'skip');
      if (el('pineDupStack')) el('pineDupStack').checked = (dup === 'stack');
      if (el('pineDupScale')) el('pineDupScale').checked = (dup === 'scale');
      var exit = pine.onExit || 'closeAll';
      if (el('pineExitAll')) el('pineExitAll').checked = (exit === 'closeAll');
      if (el('pineExitLatest')) el('pineExitLatest').checked = (exit === 'closeLatest');
      if (el('pineExitIgnore')) el('pineExitIgnore').checked = (exit === 'ignore');
      if (el('pineBudget')) el('pineBudget').value = pine.tradeBudget || 200;
    }).catch(function(){});

    function saveSettings(){
      var modeEl = document.querySelector('input[name="pineMode"]:checked');
      var dupEl  = document.querySelector('input[name="pineDup"]:checked');
      var exitEl = document.querySelector('input[name="pineExit"]:checked');
      fetch('/api/paper/settings',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({
          auto_enabled: el('paperAuto').checked,
          budget: Number(el('paperBudget').value),
          target: Number(el('paperTarget').value),
          risk: el('paperRisk').value,
          pine: {
            enabled: el('pineEnabled').checked,
            mode: modeEl ? modeEl.value : 'auto',
            onDuplicate: dupEl ? dupEl.value : 'skip',
            onExit: exitEl ? exitEl.value : 'closeAll',
            tradeBudget: Number(el('pineBudget').value) || 200,
          }
        })
      });
    }

    ['paperAuto','paperBudget','paperTarget','paperRisk',
     'pineEnabled','pineBudget'].forEach(function(id){
      var e = el(id); if (e) e.addEventListener('change', saveSettings);
    });
    document.querySelectorAll('input[name="pineMode"],input[name="pineDup"],input[name="pineExit"]')
      .forEach(function(e){ e.addEventListener('change', saveSettings); });

    el('paperReset').addEventListener('click', function(){
      if (confirm('Reset paper account to $10,000 and clear positions?'))
        fetch('/api/paper/reset',{method:'POST'}).then(load);
    });

    load();
    loadPending();
    setInterval(function(){ if (!document.hidden) load(); }, 30000);
    setInterval(function(){ if (!document.hidden) loadPending(); }, 15000);
  }
  if (document.readyState !== 'loading') init(); else document.addEventListener('DOMContentLoaded', init);
  window.Paper = { reload: load };
})();
