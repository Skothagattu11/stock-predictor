'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fakeSupabase } = require('./helpers/fake-supabase');
const { createAgentService } = require('../src/agent-service');
const { createManagerActions } = require('../src/manager-actions');

const MANAGER = 'mgr-1';

function seedSb() {
  return fakeSupabase({
    manager_clients: [{ id: 'c1', manager_id: MANAGER, full_name: 'Jane Smith', risk_profile: 'moderate' }],
    client_portfolios: [{ id: 'p1', client_id: 'c1', name: 'Growth' }],
    portfolio_positions: [{ id: 'pos1', portfolio_id: 'p1', symbol: 'NVDA', entry_price: 100, shares: 10 }],
  });
}

function svc({ plan, sb = seedSb(), searchSymbols = async (q) => [{ symbol: String(q).toUpperCase(), description: 'x' }] }) {
  let calls = 0;
  const adapter = { name: 'stub', async generate() { calls++; return plan; } };
  const service = createAgentService({
    sb, adapter, actions: createManagerActions({ sb }), searchSymbols,
  });
  return { service, sb, adapterCalls: () => calls };
}

const basePlan = (actions, over = {}) => ({ actions, clarification: null, summary: 'ok', transcript: null, ...over });

test('buildSnapshot returns ids and names only — no money', async () => {
  const { service } = svc({ plan: basePlan([]) });
  const snap = await service.buildSnapshot(MANAGER);
  assert.deepEqual(Object.keys(snap).sort(), ['clients', 'portfolios', 'positions']);
  assert.equal(snap.clients[0].full_name, 'Jane Smith');
  assert.equal(snap.positions[0].entry_price, undefined);
  assert.equal(snap.positions[0].shares, undefined);
});

test('parse validates the model output against the snapshot', async () => {
  const plan = basePlan([{
    op: 'addPosition', ref: 'a1', dependsOn: null,
    target: { clientId: null, portfolioId: 'p1', positionId: null },
    fields: { symbol: 'AAPL', entry_price: 182.5, shares: 10 },
    confidence: 0.92, source: '"bought 10 AAPL at 182.50"', reasoning: 'explicit buy',
  }]);
  const { service } = svc({ plan });
  const out = await service.parse({ managerId: MANAGER, text: 'bought 10 AAPL at 182.50', context: { selectedPortfolioId: 'p1' } });
  assert.equal(out.actions.length, 1);
  assert.equal(out.actions[0].valid, true);
  assert.ok(out.proposalId);
});

test('parse flags an action whose ticker does not resolve', async () => {
  const plan = basePlan([{
    op: 'addPosition', ref: 'a1', dependsOn: null,
    target: { clientId: null, portfolioId: 'p1', positionId: null },
    fields: { symbol: 'ZZZZZZ', entry_price: 10 },
    confidence: 0.5, source: '', reasoning: '',
  }]);
  const { service } = svc({ plan, searchSymbols: async () => [] });
  const out = await service.parse({ managerId: MANAGER, text: 'buy ZZZZZZ' });
  assert.equal(out.actions[0].valid, false);
  assert.match(out.actions[0].problems.join(' '), /ZZZZZZ/);
});

test('parse normalises a resolved ticker to its canonical symbol', async () => {
  const plan = basePlan([{
    op: 'addPosition', ref: 'a1', dependsOn: null,
    target: { clientId: null, portfolioId: 'p1', positionId: null },
    fields: { symbol: 'apple', entry_price: 10 },
    confidence: 0.6, source: '', reasoning: '',
  }]);
  const { service } = svc({ plan, searchSymbols: async () => [{ symbol: 'AAPL', description: 'Apple Inc' }] });
  const out = await service.parse({ managerId: MANAGER, text: 'buy apple' });
  assert.equal(out.actions[0].fields.symbol, 'AAPL');
  assert.equal(out.actions[0].valid, true);
});

