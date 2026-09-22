'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fakeSupabase } = require('./helpers/fake-supabase');
const { createManagerActions } = require('../src/manager-actions');

const MANAGER = 'mgr-1';
const OTHER = 'mgr-2';

function seed() {
  return fakeSupabase({
    manager_clients: [{ id: 'c1', manager_id: MANAGER, full_name: 'Jane Smith' }],
    client_portfolios: [{ id: 'p1', client_id: 'c1', name: 'Growth', 'manager_clients.manager_id': MANAGER }],
    portfolio_positions: [{
      id: 'pos1', portfolio_id: 'p1', symbol: 'NVDA', entry_price: 100, shares: 10,
      'client_portfolios.manager_clients.manager_id': MANAGER,
    }],
  });
}

// Same shape as seed(), plus a second client/portfolio/position owned by a
// different manager — for proving ownership checks actually reject someone
// else's records (not just nonexistent ones).
function seedWithOtherManager() {
  return fakeSupabase({
    manager_clients: [
      { id: 'c1', manager_id: MANAGER, full_name: 'Jane Smith' },
      { id: 'c2', manager_id: OTHER, full_name: 'Other Manager Client' },
    ],
    client_portfolios: [
      { id: 'p1', client_id: 'c1', name: 'Growth', 'manager_clients.manager_id': MANAGER },
      { id: 'p2', client_id: 'c2', name: 'Other Growth', 'manager_clients.manager_id': OTHER },
    ],
    portfolio_positions: [
      {
        id: 'pos1', portfolio_id: 'p1', symbol: 'NVDA', entry_price: 100, shares: 10,
        'client_portfolios.manager_clients.manager_id': MANAGER,
      },
      {
        id: 'pos2', portfolio_id: 'p2', symbol: 'TSLA', entry_price: 200, shares: 5,
        'client_portfolios.manager_clients.manager_id': OTHER,
      },
    ],
  });
}

test('createClient requires full_name', async () => {
  const actions = createManagerActions({ sb: seed() });
  const r = await actions.createClient(MANAGER, {});
  assert.equal(r.ok, false);
  assert.equal(r.code, 400);
});

test('createClient stamps manager_id from the caller, never the input', async () => {
  const sb = seed();
  const actions = createManagerActions({ sb });
  const r = await actions.createClient(MANAGER, { full_name: 'New Guy', manager_id: 'someone-else' });
  assert.equal(r.ok, true);
  const insert = sb.calls.find((c) => c.op === 'insert' && c.table === 'manager_clients');
  assert.equal(insert.row.manager_id, MANAGER);
});

test('addPosition writes a BUY history event', async () => {
  const sb = seed();
  const actions = createManagerActions({ sb });
  const r = await actions.addPosition(MANAGER, { portfolioId: 'p1', symbol: 'aapl', entry_price: 182.5, shares: 10 });
  assert.equal(r.ok, true);
  const hist = sb.calls.find((c) => c.op === 'insert' && c.table === 'position_history');
  assert.equal(hist.row.event_type, 'BUY');
  assert.equal(hist.row.symbol, 'AAPL');           // uppercased
  assert.equal(hist.row.total_value, 1825);
});

