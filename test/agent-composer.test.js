'use strict';
// Exercises the actual public/agent.js (no DOM library — a hand-rolled fake
// scoped to exactly the getElementById/querySelectorAll calls agent.js makes)
// to cover: XSS-escaping of LLM-controlled row content, checkbox <-> row-index
// wiring, and that an in-place field edit survives into what gets posted to
// /execute.

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'agent.js'), 'utf8');

// #agentRows is the only element agent.js ever queries into — parse the
// checkbox rows out of whatever HTML it last wrote there.
function parseCheckboxes(html) {
  const boxes = [];
  const re = /<input type="checkbox" data-check="(\d+)"\s*(checked)?/g;
  let m;
  while ((m = re.exec(html))) boxes.push({ checked: Boolean(m[2]), dataset: { check: m[1] } });
  return boxes;
}

function makeSandbox({ fetchImpl } = {}) {
  const elements = new Map();
  function el(id) {
    if (!elements.has(id)) {
      const rec = { id, hidden: false, disabled: false, value: '', _text: '', _html: '' };
      Object.defineProperty(rec, 'textContent', { get() { return this._text; }, set(v) { this._text = v; } });
      Object.defineProperty(rec, 'innerHTML', {
        get() { return this._html; },
        set(v) { this._html = v; if (id === 'agentRows') this._boxes = parseCheckboxes(v); },
      });
      rec._boxes = [];
      elements.set(id, rec);
    }
    return elements.get(id);
  }
  const document = {
    getElementById: (id) => el(id),
    querySelectorAll: (selector) => {
      const boxes = el('agentRows')._boxes;
      return selector.includes(':checked') ? boxes.filter((b) => b.checked) : boxes.slice();
    },
  };
  const calls = [];
  const context = {
    document,
    localStorage: { getItem: () => 'tok' },
    fetch: fetchImpl || (async () => ({ ok: true, status: 200, json: async () => ({}) })),
    console,
  };
  // agent.js does `window.foo = ...` and then calls bare `foo()` elsewhere
  // (e.g. render() calls `agentCount()` directly) — exactly like a browser,
  // where `window` IS the global object, so a `window.x` assignment is also
  // a global binding. vm.createContext(context) makes `context` the sandbox's
  // global object, so aliasing `window` to itself reproduces that.
  vm.createContext(context);
  context.window = context;
  context.window.agentContext = () => ({ selectedClientId: 'c1', selectedPortfolioId: 'p1' });
  vm.runInContext(SRC, context, { filename: 'agent.js' });
  return { context, el, calls };
}

function queueJson(body, ok = true) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok, status: ok ? 200 : 400, json: async () => body };
  };
  return { fetchImpl, calls };
}

test('agent.js escapes LLM-controlled row content (XSS)', async () => {
  const parseResponse = {
    proposalId: 'prop-1',
    plan: { summary: 'One change', clarification: null, transcript: null },
    actions: [{
      op: 'addPosition',
      ref: 'a1',
      target: { portfolioId: 'p1' },
      fields: { symbol: 'MSFT', entry_price: '"><script>alert(1)</script>' },
      confidence: 0.9,
      source: '<img src=x onerror=alert(1)>',
      reasoning: '',
      valid: true,
      problems: [],
    }],
    errors: [],
  };
  const { fetchImpl } = queueJson(parseResponse);
  const { el, context } = makeSandbox({ fetchImpl });

  el('agentText').value = 'bought MSFT';
  el('agentClarify').hidden = true; // not mid-clarification
  await context.window.agentSend();

  const html = el('agentRows').innerHTML;
  assert.ok(!html.includes('<img src=x'), 'raw <img> tag must not appear unescaped');
  assert.ok(html.includes('&lt;img src=x'), 'source field must be HTML-escaped');
  assert.ok(!html.includes('<script>alert(1)</script>'), 'field value must not inject a raw <script> tag');
  assert.ok(html.includes('&lt;script&gt;'), 'field value must be HTML-escaped');
});

