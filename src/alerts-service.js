'use strict';

// Resend email client (https://resend.com). Injectable fetch for tests.
function createResend({ apiKey, from, fetchImpl } = {}) {
  const doFetch = fetchImpl || fetch;
  const fromAddr = from || 'alerts@resend.dev';
  async function send(to, subject, html) {
    if (!apiKey) throw new Error('RESEND_API_KEY not configured');
    const res = await doFetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ from: fromAddr, to: to, subject: subject, html: html }),
    });
    if (!res.ok) throw new Error('resend ' + res.status);
    return res.json();
  }
  return { send, enabled: Boolean(apiKey) };
}

// In-memory position-alert subscriptions (emails are NEVER persisted — memory only).
// A subscription lives until unsubscribed; the browser re-subscribes each session
// for symbols that still have a saved position ("active while the position is active").
function createAlertsService({ predictService, resend, now = Date.now }) {
  const subs = new Map();   // "email|SYMBOL" -> { email, symbol, cost_basis, shares, sent:Set }
  const key = (email, symbol) => String(email).toLowerCase() + '|' + String(symbol).toUpperCase();

  function subscribe(s) {
    if (!s || !s.email || !s.symbol) throw new Error('email and symbol are required');
    const k = key(s.email, s.symbol);
    const prev = subs.get(k);
    subs.set(k, {
      email: s.email, symbol: String(s.symbol).toUpperCase(),
      cost_basis: Number(s.cost_basis) || null, shares: Number(s.shares) || null,
      sent: prev ? prev.sent : new Set(),
    });
    return k;
  }
  function unsubscribe(email, symbol) { subs.delete(key(email, symbol)); }
  function list() { return Array.from(subs.values()).map((s) => ({ email: s.email, symbol: s.symbol })); }

  // Email only the critical position events: exit-plan target / stop hits.
  async function checkOne(sub) {
    if (sub.cost_basis == null) return;
    let pos;
    try {
      const params = { cost_basis: sub.cost_basis };
      if (sub.shares) params.shares = sub.shares;
      pos = await predictService.position(sub.symbol, params);
    } catch (e) { return; }
    if (!pos || !pos.exit_plan || typeof pos.unrealized_pnl_pct !== 'number') return;
    const price = sub.cost_basis * (1 + pos.unrealized_pnl_pct);
    const ep = pos.exit_plan;
    const events = [];
    (ep.targets || []).forEach((t) => {
      if (price >= t.price) {
        events.push({ id: 'tg|' + t.label + '|' + t.price,
          subj: `${sub.symbol} hit ${t.label} at $${t.price}`,
          body: `Price reached your ${t.label} (${money(t.price)}). Plan: scale out ${Math.round(t.sell_portion * 100)}%${t.shares ? ' (' + t.shares + ' sh)' : ''}.` });
      }
    });
    if (ep.stop && price <= ep.stop.price) {
      events.push({ id: 'st|' + ep.stop.price, subj: `${sub.symbol} hit your stop at $${ep.stop.price}`,
        body: `Price reached your protective stop (${money(ep.stop.price)}). Manage risk.` });
    }
    for (const ev of events) {
      if (sub.sent.has(ev.id)) continue;
      sub.sent.add(ev.id);
      try {
        await resend.send(sub.email, ev.subj,
          `<p>${ev.body}</p><p style="color:#888;font-size:12px">Automated alert from your dashboard · not investment advice.</p>`);
      } catch (e) { /* keep going */ }
    }
  }
  async function tick() { for (const s of subs.values()) await checkOne(s); }

  let timer = null;
  function start(intervalMs = 60 * 1000) {
    if (timer) return;
    timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
    if (timer.unref) timer.unref();
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  return { subscribe, unsubscribe, list, checkOne, tick, start, stop };
}

function money(x) { return '$' + Number(x).toFixed(2); }

module.exports = { createResend, createAlertsService };
