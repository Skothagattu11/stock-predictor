'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fakeSupabase } = require('./helpers/fake-supabase');
const { createManagerActions } = require('../src/manager-actions');

const MANAGER = 'mgr-1';

function seed() {
  return fakeSupabase({
    manager_clients: [{ id: 'c1', manager_id: MANAGER, full_name: 'Jane Smith' }],
    client_portfolios: [{ id: 'p1', client_id: 'c1', name: 'Growth' }],
    portfolio_positions: [{ id: 'pos1', portfolio_id: 'p1', symbol: 'NVDA', entry_price: 100, shares: 10 }],
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