test('checkbox selection maps to the right row and Apply sends only checked rows', async () => {
  const parseResponse = {
    proposalId: 'prop-2',
    plan: { summary: 'Two changes', clarification: null, transcript: null },
    actions: [
      { op: 'addPosition', ref: 'a1', target: { portfolioId: 'p1' }, fields: { symbol: 'AAPL', entry_price: 182 },
        confidence: 0.9, source: '', reasoning: '', valid: true, problems: [] },
      { op: 'addPosition', ref: 'a2', target: { portfolioId: 'p1' }, fields: { symbol: 'ZZZZQQ', entry_price: 10 },
        confidence: 0.3, source: '', reasoning: '', valid: false, problems: ['Unknown ticker.'] },
    ],
    errors: [],
  };
  const { fetchImpl, calls } = queueJson(parseResponse);
  const { el, context } = makeSandbox({ fetchImpl });

  el('agentText').value = 'bought 5 AAPL at 182 and 3 of ZZZZQQ at 10';
  el('agentClarify').hidden = true;
  await context.window.agentSend();

  // Row 0 (valid) starts checked, row 1 (invalid) starts unchecked.
  assert.equal(el('agentRows')._boxes.length, 2);
  assert.equal(el('agentRows')._boxes[0].checked, true);
  assert.equal(el('agentRows')._boxes[1].checked, false);
  context.window.agentCount();
  assert.equal(el('agentCount').textContent, '1 selected');

  // Apply selected — only the checked row's index (0) should be sent.
  const executeResponse = { results: [{ ref: 'a1', op: 'addPosition', ok: true, data: {} }] };
  calls.length = 0;
  const exec = queueJson(executeResponse);
  context.fetch = exec.fetchImpl;
  await context.window.agentExecute();

  assert.equal(exec.calls.length, 1);
  const sent = JSON.parse(exec.calls[0].opts.body);
  assert.equal(sent.rows.length, 1);
  assert.equal(sent.rows[0].ref, 'a1');
  assert.equal(sent.rows[0].fields.symbol, 'AAPL');
});

test('an in-place field edit survives (as a string) into the executed row', async () => {
  const parseResponse = {
    proposalId: 'prop-3',
    plan: { summary: 'One change', clarification: null, transcript: null },
    actions: [{
      op: 'addPosition', ref: 'a1', target: { portfolioId: 'p1' },
      fields: { symbol: 'AAPL', entry_price: 1 },
      confidence: 0.9, source: '', reasoning: '', valid: true, problems: [],
    }],
    errors: [],
  };
  const { fetchImpl } = queueJson(parseResponse);
  const { el, context } = makeSandbox({ fetchImpl });

  el('agentText').value = 'bought 5 AAPL at 1';
  el('agentClarify').hidden = true;
  await context.window.agentSend();

  // Simulate the manager correcting entry_price in the rendered <input>.
  context.window.agentEdit({ dataset: { row: '0', field: 'entry_price' }, value: '182.50' });

  const executeResponse = { results: [{ ref: 'a1', op: 'addPosition', ok: true, data: {} }] };
  const exec = queueJson(executeResponse);
  context.fetch = exec.fetchImpl;
  await context.window.agentExecute();

  const sent = JSON.parse(exec.calls[0].opts.body);
  // The edit lands as a string (raw <input>.value) — src/manager-actions.js's
  // num() and src/agent-schema.js's NUMERIC check both do Number(v), so a
  // numeric-looking string round-trips fine server-side.
  assert.equal(sent.rows[0].fields.entry_price, '182.50');
});

test('closing the drawer drops the pending clarification so the next Send starts fresh', async () => {
  const clarifyResponse = {
    proposalId: null,
    plan: { summary: '', clarification: 'Which client did you mean?', transcript: null },
    actions: [],
    errors: [],
  };
  const { fetchImpl, calls } = queueJson(clarifyResponse);
  const { el, context } = makeSandbox({ fetchImpl });

  el('agentText').value = 'add 10 NVDA at 182';
  el('agentClarify').hidden = true;
  await context.window.agentSend();
  assert.equal(el('agentClarify').hidden, false, 'clarify bar should be showing');

  context.window.agentClose();
  assert.equal(el('agentClarify').hidden, true, 'Close must dismiss the clarification too');

  // A later, unrelated Send must NOT be treated as an answer to the dismissed
  // clarification (i.e. must not be merged with the old text).
  const unrelated = queueJson({ proposalId: 'p2', plan: { summary: '', clarification: null, transcript: null }, actions: [], errors: [] });
  context.fetch = unrelated.fetchImpl;
  el('agentText').value = 'delete the AAPL position for Bob';
  await context.window.agentSend();

  const sentBody = JSON.parse(unrelated.calls[0].opts.body);
  assert.equal(sentBody.text, 'delete the AAPL position for Bob');
  assert.ok(!sentBody.text.includes('NVDA'), 'must not silently merge onto the dismissed proposal\'s text');
});
