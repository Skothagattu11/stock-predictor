'use strict';

const { ActionPlanSchema, LlmActionPlanSchema, normalizePlan, validatePlan, MAX_ACTIONS, OPS } = require('./agent-schema');

// The agent layer. Produces proposals; never writes. Writes go through the
// injected `actions` (src/manager-actions.js), which is also what the HTTP
// routes use, so agent entries and manual entries are the same operation.

function systemPrompt(snapshot, context) {
  return [
    'You are a data-entry assistant for a wealth manager\'s portfolio book.',
    'Turn the manager\'s input into a list of proposed actions. A human reviews',
    'every action before anything is saved, so propose what the input actually says —',
    'do not invent positions, prices, or people.',
    '',
    'RULES:',
    `- Use only these ops: ${OPS.join(', ')}.`,
    '- Every clientId / portfolioId / positionId MUST be an id from the RECORDS below,',
    '  or "@<ref>" naming an earlier action in this same plan that creates it.',
    '- If you cannot tell which client or portfolio is meant, return no actions and',
    '  set "clarification" to the single question that would resolve it.',
    '- If a name is ambiguous, still propose the action but set confidence below 0.6',
    '  and add a field with key "_candidates" whose value is the candidate ids, comma-separated.',
    '- "fields" is a LIST of {key, value} entries — e.g. [{"key":"full_name","value":"Jane Doe"}].',
    '- "source" must quote the words or describe the part of the image each action came from.',
    '',
    'FIELD NAMES — use exactly these keys, no synonyms (not "quantity", not "price"):',
    '  createClient:    full_name (required), email, phone, risk_profile, investment_goal, notes',
    '  updateClient:    any of the createClient fields, plus is_active',
    '  createPortfolio: name (required), color, strategy',
    '  addPosition:     symbol (required), entry_price (required), shares, avg_cost,',
    '                   target_sell_price, stop_loss_price, note',
    '  updatePosition:  entry_price, shares, avg_cost, target_sell_price, stop_loss_price, note',
    '  sellPosition:    sell_price (required), note',
    '  deleteClient / deletePosition: no fields',
    '  entry_price is the price paid per share; shares is the number of shares.',
    `- At most ${MAX_ACTIONS} actions.`,
    '- If audio was provided, put what you heard in "transcript".',
    '',
    'RECORDS:',
    JSON.stringify(snapshot),
    '',
    'CURRENT SELECTION (use when the input does not name a client or portfolio):',
    JSON.stringify(context || {}),
  ].join('\n');
}

// Which target-id kind each op mints, mirroring agent-schema.js's PRODUCES —
// used only to keep the executor's per-row snapshot-widening scoped to the
// right list (see execute()'s createdByKind below).
const KIND_BY_OP = { createClient: 'clientId', createPortfolio: 'portfolioId' };

// A row that never got a chance to run because the proposal exceeded
// MAX_ACTIONS — every submitted row must show up in the response, not just
// the ones under the cap.
function capExceededResult(row) {
  return {
    ref: row && typeof row === 'object' ? row.ref : undefined,
    op: row && typeof row === 'object' ? row.op : undefined,
    ok: false,
    error: `Exceeded the ${MAX_ACTIONS}-action limit per proposal — this row was not executed.`,
  };
}