test('addPosition rejects a portfolio the manager does not own', async () => {
  const sb = fakeSupabase({ client_portfolios: [] });   // no rows -> not found
  const actions = createManagerActions({ sb });
  const r = await actions.addPosition(MANAGER, { portfolioId: 'nope', symbol: 'AAPL', entry_price: 10 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 404);
});

test('addPosition rejects a portfolio belonging to a different manager', async () => {
  const sb = seedWithOtherManager();
  const actions = createManagerActions({ sb });
  const r = await actions.addPosition(MANAGER, { portfolioId: 'p2', symbol: 'AAPL', entry_price: 10 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 404);
});

test('addPosition requires symbol and entry_price', async () => {
  const actions = createManagerActions({ sb: seed() });
  assert.equal((await actions.addPosition(MANAGER, { portfolioId: 'p1', symbol: 'AAPL' })).code, 400);
  assert.equal((await actions.addPosition(MANAGER, { portfolioId: 'p1', entry_price: 5 })).code, 400);
});

test('sellPosition records gain_pct and deletes the position', async () => {
  const sb = seed();
  const actions = createManagerActions({ sb });
  const r = await actions.sellPosition(MANAGER, { positionId: 'pos1', sell_price: 150 });
  assert.equal(r.ok, true);
  assert.equal(Math.round(r.data.gain_pct), 50);
  const hist = sb.calls.find((c) => c.op === 'insert' && c.table === 'position_history');
  assert.equal(hist.row.event_type, 'SELL');
  assert.ok(sb.calls.some((c) => c.op === 'delete' && c.table === 'portfolio_positions'));
});

test('source defaults to manual and is carried through to history', async () => {
  const sb = seed();
  const actions = createManagerActions({ sb });
  await actions.addPosition(MANAGER, { portfolioId: 'p1', symbol: 'AAPL', entry_price: 10 });
  await actions.addPosition(MANAGER, { portfolioId: 'p1', symbol: 'MSFT', entry_price: 20, source: 'agent', proposalId: 'prop-9' });
  const hists = sb.calls.filter((c) => c.op === 'insert' && c.table === 'position_history');
  assert.equal(hists[0].row.source, 'manual');
  assert.equal(hists[1].row.source, 'agent');
  assert.equal(hists[1].row.proposal_id, 'prop-9');
});

test('sellPosition rejects a position belonging to a different manager', async () => {
  const sb = seedWithOtherManager();
  const actions = createManagerActions({ sb });
  const r = await actions.sellPosition(MANAGER, { positionId: 'pos2', sell_price: 300 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 404);
});

// ── updateClient ────────────────────────────────────────────────────────

test('updateClient requires clientId', async () => {
  const actions = createManagerActions({ sb: seed() });
  const r = await actions.updateClient(MANAGER, { full_name: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 400);
});

test('updateClient requires at least one field to update', async () => {
  const actions = createManagerActions({ sb: seed() });
  const r = await actions.updateClient(MANAGER, { clientId: 'c1' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 400);
});

test('updateClient updates allowed fields on an owned client', async () => {
  const sb = seed();
  const actions = createManagerActions({ sb });
  const r = await actions.updateClient(MANAGER, { clientId: 'c1', full_name: 'Jane S.', risk_profile: 'aggressive' });
  assert.equal(r.ok, true);
  assert.equal(r.data.full_name, 'Jane S.');
  assert.equal(r.data.risk_profile, 'aggressive');
  const upd = sb.calls.find((c) => c.op === 'update' && c.table === 'manager_clients');
  assert.equal(upd.filters.id, 'c1');
  assert.equal(upd.filters.manager_id, MANAGER);
});

test('updateClient 404s on a nonexistent client', async () => {
  const actions = createManagerActions({ sb: fakeSupabase({ manager_clients: [] }) });
  const r = await actions.updateClient(MANAGER, { clientId: 'nope', full_name: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 404);
});

test('updateClient rejects a client belonging to a different manager', async () => {
  const sb = seedWithOtherManager();
  const actions = createManagerActions({ sb });
  const r = await actions.updateClient(MANAGER, { clientId: 'c2', full_name: 'Hijacked' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 404);
});

// ── deleteClient ────────────────────────────────────────────────────────

test('deleteClient requires clientId', async () => {
  const actions = createManagerActions({ sb: seed() });
  const r = await actions.deleteClient(MANAGER, {});
  assert.equal(r.ok, false);
  assert.equal(r.code, 400);
});

test('deleteClient deletes an owned client', async () => {
  const sb = seed();
  const actions = createManagerActions({ sb });
  const r = await actions.deleteClient(MANAGER, { clientId: 'c1' });
  assert.equal(r.ok, true);
  const del = sb.calls.find((c) => c.op === 'delete' && c.table === 'manager_clients');
  assert.equal(del.filters.id, 'c1');
  assert.equal(del.filters.manager_id, MANAGER);
});

test('deleteClient rejects a client belonging to a different manager', async () => {
  const sb = seedWithOtherManager();
  const actions = createManagerActions({ sb });
  const r = await actions.deleteClient(MANAGER, { clientId: 'c2' }); // c2 belongs to OTHER
  assert.equal(r.ok, false);
  assert.equal(r.code, 404);
});

// ── createPortfolio ─────────────────────────────────────────────────────

test('createPortfolio requires clientId and name', async () => {
  const actions = createManagerActions({ sb: seed() });
  assert.equal((await actions.createPortfolio(MANAGER, { name: 'x' })).code, 400);
  assert.equal((await actions.createPortfolio(MANAGER, { clientId: 'c1' })).code, 400);
});

test('createPortfolio creates a portfolio for an owned client', async () => {
  const sb = seed();
  const actions = createManagerActions({ sb });
  const r = await actions.createPortfolio(MANAGER, { clientId: 'c1', name: 'Income' });
  assert.equal(r.ok, true);
  assert.equal(r.data.name, 'Income');
  assert.equal(r.data.client_id, 'c1');
});

test('createPortfolio rejects a client belonging to a different manager', async () => {
  const sb = seedWithOtherManager();
  const actions = createManagerActions({ sb });
  const r = await actions.createPortfolio(MANAGER, { clientId: 'c2', name: 'Hijacked' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 404);
});

// ── updatePosition ──────────────────────────────────────────────────────

test('updatePosition requires positionId', async () => {
  const actions = createManagerActions({ sb: seed() });
  const r = await actions.updatePosition(MANAGER, {});
  assert.equal(r.ok, false);
  assert.equal(r.code, 400);
});

test('updatePosition updates fields and logs a REBALANCE event', async () => {
  const sb = seed();
  const actions = createManagerActions({ sb });
  const r = await actions.updatePosition(MANAGER, { positionId: 'pos1', entry_price: 120, shares: 12 });
  assert.equal(r.ok, true);
  const hist = sb.calls.find((c) => c.op === 'insert' && c.table === 'position_history');
  assert.equal(hist.row.event_type, 'REBALANCE');
  assert.equal(hist.row.price, 120);
  assert.equal(hist.row.shares, 12);
});

test('updatePosition rejects a position belonging to a different manager', async () => {
  const sb = seedWithOtherManager();
  const actions = createManagerActions({ sb });
  const r = await actions.updatePosition(MANAGER, { positionId: 'pos2', entry_price: 999 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 404);
});

// ── deletePosition ──────────────────────────────────────────────────────

test('deletePosition requires positionId', async () => {
  const actions = createManagerActions({ sb: seed() });
  const r = await actions.deletePosition(MANAGER, {});
  assert.equal(r.ok, false);
  assert.equal(r.code, 400);
});

test('deletePosition deletes an owned position', async () => {
  const sb = seed();
  const actions = createManagerActions({ sb });
  const r = await actions.deletePosition(MANAGER, { positionId: 'pos1' });
  assert.equal(r.ok, true);
  assert.ok(sb.calls.some((c) => c.op === 'delete' && c.table === 'portfolio_positions' && c.filters.id === 'pos1'));
});

test('deletePosition rejects a position belonging to a different manager', async () => {
  const sb = seedWithOtherManager();
  const actions = createManagerActions({ sb });
  const r = await actions.deletePosition(MANAGER, { positionId: 'pos2' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 404);
});

// ── Finding 4: a failed history insert must never be silent ───────────────
// history() used to `await` its insert and discard `{ error }`. A failed
// audit-trail write must surface to the caller instead of coming back as a
// plain { ok: true } — and for sellPosition specifically, the SELL record is
// written before the position is deleted, so the delete must never run when
// that write failed (otherwise the position vanishes with no trace it ever
// existed).

test('addPosition surfaces a failed history insert instead of silently succeeding', async () => {
  const sb = seed();
  sb_position_history_fails(sb);
  const actions = createManagerActions({ sb });
  const r = await actions.addPosition(MANAGER, { portfolioId: 'p1', symbol: 'AAPL', entry_price: 10 });
  assert.equal(r.ok, false);
});

test('updatePosition surfaces a failed history insert instead of silently succeeding', async () => {
  const sb = seed();
  sb_position_history_fails(sb);
  const actions = createManagerActions({ sb });
  const r = await actions.updatePosition(MANAGER, { positionId: 'pos1', entry_price: 120 });
  assert.equal(r.ok, false);
});

test('sellPosition aborts BEFORE deleting the position when the history insert fails', async () => {
  const sb = seed();
  sb_position_history_fails(sb);
  const actions = createManagerActions({ sb });
  const r = await actions.sellPosition(MANAGER, { positionId: 'pos1', sell_price: 150 });
  assert.equal(r.ok, false);
  assert.ok(
    !sb.calls.some((c) => c.op === 'delete' && c.table === 'portfolio_positions'),
    'the position must not be deleted when its SELL audit record failed to write'
  );
});

// Reseeds a fake Supabase's position_history table so every insert against it
// fails, without disturbing any other table the fixture already carries.
function sb_position_history_fails(sb) {
  sb.tables.position_history = { error: { message: 'audit trail unavailable' } };
}
