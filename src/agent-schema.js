'use strict';
const { z } = require('zod');

// The contract between the model and the portal. The model proposes; this file
// decides whether a proposal is even showable to a human.

const OPS = [
  'createClient', 'updateClient', 'deleteClient',
  'createPortfolio',
  'addPosition', 'updatePosition', 'sellPosition', 'deletePosition',
];

const MAX_ACTIONS = 25;

const ActionSchema = z.object({
  op: z.enum(OPS),
  ref: z.string().min(1),
  dependsOn: z.string().nullable().default(null),
  target: z.object({
    clientId: z.string().nullable().default(null),
    portfolioId: z.string().nullable().default(null),
    positionId: z.string().nullable().default(null),
  }),
  fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  confidence: z.number().min(0).max(1),
  source: z.string().default(''),
  reasoning: z.string().default(''),
});

const ActionPlanSchema = z.object({
  actions: z.array(ActionSchema).default([]),
  clarification: z.string().nullable().default(null),
  summary: z.string().default(''),
  transcript: z.string().nullable().default(null),
});

// Which target ids each op needs, and which fields are mandatory.
const RULES = {
  createClient:    { needs: [],              required: ['full_name'] },
  updateClient:    { needs: ['clientId'],    required: [] },
  deleteClient:    { needs: ['clientId'],    required: [] },
  createPortfolio: { needs: ['clientId'],    required: ['name'] },
  addPosition:     { needs: ['portfolioId'], required: ['symbol', 'entry_price'] },
  updatePosition:  { needs: ['positionId'],  required: [] },
  sellPosition:    { needs: ['positionId'],  required: ['sell_price'] },
  deletePosition:  { needs: ['positionId'],  required: [] },
};

// Numeric fields and their constraint. A field absent is fine; a field present
// and unparseable is not.
const NUMERIC = {
  entry_price:       (n) => n > 0,
  sell_price:        (n) => n > 0,
  shares:            (n) => n >= 0,
  avg_cost:          (n) => n > 0,
  target_sell_price: (n) => n > 0,
  stop_loss_price:   (n) => n > 0,
};

// "@a1" means "the id created by the action with ref a1" — resolved at execute
// time, so it is valid here as long as a1 exists in this plan. Only these ops
// actually mint a new id of the given kind; no op in OPS produces a
// positionId, so a @ref targeting positionId can never resolve.
const PRODUCES = { clientId: 'createClient', portfolioId: 'createPortfolio' };

const isRef = (v) => typeof v === 'string' && v.startsWith('@');

function detectCycle(actions) {
  const byRef = new Map(actions.map((a) => [a.ref, a]));
  for (const start of actions) {
    const seen = new Set();
    let cur = start;
    while (cur && cur.dependsOn) {
      if (seen.has(cur.ref)) return true;
      seen.add(cur.ref);
      cur = byRef.get(cur.dependsOn);
      if (cur && cur.ref === start.ref) return true;
    }
  }
  return false;
}

function validatePlan(plan, snapshot) {
  const errors = [];
  const rawActions = Array.isArray(plan && plan.actions) ? plan.actions : [];
  // This is a trust boundary: plan can arrive un-parsed by ActionPlanSchema
  // (validatePlan is called directly in several paths), so a hostile or
  // malformed entry (null, a string, ...) must become a rejected action, not
  // a thrown TypeError that takes down the request.
  const actions = rawActions.map((a) => (a && typeof a === 'object' ? a : {}));
  const snap = snapshot || {};

  if (actions.length > MAX_ACTIONS) {
    return { actions: [], errors: [`Plan has ${actions.length} actions; the limit is ${MAX_ACTIONS}.`] };
  }

  // Duplicate refs corrupt everything downstream: detectCycle's byRef lookup
  // is last-wins, so a walk can jump into an unrelated same-named action, and
  // an executor threading ids by ref would write into the wrong row. Reject
  // the whole plan before either can happen.
  const seenRefs = new Set();
  for (const a of actions) {
    if (typeof a.ref !== 'string' || !a.ref) continue;
    if (seenRefs.has(a.ref)) {
      return { actions: [], errors: [`Duplicate ref "${a.ref}" in plan.`] };
    }
    seenRefs.add(a.ref);
  }

  if (detectCycle(actions)) {
    return { actions: [], errors: ['Plan contains a dependency cycle.'] };
  }

  const refs = new Set(actions.map((a) => a.ref));
  const clientIds = new Set((snap.clients || []).map((c) => c.id));
  const portfolioIds = new Set((snap.portfolios || []).map((p) => p.id));
  const positionIds = new Set((snap.positions || []).map((p) => p.id));
  const known = { clientId: clientIds, portfolioId: portfolioIds, positionId: positionIds };

  const validated = actions.map((a) => {
    const problems = [];
    // a.op is model-controlled and may be un-parsed; a plain-object lookup
    // keyed by it would resolve inherited Object.prototype members (e.g.
    // '__proto__', 'constructor', 'toString') instead of rejecting them.
    // Validate against the OPS allowlist first.
    const rule = OPS.includes(a.op) ? RULES[a.op] : undefined;
    if (!rule) problems.push(`Unknown op "${a.op}".`);

    if (a.dependsOn && !refs.has(a.dependsOn)) {
      problems.push(`dependsOn "${a.dependsOn}" is not a ref in this plan.`);
    }

    if (rule) {
      for (const key of rule.needs) {
        const val = a.target && a.target[key];
        if (!val) problems.push(`${key} is required for ${a.op}.`);
        else if (isRef(val)) {
          const targetRef = val.slice(1);
          if (!refs.has(targetRef)) {
            problems.push(`${key} refers to "${val}", which is not in this plan.`);
          } else {
            const producerOp = PRODUCES[key];
            const refAction = actions.find((x) => x.ref === targetRef);
            if (!producerOp || !refAction || refAction.op !== producerOp) {
              problems.push(`${key} refers to "${val}", but ref "${targetRef}" does not produce a ${key}.`);
            }
          }
        } else if (!known[key].has(val)) {
          problems.push(`${key} "${val}" is not one of your records.`);
        }
      }
      for (const key of rule.required) {
        const v = a.fields ? a.fields[key] : undefined;
        if (v === undefined || v === null || v === '') problems.push(`${key} is required for ${a.op}.`);
      }
    }

    for (const [key, ok] of Object.entries(NUMERIC)) {
      if (!a.fields || a.fields[key] === undefined || a.fields[key] === null) continue;
      const raw = a.fields[key];
      // Number([100]) === 100, so an array (or any non-primitive) must be
      // rejected before coercion — otherwise a wrong-typed value slips
      // through to a downstream write.
      if (typeof raw === 'object') problems.push(`${key} "${raw}" is not a number.`);
      else {
        const n = Number(raw);
        if (!Number.isFinite(n)) problems.push(`${key} "${raw}" is not a number.`);
        else if (!ok(n)) problems.push(`${key} ${n} is out of range.`);
      }
    }

    return { ...a, valid: problems.length === 0, problems };
  });

  return { actions: validated, errors };
}

module.exports = { OPS, MAX_ACTIONS, ActionSchema, ActionPlanSchema, validatePlan };