test('parse retries once when the model returns something unparseable', async () => {
  let n = 0;
  const sb = seedSb();
  const adapter = { name: 'stub', async generate() {
    n++;
    if (n === 1) return { actions: [{ op: 'nope' }] };
    return basePlan([]);
  } };
  const service = createAgentService({ sb, adapter, actions: createManagerActions({ sb }), searchSymbols: async () => [] });
  const out = await service.parse({ managerId: MANAGER, text: 'hi' });
  assert.equal(n, 2);
  assert.equal(out.actions.length, 0);
});

test('parse surfaces a clarification with no actions', async () => {
  const { service } = svc({ plan: basePlan([], { clarification: 'Which client?' }) });
  const out = await service.parse({ managerId: MANAGER, text: 'add 10 NVDA at 182' });
  assert.equal(out.plan.clarification, 'Which client?');
  assert.equal(out.actions.length, 0);
});

test('execute runs approved rows and reports per row', async () => {
  const { service, sb } = svc({ plan: basePlan([]) });
  const out = await service.execute({ managerId: MANAGER, proposalId: 'prop-1', rows: [
    { op: 'addPosition', ref: 'a1', dependsOn: null, target: { portfolioId: 'p1' }, fields: { symbol: 'AAPL', entry_price: 10, shares: 2 } },
  ] });
  assert.equal(out.results[0].ok, true);
  const hist = sb.calls.find((c) => c.op === 'insert' && c.table === 'position_history');
  assert.equal(hist.row.source, 'agent');
  assert.equal(hist.row.proposal_id, 'prop-1');
});

test('execute rejects an edited row pointing at a portfolio the manager does not own', async () => {
  const { service } = svc({ plan: basePlan([]) });
  const out = await service.execute({ managerId: MANAGER, proposalId: 'prop-1', rows: [
    { op: 'addPosition', ref: 'a1', dependsOn: null, target: { portfolioId: 'someone-elses' }, fields: { symbol: 'AAPL', entry_price: 10 } },
  ] });
  assert.equal(out.results[0].ok, false);
});

test('execute threads a created id into dependent rows', async () => {
  const { service, sb } = svc({ plan: basePlan([]) });
  const out = await service.execute({ managerId: MANAGER, proposalId: 'prop-2', rows: [
    { op: 'createClient', ref: 'a1', dependsOn: null, target: {}, fields: { full_name: 'New Guy' } },
    { op: 'createPortfolio', ref: 'a2', dependsOn: 'a1', target: { clientId: '@a1' }, fields: { name: 'Growth' } },
  ] });
  assert.equal(out.results[0].ok, true);
  assert.equal(out.results[1].ok, true);
  const pf = sb.calls.find((c) => c.op === 'insert' && c.table === 'client_portfolios');
  assert.equal(pf.row.client_id, out.results[0].data.id);
});

test('execute skips dependents when their dependency fails', async () => {
  const { service } = svc({ plan: basePlan([]) });
  const out = await service.execute({ managerId: MANAGER, proposalId: 'prop-3', rows: [
    { op: 'createClient', ref: 'a1', dependsOn: null, target: {}, fields: {} },             // no full_name -> fails
    { op: 'createPortfolio', ref: 'a2', dependsOn: 'a1', target: { clientId: '@a1' }, fields: { name: 'Growth' } },
  ] });
  assert.equal(out.results[0].ok, false);
  assert.equal(out.results[1].ok, false);
  assert.match(out.results[1].error, /skipped/i);
});

test('execute runs independent rows even when a sibling fails', async () => {
  const { service } = svc({ plan: basePlan([]) });
  const out = await service.execute({ managerId: MANAGER, proposalId: 'prop-4', rows: [
    { op: 'addPosition', ref: 'a1', dependsOn: null, target: { portfolioId: 'p1' }, fields: { symbol: 'AAPL' } },  // no entry_price
    { op: 'addPosition', ref: 'a2', dependsOn: null, target: { portfolioId: 'p1' }, fields: { symbol: 'MSFT', entry_price: 20 } },
  ] });
  assert.equal(out.results[0].ok, false);
  assert.equal(out.results[1].ok, true);
});

