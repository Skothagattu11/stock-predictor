'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createResend, createAlertsService } = require('../src/alerts-service');

function fakeResend() {
  const sent = [];
  return { send: async (to, subj, html) => { sent.push({ to, subj, html }); }, sent, enabled: true };
}

test('resend posts with auth and throws on non-ok', async () => {
  const rec = {};
  const r = createResend({ apiKey: 'k', fetchImpl: async (u, o) => { rec.u = u; rec.o = o; return { ok: true, status: 200, json: async () => ({ id: '1' }) }; } });
  await r.send('a@b.com', 'hi', '<p>x</p>');
  assert.equal(rec.u, 'https://api.resend.com/emails');
  assert.match(rec.o.headers.Authorization, /Bearer k/);
  const bad = createResend({ apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 403 }) });
  await assert.rejects(() => bad.send('a', 'b', 'c'), /403/);
});

test('emails a target hit once (dedup)', async () => {
  const resend = fakeResend();
  const predictService = { position: async (sym) => ({ symbol: sym, unrealized_pnl_pct: 0.10,
    exit_plan: { targets: [{ label: 'T1', price: 110, sell_portion: 0.34, shares: 10 }], stop: { price: 95 } } }) };
  const svc = createAlertsService({ predictService, resend });
  svc.subscribe({ email: 'me@x.com', symbol: 'AAPL', cost_basis: 100, shares: 30 });  // price=110 >= T1
  await svc.tick();
  assert.equal(resend.sent.length, 1);
  assert.match(resend.sent[0].subj, /T1/);
  await svc.tick();
  assert.equal(resend.sent.length, 1);   // not re-sent
});

test('emails a stop hit', async () => {
  const resend = fakeResend();
  const predictService = { position: async () => ({ unrealized_pnl_pct: -0.06, exit_plan: { targets: [], stop: { price: 95 } } }) };
  const svc = createAlertsService({ predictService, resend });
  svc.subscribe({ email: 'me@x.com', symbol: 'AAPL', cost_basis: 100 });   // price=94 <= 95
  await svc.tick();
  assert.equal(resend.sent.length, 1);
  assert.match(resend.sent[0].subj, /stop/);
});

test('no email without exit_plan; unsubscribe removes', async () => {
  const resend = fakeResend();
  const predictService = { position: async () => ({ unrealized_pnl_pct: 0.2, exit_plan: null }) };
  const svc = createAlertsService({ predictService, resend });
  svc.subscribe({ email: 'me@x.com', symbol: 'AAPL', cost_basis: 100 });
  await svc.tick();
  assert.equal(resend.sent.length, 0);
  svc.unsubscribe('me@x.com', 'AAPL');
  assert.equal(svc.list().length, 0);
});

test('subscribe requires email and symbol', () => {
  const svc = createAlertsService({ predictService: {}, resend: fakeResend() });
  assert.throws(() => svc.subscribe({ symbol: 'AAPL' }));
});
