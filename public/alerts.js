/* Browser alerts: setups firing, Today-bias flips, and exit-plan target/stop hits.
   Client-side (Web Notifications) — works while a browser tab is open (incl. backgrounded). */
(function () {
  'use strict';
  var LS_ON = 'csd_alerts_on';
  var sent = {};          // dedup keys this session
  var last = {};          // per-symbol last state (bias) for flip detection

  function isOn() { return localStorage.getItem(LS_ON) === '1'; }
  function supported() { return 'Notification' in window; }
  function granted() { return supported() && Notification.permission === 'granted'; }
  function money(x) { return '$' + Number(x).toFixed(2); }
  function setOn(v) { try { localStorage.setItem(LS_ON, v ? '1' : '0'); } catch (e) {} refreshBtn(); }

  function enable() {
    if (!supported()) { alert('This browser does not support notifications.'); return; }
    Notification.requestPermission().then(function (p) { setOn(p === 'granted'); });
  }
  function notify(key, title, body) {
    if (!isOn() || !granted() || sent[key]) return;
    sent[key] = 1;
    try { new Notification(title, { body: body, tag: key }); } catch (e) { /* ignore */ }
  }

  // info: { bias, setups:[], exitPlan:{targets,stop}, price }
  function check(symbol, info) {
    if (!isOn() || !granted() || !symbol || !info) return;
    var prev = last[symbol] || {};
    if (info.bias && prev.bias && info.bias !== prev.bias) {
      notify(symbol + '|flip|' + info.bias, symbol + ' flipped to ' + info.bias.toUpperCase(),
        'Today read changed ' + prev.bias + ' → ' + info.bias + '.');
    }
    (info.setups || []).forEach(function (s) {
      if (s.status !== 'active') return;
      notify(symbol + '|su|' + s.time + '|' + s.type + '|' + s.direction,
        symbol + ' setup: ' + s.type + ' ' + (s.direction === 'long' ? 'LONG' : 'SHORT'),
        'Entry ' + money(s.entry) + ' → tgt ' + money(s.target) + ' / stop ' + money(s.stop) +
        ' (' + Number(s.risk_reward).toFixed(1) + '×)');
    });
    if (info.exitPlan && info.price) {
      var ep = info.exitPlan, px = info.price;
      (ep.targets || []).forEach(function (t) {
        if (px >= t.price) {
          notify(symbol + '|tg|' + t.label + '|' + t.price, symbol + ' hit ' + t.label + ' ' + money(t.price),
            'Scale out ' + Math.round(t.sell_portion * 100) + '%' + (t.shares ? ' (' + t.shares + ' sh)' : '') + '.');
        }
      });
      if (ep.stop && px <= ep.stop.price) {
        notify(symbol + '|st|' + ep.stop.price, symbol + ' hit stop ' + money(ep.stop.price),
          'Protective stop reached — manage risk.');
      }
    }
    if (info.bias) last[symbol] = { bias: info.bias };
  }

  // ---- email alerts (server-side via Resend; email kept in your browser only) ----
  var LS_EMAIL = 'csd_alert_email', LS_EMAILON = 'csd_email_alerts_on';
  var curSub = null, lastCtx = null;
  function getEmail() { return localStorage.getItem(LS_EMAIL) || ''; }
  function setEmail(v) { try { localStorage.setItem(LS_EMAIL, v || ''); } catch (e) {} }
  function emailOn() { return localStorage.getItem(LS_EMAILON) === '1'; }
  function setEmailOn(v) { try { localStorage.setItem(LS_EMAILON, v ? '1' : '0'); } catch (e) {} }
  function post(path, body) {
    return fetch('/api/alerts/' + path, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body) }).catch(function () {});
  }
  // Subscribe while the position is active; unsubscribe on disable / symbol change / no position.
  function syncEmail(symbol, pos) {
    lastCtx = { symbol: symbol, pos: pos };
    var email = getEmail(), sym = String(symbol || '').toUpperCase();
    if (curSub && (!emailOn() || !email || curSub.symbol !== sym || !pos || !pos.cost_basis)) {
      post('unsubscribe', { email: curSub.email, symbol: curSub.symbol });
      curSub = null;
    }
    if (emailOn() && email && pos && pos.cost_basis) {
      post('subscribe', { email: email, symbol: sym, cost_basis: pos.cost_basis, shares: pos.shares });
      curSub = { email: email, symbol: sym };
    }
  }
  function noteCtx(symbol, pos) { lastCtx = { symbol: symbol, pos: pos }; }

  function refreshBtn() {
    var b = document.getElementById('alertsToggle');
    if (b) {
      var on = isOn() && granted();
      b.textContent = on ? '🔔 Alerts on' : '🔕 Enable alerts';
      b.className = 'alerts-btn' + (on ? ' on' : '');
    }
    var em = document.getElementById('alertEmail');
    if (em && em.value !== getEmail()) em.value = getEmail();
    var et = document.getElementById('emailAlertToggle');
    if (et) et.checked = emailOn();
  }

  document.addEventListener('click', function (e) {
    if (e.target && e.target.id === 'alertsToggle') {
      if (isOn() && granted()) setOn(false); else enable();
    }
  });
  document.addEventListener('change', function (e) {
    if (!e.target) return;
    if (e.target.id === 'alertEmail') {
      setEmail(e.target.value.trim());
      if (lastCtx) syncEmail(lastCtx.symbol, lastCtx.pos);
    } else if (e.target.id === 'emailAlertToggle') {
      setEmailOn(e.target.checked);
      if (lastCtx) syncEmail(lastCtx.symbol, lastCtx.pos);
    }
  });
  refreshBtn();
  window.Alerts = { enable: enable, check: check, isOn: isOn, syncEmail: syncEmail, noteCtx: noteCtx };
})();