// ── duplicate ref handling ─────────────────────────────────────────────────
// validatePlan (Task 2) tolerates duplicate `ref` values across actions — a
// later action with the same ref silently overwrites an earlier one in any
// ref -> id map. The executor threads ids by ref (`created.set(row.ref, ...)`
// and `@ref` target resolution), so a duplicate ref could thread the wrong id
// into a dependent row and write to the wrong record. The executor must not
// trust ref uniqueness: a row whose ref repeats one already seen in this run
// is rejected outright, and it must not corrupt the id already threaded from
// the first (legitimate) row with that ref.

test('execute rejects a row whose ref duplicates one already seen in this run', async () => {
  const { service, sb } = svc({ plan: basePlan([]) });
  const out = await service.execute({ managerId: MANAGER, proposalId: 'prop-5', rows: [
    { op: 'createClient', ref: 'a1', dependsOn: null, target: {}, fields: { full_name: 'First Guy' } },
    { op: 'createClient', ref: 'a1', dependsOn: null, target: {}, fields: { full_name: 'Second Guy' } },
  ] });
  assert.equal(out.results[0].ok, true);
  assert.equal(out.results[1].ok, false);
  assert.match(out.results[1].error, /duplicate/i);
  // Only the first row actually wrote.
  const inserts = sb.calls.filter((c) => c.op === 'insert' && c.table === 'manager_clients');
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].row.full_name, 'First Guy');
});

test('a duplicate ref does not corrupt the id threaded from the legitimate row', async () => {
  const { service, sb } = svc({ plan: basePlan([]) });
  const out = await service.execute({ managerId: MANAGER, proposalId: 'prop-6', rows: [
    { op: 'createClient', ref: 'a1', dependsOn: null, target: {}, fields: { full_name: 'First Guy' } },
    { op: 'createClient', ref: 'a1', dependsOn: null, target: {}, fields: { full_name: 'Impostor' } },
    { op: 'createPortfolio', ref: 'a2', dependsOn: 'a1', target: { clientId: '@a1' }, fields: { name: 'Growth' } },
  ] });
  assert.equal(out.results[2].ok, true);
  const pf = sb.calls.find((c) => c.op === 'insert' && c.table === 'client_portfolios');
  assert.equal(pf.row.client_id, out.results[0].data.id);
});

// ── retry path ──────────────────────────────────────────────────────────────
// A schema failure on the retry attempt as well must surface as a clean
// result, not an unhandled throw.

test('parse surfaces cleanly when the model fails schema validation twice', async () => {
  let n = 0;
  const sb = seedSb();
  const adapter = { name: 'stub', async generate() { n++; return { actions: [{ op: 'nope' }] }; } };
  const service = createAgentService({ sb, adapter, actions: createManagerActions({ sb }), searchSymbols: async () => [] });
  const out = await service.parse({ managerId: MANAGER, text: 'hi' });
  assert.equal(n, 2);
  assert.equal(out.proposalId, null);
  assert.equal(out.actions.length, 0);
  assert.ok(out.errors.length > 0);
});

// ── malformed rows ───────────────────────────────────────────────────────────
// rows come from the browser as raw JSON; a malformed entry must be rejected
// per-row, not throw and take the whole request down.

test('execute rejects a null row instead of throwing', async () => {
  const { service } = svc({ plan: basePlan([]) });
  const out = await service.execute({ managerId: MANAGER, proposalId: 'prop-7', rows: [
    null,
    { op: 'addPosition', ref: 'a1', dependsOn: null, target: { portfolioId: 'p1' }, fields: { symbol: 'MSFT', entry_price: 20 } },
  ] });
  assert.equal(out.results[0].ok, false);
  assert.equal(out.results[1].ok, true);
});
