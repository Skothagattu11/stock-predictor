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

// ── Finding 1: per-row re-validation snapshot conflates entity types ────────
// The executor widens the snapshot passed to the per-row validatePlan call
// with ids created earlier in the run, but must only widen the `clients`
// list with created client ids and the `portfolios` list with created
// portfolio ids — not both lists with every id regardless of kind. Otherwise
// a later row can name a just-created portfolio's id as a clientId (literally,
// or via "@ref" — the executor resolves "@ref" to the literal id before this
// validation runs) and the executor's own re-validation wrongly calls it
// valid, so the row falls through to manager-actions.js's ownedClient() check
// and comes back as a generic "Client not found" instead of the executor's
// own "clientId is not one of your records" — the executor is not actually
// re-validating that row's target type.

test('execute rejects a row that names a just-created portfolio id as a clientId, literally and via @ref', async () => {
  const { service } = svc({ plan: basePlan([]) });
  const out = await service.execute({ managerId: MANAGER, proposalId: 'prop-8', rows: [
    { op: 'createPortfolio', ref: 'a1', dependsOn: null, target: { clientId: 'c1' }, fields: { name: 'Growth' } },
    { op: 'updateClient', ref: 'a2', dependsOn: null, target: { clientId: 'new-client_portfolios-0' }, fields: { full_name: 'X' } },
    { op: 'updateClient', ref: 'a3', dependsOn: null, target: { clientId: '@a1' }, fields: { full_name: 'Y' } },
  ] });
  assert.equal(out.results[0].ok, true);
  // sanity check: row 2's literal id really is the id row 1 created.
  assert.equal(out.results[0].data.id, 'new-client_portfolios-0');

  assert.equal(out.results[1].ok, false);
  assert.match(out.results[1].error, /clientId/);

  assert.equal(out.results[2].ok, false);
  assert.match(out.results[2].error, /clientId/);
});

// ── Finding 2: default buildParts fallback has the wrong shape ─────────────
// toParts is called as toParts({ prompt, image, audio }) — a single object —
// so the default (no buildParts injected) must return the bare prompt
// string, not the whole object.

test('parse sends the adapter a bare prompt string when no buildParts is injected', async () => {
  const sb = seedSb();
  let received;
  const adapter = { name: 'stub', async generate(input) { received = input; return basePlan([]); } };
  const service = createAgentService({ sb, adapter, actions: createManagerActions({ sb }), searchSymbols: async () => [] });
  await service.parse({ managerId: MANAGER, text: 'hello' });
  assert.equal(typeof received, 'string');
});

// ── Finding 3: rows beyond MAX_ACTIONS are silently dropped ────────────────
// execute() slices rows to MAX_ACTIONS with no result entry for the dropped
// rows. Every submitted row must be accounted for in the response.

test('execute reports a failed result for every row beyond the per-proposal cap', async () => {
  const { MAX_ACTIONS } = require('../src/agent-schema');
  const { service } = svc({ plan: basePlan([]) });
  const rows = [];
  for (let i = 0; i < MAX_ACTIONS + 5; i++) {
    rows.push({ op: 'addPosition', ref: `a${i}`, dependsOn: null, target: { portfolioId: 'p1' }, fields: { symbol: 'AAPL', entry_price: 10 } });
  }
  const out = await service.execute({ managerId: MANAGER, proposalId: 'prop-9', rows });
  assert.equal(out.results.length, rows.length);
  const dropped = out.results.slice(MAX_ACTIONS);
  assert.equal(dropped.length, 5);
  for (const r of dropped) {
    assert.equal(r.ok, false);
    assert.match(r.error, /limit/i);
  }
});
