'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { ActionPlanSchema, validatePlan, MAX_ACTIONS } = require('../src/agent-schema');

const SNAP = {
  clients: [{ id: 'c1', full_name: 'Jane Smith', risk_profile: 'moderate' }],
  portfolios: [{ id: 'p1', client_id: 'c1', name: 'Growth' }],
  positions: [{ id: 'pos1', portfolio_id: 'p1', symbol: 'NVDA' }],
};

function action(over = {}) {
  return {
    op: 'addPosition', ref: 'a1', dependsOn: null,
    target: { clientId: null, portfolioId: 'p1', positionId: null },
    fields: { symbol: 'AAPL', entry_price: 182.5, shares: 10 },
    confidence: 0.9, source: 'row 1 of the screenshot', reasoning: 'holdings table',
    ...over,
  };
}
const plan = (actions) => ({ actions, clarification: null, summary: 's', transcript: null });

test('an op outside the enum is rejected by the schema', () => {
  const r = ActionPlanSchema.safeParse(plan([action({ op: 'dropTable' })]));
  assert.equal(r.success, false);
});

test('a well-formed plan validates clean', () => {
  const { actions, errors } = validatePlan(ActionPlanSchema.parse(plan([action()])), SNAP);
  assert.deepEqual(errors, []);
  assert.equal(actions[0].valid, true);
});

test('an invented portfolioId is rejected', () => {
  const a = action({ target: { clientId: null, portfolioId: 'p-nope', positionId: null } });
  const { actions } = validatePlan(plan([a]), SNAP);
  assert.equal(actions[0].valid, false);
  assert.match(actions[0].problems.join(' '), /portfolioId/);
});

test('a non-numeric entry_price is rejected', () => {
  const a = action({ fields: { symbol: 'AAPL', entry_price: 'abc' } });
  const { actions } = validatePlan(plan([a]), SNAP);
  assert.equal(actions[0].valid, false);
  assert.match(actions[0].problems.join(' '), /entry_price/);
});

test('a negative entry_price is rejected', () => {
  const a = action({ fields: { symbol: 'AAPL', entry_price: -5 } });
  const { actions } = validatePlan(plan([a]), SNAP);
  assert.equal(actions[0].valid, false);
});

test('createClient without full_name is rejected', () => {
  const a = action({ op: 'createClient', target: { clientId: null, portfolioId: null, positionId: null }, fields: {} });
  const { actions } = validatePlan(plan([a]), SNAP);
  assert.equal(actions[0].valid, false);
  assert.match(actions[0].problems.join(' '), /full_name/);
});

test('a target may be a ref of an earlier create in the same plan', () => {
  const p = plan([
    action({ op: 'createClient', ref: 'a1', target: { clientId: null, portfolioId: null, positionId: null }, fields: { full_name: 'New Guy' } }),
    action({ op: 'createPortfolio', ref: 'a2', dependsOn: 'a1', target: { clientId: '@a1', portfolioId: null, positionId: null }, fields: { name: 'Growth' } }),
  ]);
  const { actions } = validatePlan(p, SNAP);
  assert.equal(actions[0].valid, true);
  assert.equal(actions[1].valid, true);
});

test('dependsOn pointing at an unknown ref is rejected', () => {
  const a = action({ dependsOn: 'a9' });
  const { actions } = validatePlan(plan([a]), SNAP);
  assert.equal(actions[0].valid, false);
  assert.match(actions[0].problems.join(' '), /dependsOn/);
});

test('a dependency cycle is rejected', () => {
  const p = plan([
    action({ ref: 'a1', dependsOn: 'a2' }),
    action({ ref: 'a2', dependsOn: 'a1' }),
  ]);
  const { errors } = validatePlan(p, SNAP);
  assert.match(errors.join(' '), /cycle/i);
});

test('a plan over MAX_ACTIONS is rejected wholesale', () => {
  const many = Array.from({ length: MAX_ACTIONS + 1 }, (_, i) => action({ ref: `a${i}` }));
  const { errors } = validatePlan(plan(many), SNAP);
  assert.match(errors.join(' '), /25/);
});

test('sellPosition needs a positive sell_price and a known positionId', () => {
  const ok = action({ op: 'sellPosition', target: { clientId: null, portfolioId: null, positionId: 'pos1' }, fields: { sell_price: 190 } });
  const bad = action({ op: 'sellPosition', target: { clientId: null, portfolioId: null, positionId: 'pos1' }, fields: { sell_price: 0 } });
  assert.equal(validatePlan(plan([ok]), SNAP).actions[0].valid, true);
  assert.equal(validatePlan(plan([bad]), SNAP).actions[0].valid, false);
});