function createAgentService({ sb, adapter, actions, searchSymbols, buildParts }) {
  const toParts = buildParts || (({ prompt }) => prompt);

  // ── snapshot ────────────────────────────────────────────────────────────
  // Ids and names only. No prices, no share counts — the model never needs the
  // money to identify a record, and every token here is paid for on every parse.
  async function buildSnapshot(managerId) {
    const { data: clients } = await sb.from('manager_clients')
      .select('id, full_name, risk_profile').eq('manager_id', managerId);

    const clientList = (clients || []).map((c) => ({ id: c.id, full_name: c.full_name, risk_profile: c.risk_profile }));
    const ids = new Set(clientList.map((c) => c.id));

    const { data: portfolios } = await sb.from('client_portfolios').select('id, client_id, name');
    const portfolioList = (portfolios || [])
      .filter((p) => ids.has(p.client_id))
      .map((p) => ({ id: p.id, client_id: p.client_id, name: p.name }));
    const pids = new Set(portfolioList.map((p) => p.id));

    const { data: positions } = await sb.from('portfolio_positions').select('id, portfolio_id, symbol');
    const positionList = (positions || [])
      .filter((p) => pids.has(p.portfolio_id))
      .map((p) => ({ id: p.id, portfolio_id: p.portfolio_id, symbol: p.symbol }));

    return { clients: clientList, portfolios: portfolioList, positions: positionList };
  }

  // ── ticker resolution — deterministic, in code, never the model's job ────
  async function resolveTickers(validated) {
    const wanted = new Set();
    for (const a of validated) {
      if (a.fields && a.fields.symbol) wanted.add(String(a.fields.symbol));
    }
    const resolved = new Map();
    await Promise.all([...wanted].map(async (raw) => {
      try {
        const hits = await searchSymbols(raw);
        const exact = (hits || []).find((h) => h.symbol.toUpperCase() === raw.toUpperCase());
        resolved.set(raw, exact ? exact.symbol : (hits && hits[0] ? hits[0].symbol : null));
      } catch (_) {
        resolved.set(raw, null);   // search down: flag the row, don't guess
      }
    }));

    return validated.map((a) => {
      if (!a.fields || !a.fields.symbol) return a;
      const raw = String(a.fields.symbol);
      const sym = resolved.get(raw);
      if (!sym) {
        return { ...a, valid: false, problems: [...a.problems, `Could not resolve ticker "${raw}".`] };
      }
      return { ...a, fields: { ...a.fields, symbol: sym } };
    });
  }

  // ── parse ───────────────────────────────────────────────────────────────
  async function parse({ managerId, text, image, audio, context }) {
    const snapshot = await buildSnapshot(managerId);
    const prompt = `${systemPrompt(snapshot, context)}\n\nMANAGER INPUT:\n${text || '(see attached media)'}`;

    async function ask(extra) {
      const input = toParts({ prompt: extra ? `${prompt}\n\n${extra}` : prompt, image, audio });
      // LlmActionPlanSchema, not ActionPlanSchema: the model is asked for
      // fields as a key/value list, because Gemini silently returns {} for an
      // open-ended map. normalizePlan folds it back. See agent-schema.js.
      return adapter.generate(input, LlmActionPlanSchema);
    }

    let plan;
    try {
      plan = ActionPlanSchema.parse(normalizePlan(await ask()));
    } catch (err) {
      // One retry with the validator's complaint appended, then give up
      // cleanly rather than loop or throw — a second schema failure is a
      // parse-time result (empty actions + an error), not an uncaught
      // exception that would 500 the request.
      try {
        plan = ActionPlanSchema.parse(normalizePlan(
          await ask(`Your previous reply did not match the required schema: ${err.message}. Reply with valid JSON only.`)
        ));
      } catch (err2) {
        return {
          proposalId: null,
          plan: { actions: [], clarification: null, summary: '', transcript: null },
          actions: [],
          errors: [`Model returned an invalid plan twice: ${err2.message}`],
          snapshot,
        };
      }
    }

    const { actions: checked, errors } = validatePlan(plan, snapshot);
    const withTickers = await resolveTickers(checked);

    const { data: proposal } = await sb.from('agent_proposals').insert({
      manager_id: managerId,
      input_text: text || null,
      input_kind: audio ? 'voice' : image ? 'image' : 'text',
      transcript: plan.transcript || null,
      plan: { ...plan, actions: withTickers },
      status: 'pending',
    }).select().single();

    return { proposalId: proposal && proposal.id, plan, actions: withTickers, errors, snapshot };
  }

  // ── execute ─────────────────────────────────────────────────────────────
  // Rows arrive from the browser after human edits. They are input, not truth:
  // each one is re-checked against the snapshot and re-run through the same
  // ownership-enforcing action the manual routes use.
  //
  // validatePlan (Task 2) does not reject duplicate `ref` values — it only
  // checks that a ref/dependsOn *exists*, not that it's unique. This executor
  // threads ids created mid-run by ref (`created.set(row.ref, ...)` below, and
  // "@ref" target resolution), so a duplicate ref could silently overwrite an
  // earlier one in that map and thread the wrong id into a dependent row —
  // writing to the wrong record. Since ref uniqueness can't be trusted from
  // validatePlan, the executor enforces it itself: the first row with a given
  // ref runs normally; any later row reusing that ref is rejected outright,
  // without touching `created` or `failed` for the ref it collided with — so
  // a legitimate first row's threaded id is never corrupted by an impostor
  // second row of the same ref.
  async function execute({ managerId, proposalId, rows }) {
    const snapshot = await buildSnapshot(managerId);
    const allRows = Array.isArray(rows) ? rows : [];
    const list = allRows.slice(0, MAX_ACTIONS);
    const created = new Map();     // ref -> created id, any kind (for @ref resolution)
    // created ids split by kind — used only to widen the per-row validatePlan
    // snapshot below, so a client id can't be mistaken for a portfolio id (or
    // vice versa) just because both were created earlier in this run.
    const createdByKind = { clientId: new Set(), portfolioId: new Set() };
    const failed = new Set();      // refs that failed, so dependents are skipped
    const seenRefs = new Set();    // refs already processed in this run
    const results = [];

    for (const row of list) {
      // Rows are untrusted browser input — a malformed entry (null, a
      // string, ...) must become a rejected row, not a thrown TypeError.
      if (!row || typeof row !== 'object') {
        results.push({ ref: row && row.ref, op: row && row.op, ok: false, error: 'Invalid row.' });
        continue;
      }

      if (seenRefs.has(row.ref)) {
        results.push({
          ref: row.ref, op: row.op, ok: false,
          error: `Duplicate ref "${row.ref}" — refusing to execute it to avoid threading the wrong id.`,
        });
        continue;
      }
      seenRefs.add(row.ref);

      if (row.dependsOn && failed.has(row.dependsOn)) {
        failed.add(row.ref);
        results.push({ ref: row.ref, op: row.op, ok: false, error: `Skipped — it depends on "${row.dependsOn}", which failed.` });
        continue;
      }

      // Resolve @refs into ids created earlier in this run.
      const target = { ...(row.target || {}) };
      for (const key of ['clientId', 'portfolioId', 'positionId']) {
        const v = target[key];
        if (typeof v === 'string' && v.startsWith('@')) target[key] = created.get(v.slice(1)) || null;
      }

      // dependsOn is not re-checked here: validatePlan's dependsOn check
      // verifies the target ref exists *within the array it's given*, and
      // this array holds only this one row — every dependent row would fail
      // that check spuriously. The executor already resolved dependency
      // success/failure above (the `failed.has(row.dependsOn)` skip), so it's
      // dropped before this single-row pass, which is only checking target
      // ids and field shape.
      const single = { ...row, target, dependsOn: null };
      const { actions: [checked] } = validatePlan({ actions: [single] }, {
        clients: [...snapshot.clients, ...[...createdByKind.clientId].map((id) => ({ id }))],
        portfolios: [...snapshot.portfolios, ...[...createdByKind.portfolioId].map((id) => ({ id }))],
        positions: snapshot.positions,
      });

      if (!checked || !checked.valid) {
        failed.add(row.ref);
        results.push({ ref: row.ref, op: row.op, ok: false, error: (checked ? checked.problems.join(' ') : 'Invalid action.') });
        continue;
      }

      // validatePlan has no ticker rule — a symbol is only ever checked
      // against Yahoo/Finnhub search in resolveTickers, which parse() ran but
      // execute() didn't. Re-run it here so a row the manager ticked despite
      // a red "Could not resolve ticker" flag is refused, not written with
      // the unresolved symbol intact.
      const [resolved] = await resolveTickers([checked]);
      if (!resolved.valid) {
        failed.add(row.ref);
        results.push({ ref: row.ref, op: row.op, ok: false, error: resolved.problems.join(' ') });
        continue;
      }

      const fn = actions[row.op];
      if (!fn) {
        failed.add(row.ref);
        results.push({ ref: row.ref, op: row.op, ok: false, error: `Unsupported op "${row.op}".` });
        continue;
      }

      const input = {
        ...resolved.fields,
        clientId: target.clientId || undefined,
        portfolioId: target.portfolioId || undefined,
        positionId: target.positionId || undefined,
        source: 'agent',
        proposalId,
      };
      delete input._candidates;

      const out = await fn(managerId, input);
      if (out.ok) {
        if (out.data && out.data.id) {
          created.set(row.ref, out.data.id);
          const kind = KIND_BY_OP[row.op];
          if (kind) createdByKind[kind].add(out.data.id);
        }
        results.push({ ref: row.ref, op: row.op, ok: true, data: out.data });
      } else {
        failed.add(row.ref);
        results.push({ ref: row.ref, op: row.op, ok: false, error: out.error });
      }
    }

    results.push(...allRows.slice(MAX_ACTIONS).map(capExceededResult));

    if (proposalId) {
      await sb.from('agent_proposals')
        .update({ status: 'executed', results, executed_at: new Date().toISOString() })
        .eq('id', proposalId).eq('manager_id', managerId);
    }

    return { results };
  }

  return { buildSnapshot, parse, execute };
}

module.exports = { createAgentService, systemPrompt };
