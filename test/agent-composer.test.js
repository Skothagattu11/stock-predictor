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

// Minimal, deliberately-inert stand-ins for the browser image pipeline.
// These do NOT simulate real decoding or resizing — they just let
// downscale() run to completion in Node so the *surrounding* logic (does the
// resulting data URL reach the POST body? does it get cleared? does a
// clarification answer avoid re-sending it?) is exercised through the real
// agent.js code path. The actual MAX_EDGE/canvas scaling math is untested
// here — see the task report for why that needs a real browser.
let fakeDataUrlCounter = 0;
class FakeImage {
  set src(v) {
    this._src = v;
    this.width = 800;
    this.height = 600;
    if (this.onload) this.onload();
  }
  get src() { return this._src; }
}
class FakeFileReader {
  readAsDataURL(file) {
    this.result = `data:${(file && file.type) || 'application/octet-stream'};base64,ZmFrZQ==`;
    if (this.onload) this.onload();
  }
}

// --- Voice input fakes -------------------------------------------------
// Inert stand-ins for the mic pipeline, in the same spirit as FakeImage/
// FakeFileReader above: just enough for agentMic()'s real control flow (the
// re-entrancy guard, the stop/cleanup paths, the data reaching agentSend) to
// run through the actual agent.js code. They do NOT simulate real audio
// capture, encoding, or MediaRecorder's timing/state-transition quirks.
let fakeRecorderInstances = 0;
class FakeMediaRecorder {
  constructor(stream) {
    this.stream = stream;
    this.state = 'inactive';
    fakeRecorderInstances += 1;
    // A unique mimeType per instance so a test can tell two separate
    // recordings' resulting data URLs apart.
    this.mimeType = `audio/webm;take=${fakeRecorderInstances}`;
  }
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    if (this.ondataavailable) this.ondataavailable({ data: { size: 10 } });
    if (this.onstop) this.onstop();
  }
}
class FakeBlob {
  constructor(_parts, opts) { this.type = (opts && opts.type) || ''; }
}
function flush(n = 3) {
  // Lets queued microtasks (e.g. the async onstop handler's continuation
  // past its own `await`) settle before the test inspects state.
  let p = Promise.resolve();
  for (let i = 1; i < n; i += 1) p = p.then(() => {});
  return p;
}

function makeSandbox({ fetchImpl, getUserMediaImpl } = {}) {
  const elements = new Map();
  function el(id, tagName) {
    if (!elements.has(id)) {
      const rec = { id, tagName: tagName || '', hidden: false, disabled: false, value: '', _text: '', _html: '' };
      Object.defineProperty(rec, 'textContent', { get() { return this._text; }, set(v) { this._text = v; } });
      Object.defineProperty(rec, 'innerHTML', {
        get() { return this._html; },
        set(v) { this._html = v; if (id === 'agentRows') this._boxes = parseCheckboxes(v); },
      });
      rec._boxes = [];
      const classes = new Set();
      rec.classList = {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
      };
      elements.set(id, rec);
    }
    return elements.get(id);
  }
  const listeners = {};
  const windowListeners = {};
  let modalOpen = false;
  let activeElement = null;
  const document = {
    getElementById: (id) => el(id),
    get activeElement() { return activeElement; },
    querySelectorAll: (selector) => {
      const boxes = el('agentRows')._boxes;
      return selector.includes(':checked') ? boxes.filter((b) => b.checked) : boxes.slice();
    },
    querySelector: (selector) => (selector === '.modal-bg.open' && modalOpen ? {} : null),
    addEventListener: (type, handler) => { listeners[type] = handler; },
    createElement: (tag) => {
      if (tag !== 'canvas') throw new Error(`unexpected createElement(${tag})`);
      fakeDataUrlCounter += 1;
      const n = fakeDataUrlCounter;
      return {
        width: 0, height: 0,
        getContext: () => ({ drawImage: () => {} }),
        toDataURL: () => `data:image/jpeg;base64,fakeimage${n}`,
      };
    },
  };
  const micTracks = [];
  const defaultGetUserMedia = async () => {
    const track = { stopped: false };
    track.stop = () => { track.stopped = true; };
    micTracks.push(track);
    return { getTracks: () => [track] };
  };
  const calls = [];
  const context = {
    document,
    localStorage: { getItem: () => 'tok' },
    fetch: fetchImpl || (async () => ({ ok: true, status: 200, json: async () => ({}) })),
    console,
    Image: FakeImage,
    FileReader: FakeFileReader,
    navigator: { mediaDevices: { getUserMedia: getUserMediaImpl || defaultGetUserMedia } },
    MediaRecorder: FakeMediaRecorder,
    Blob: FakeBlob,
    addEventListener: (type, handler) => { windowListeners[type] = handler; },
    // Inert: agent.js only uses this for the 2-minute recording cap, which no
    // test exercises. A real timer would keep the test process alive.
    setTimeout: () => {},
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
  return {
    context, el, calls, listeners, windowListeners, micTracks,
    setModalOpen: (v) => { modalOpen = v; },
    setActiveElement: (elOrNull) => { activeElement = elOrNull; },
  };
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

// --- Image input -----------------------------------------------------------
// downscale() itself (the canvas resize: MAX_EDGE scaling, JPEG q0.8) cannot
// be exercised without a real DOM/canvas and is NOT covered here — see
// FakeImage/FakeFileReader above and the task report. These tests only cover
// the data-flow around whatever data URL downscale() produces.

test('an attached screenshot rides into the /parse body and is cleared after a successful send', async () => {
  const parseResponse = {
    proposalId: 'prop-img-1',
    plan: { summary: 'One change', clarification: null, transcript: null },
    actions: [],
    errors: [],
  };
  const { fetchImpl, calls } = queueJson(parseResponse);
  const { el, context } = makeSandbox({ fetchImpl });

  await context.window.agentAttach({ files: [{ size: 1000, type: 'image/png' }], value: '' });
  assert.equal(el('agentAttach').hidden, false, 'attach strip should show once downscale resolves');
  const thumb = el('agentThumb').src;
  assert.match(thumb, /^data:image\/jpeg;base64,/);

  el('agentText').value = '';
  el('agentClarify').hidden = true;
  await context.window.agentSend();

  const sent = JSON.parse(calls[0].opts.body);
  assert.equal(sent.image, thumb, 'the downscaled data URL must be the one sent');

  assert.equal(el('agentAttach').hidden, true, 'attachment strip must clear after a successful send');
});

test('an over-25MB file is rejected before it reaches the canvas, with a message the manager sees', async () => {
  const { el, context } = makeSandbox();
  el('agentAttach').hidden = true; // fake element defaults to false; real markup starts `hidden`

  const oversized = { size: 25 * 1024 * 1024 + 1, type: 'image/png' };
  await context.window.agentAttach({ files: [oversized], value: '' });

  assert.equal(el('agentAttach').hidden, true, 'an oversized file must not attach');
  assert.match(el('agentStatus').textContent, /too large/i);
  assert.match(el('agentStatus').textContent, /25MB/);
});

test('a clarification answer reuses the original request and ignores a newly (re)attached image', async () => {
  const clarifyResponse = {
    proposalId: null,
    plan: { summary: '', clarification: 'Which client did you mean?', transcript: null },
    actions: [],
    errors: [],
  };
  const { fetchImpl } = queueJson(clarifyResponse);
  const { el, context } = makeSandbox({ fetchImpl });

  await context.window.agentAttach({ files: [{ size: 1000, type: 'image/png' }], value: '' });
  const firstImage = el('agentThumb').src;
  el('agentText').value = 'bought some shares';
  el('agentClarify').hidden = true;
  await context.window.agentSend();
  assert.equal(el('agentClarify').hidden, false);
  assert.equal(el('agentAttach').hidden, true, 'attachment clears even though this send produced a clarification');

  // Manager attaches a *different* screenshot while answering the clarification.
  await context.window.agentAttach({ files: [{ size: 1000, type: 'image/png' }], value: '' });
  const secondImage = el('agentThumb').src;
  assert.notEqual(secondImage, firstImage, 'sanity check: the two fake attachments differ');

  const answer = queueJson({ proposalId: 'p2', plan: { summary: '', clarification: null, transcript: null }, actions: [], errors: [] });
  context.fetch = answer.fetchImpl;
  el('agentText').value = 'Jane Smith';
  await context.window.agentSend();

  const sent = JSON.parse(answer.calls[0].opts.body);
  assert.equal(sent.image, firstImage, 'clarification answer must resend the ORIGINAL image, not the newly attached one');
  assert.notEqual(sent.image, secondImage);
});

test('paste-to-attach is ignored while a modal is open, and works once none is', async () => {
  const { el, listeners, setModalOpen } = makeSandbox();
  assert.equal(typeof listeners.paste, 'function', 'agent.js must register a document paste listener');
  el('agentAttach').hidden = true; // the fake element defaults to false; real markup starts `hidden`

  const imageItem = { type: 'image/png', getAsFile: () => ({ size: 1000, type: 'image/png' }) };
  const pasteEvent = { clipboardData: { items: [imageItem] } };

  setModalOpen(true);
  listeners.paste(pasteEvent);
  await Promise.resolve(); // let any (unexpected) downscale microtask settle
  assert.equal(el('agentAttach').hidden, true, 'a paste while a modal is open must not attach to the agent composer');

  setModalOpen(false);
  listeners.paste(pasteEvent);
  await Promise.resolve();
  assert.equal(el('agentAttach').hidden, false, 'a paste with no modal open should attach normally');
});

test('paste-to-attach is ignored when focus is in a non-composer text input, and works when focus is in #agentText', async () => {
  const { el, listeners, setActiveElement } = makeSandbox();
  el('agentAttach').hidden = true;

  const imageItem = { type: 'image/png', getAsFile: () => ({ size: 1000, type: 'image/png' }) };
  const pasteEvent = { clipboardData: { items: [imageItem] } };

  // Focus in #clientSearch (a real non-modal input in manager.html) — the
  // image must not attach behind the manager's back.
  const clientSearch = el('clientSearch', 'INPUT');
  setActiveElement(clientSearch);
  listeners.paste(pasteEvent);
  await Promise.resolve();
  assert.equal(el('agentAttach').hidden, true, 'a paste while focus is in another text input must not attach to the composer');

  // Focus in the composer's own #agentText — this is the intended gesture.
  const agentText = el('agentText', 'INPUT');
  setActiveElement(agentText);
  listeners.paste(pasteEvent);
  await Promise.resolve();
  assert.equal(el('agentAttach').hidden, false, 'a paste while focus is in #agentText should still attach');
});

// --- Voice input -------------------------------------------------------
// The real recording/encoding pipeline (MediaRecorder timing, codec choice)
// cannot be exercised without a real browser and mic — see FakeMediaRecorder
// above and the task report. These tests cover the data-flow through the
// real agentMic()/agentSend() code: the re-entrancy guard, the mic-stream
// cleanup paths, and how a recording rides into and is cleared from /parse.

test('a recorded note rides the /parse body and is cleared after a successful send', async () => {
  const parseResponse = {
    proposalId: 'prop-audio-1',
    plan: { summary: 'One change', clarification: null, transcript: 'bought some shares' },
    actions: [],
    errors: [],
  };
  const { fetchImpl, calls } = queueJson(parseResponse);
  const { el, context } = makeSandbox({ fetchImpl });

  await context.window.agentMic(); // tap: start recording
  assert.equal(el('agentMic').classList.contains('recording'), true, 'mic button must show it is recording');

  await context.window.agentMic(); // tap again: stop
  await flush();
  assert.equal(el('agentMic').classList.contains('recording'), false);
  assert.match(el('agentStatus').textContent, /Recorded/);

  el('agentText').value = '';
  el('agentClarify').hidden = true;
  await context.window.agentSend();

  assert.equal(calls.length, 1);
  const sent = JSON.parse(calls[0].opts.body);
  assert.match(sent.audio, /^data:audio\/webm;take=\d+;base64,ZmFrZQ==$/, 'the recorded data URL must ride the /parse body');

  // Cleared after a successful send — a further Send with nothing else
  // queued must not fire another /parse call.
  calls.length = 0;
  await context.window.agentSend();
  assert.equal(calls.length, 0, 'recordedAudio must be cleared after a successful send');
});

test('a failed parse leaves the recorded audio in place for a retry', async () => {
  const { fetchImpl: failFetch } = queueJson({ error: 'model unavailable' }, false);
  const { el, context } = makeSandbox({ fetchImpl: failFetch });

  const take = fakeRecorderInstances + 1; // this test's recording, whatever the shared counter is at
  await context.window.agentMic();
  await context.window.agentMic();
  await flush();

  el('agentText').value = '';
  el('agentClarify').hidden = true;
  await context.window.agentSend();
  assert.match(el('agentStatus').textContent, /model unavailable/);

  // Retry — no new recording is made — must resend the same audio.
  const ok = queueJson({ proposalId: 'p', plan: { summary: '', clarification: null, transcript: null }, actions: [], errors: [] });
  context.fetch = ok.fetchImpl;
  await context.window.agentSend();

  assert.equal(ok.calls.length, 1);
  const sent = JSON.parse(ok.calls[0].opts.body);
  assert.match(sent.audio, new RegExp(`take=${take};`), 'a failed send must preserve the recording for retry, not drop it');
});

test('a clarification answer resends the original recording, not a newly recorded one', async () => {
  const clarifyResponse = {
    proposalId: null,
    plan: { summary: '', clarification: 'Which client did you mean?', transcript: 'sold some NVDA' },
    actions: [],
    errors: [],
  };
  const { fetchImpl } = queueJson(clarifyResponse);
  const { el, context } = makeSandbox({ fetchImpl });

  const firstTake = fakeRecorderInstances + 1;
  await context.window.agentMic();
  await context.window.agentMic();
  await flush();

  el('agentText').value = 'sold some NVDA';
  el('agentClarify').hidden = true;
  await context.window.agentSend();
  assert.equal(el('agentClarify').hidden, false);

  // Manager records again while answering the clarification — this new
  // recording must be ignored in favor of the original.
  const secondTake = fakeRecorderInstances + 1;
  await context.window.agentMic();
  await context.window.agentMic();
  await flush();

  const answer = queueJson({ proposalId: 'p2', plan: { summary: '', clarification: null, transcript: null }, actions: [], errors: [] });
  context.fetch = answer.fetchImpl;
  el('agentText').value = 'Jane Smith';
  await context.window.agentSend();

  const sent = JSON.parse(answer.calls[0].opts.body);
  assert.match(sent.audio, new RegExp(`take=${firstTake};`), 'clarification answer must resend the ORIGINAL recording');
  assert.doesNotMatch(sent.audio, new RegExp(`take=${secondTake};`), 'must not pick up the recording made while answering');
});

test('a double tap during the permission prompt does not spin up two recorders', async () => {
  let resolveGUM;
  const { el, context } = makeSandbox({
    getUserMediaImpl: () => new Promise((resolve) => { resolveGUM = resolve; }),
  });
  const before = fakeRecorderInstances;

  const p1 = context.window.agentMic(); // tap 1 — permission prompt pending
  await Promise.resolve();
  assert.equal(el('agentMic').disabled, true, 'button should be disabled while the permission prompt is pending');

  const p2 = context.window.agentMic(); // tap 2 — must be a no-op, not a second prompt
  await p2;

  resolveGUM({ getTracks: () => [{ stop: () => {} }] });
  await p1;

  assert.equal(fakeRecorderInstances - before, 1, 'only one MediaRecorder must be created from a double tap');
});

test('microphone permission denied shows a message and leaves the composer usable', async () => {
  const { el, context } = makeSandbox({
    getUserMediaImpl: async () => { throw new Error('NotAllowedError'); },
  });

  await context.window.agentMic();
  assert.match(el('agentStatus').textContent, /permission denied/i);
  assert.equal(el('agentMic').classList.contains('recording'), false);
  assert.equal(el('agentMic').disabled, false, 'the mic button must be usable again, not stuck disabled');

  // The composer keeps working via typed text.
  const { fetchImpl, calls } = queueJson({ proposalId: 'p', plan: { summary: '', clarification: null, transcript: null }, actions: [], errors: [] });
  context.fetch = fetchImpl;
  el('agentText').value = 'typed instead';
  el('agentClarify').hidden = true;
  await context.window.agentSend();
  assert.equal(calls.length, 1);
});

// --- Ambiguity flow (Finding 3, UC-4) ---------------------------------------
// An ambiguous row (the model matched more than one client by name) is
// `valid: true` because it carries one candidate's id — that's what a plain
// `row.valid` checkbox default would pre-approve. It must arrive UNCHECKED
// until the manager explicitly picks a candidate, and the dropdown must show
// readable names (the snapshot's full_name), not raw 36-character uuids.

test('an ambiguous row arrives unchecked, and its dropdown shows client names, not raw ids', async () => {
  const parseResponse = {
    proposalId: 'prop-amb-1',
    plan: { summary: 'One change', clarification: null, transcript: null },
    snapshot: { clients: [
      { id: 'client-uuid-jane-1', full_name: 'Jane Smith' },
      { id: 'client-uuid-jane-2', full_name: 'Jane Smith' },
    ], portfolios: [], positions: [] },
    actions: [{
      op: 'updateClient', ref: 'a1', target: { clientId: 'client-uuid-jane-1' },
      fields: { full_name: 'Jane Smith', _candidates: 'client-uuid-jane-1,client-uuid-jane-2' },
      confidence: 0.4, source: 'set Jane\'s risk profile to aggressive', reasoning: '',
      valid: true, problems: [],
    }],
    errors: [],
  };
  const { fetchImpl } = queueJson(parseResponse);
  const { el, context } = makeSandbox({ fetchImpl });

  el('agentText').value = "set Jane's risk profile to aggressive";
  el('agentClarify').hidden = true;
  await context.window.agentSend();

  const html = el('agentRows').innerHTML;
  assert.equal(el('agentRows')._boxes[0].checked, false, 'an ambiguous row must not arrive pre-approved');
  assert.ok(!html.includes('client-uuid-jane-1<'), 'raw id must not be used as the visible option label');
  assert.ok(html.includes('>Jane Smith<'), 'dropdown option must show the matching client\'s full_name');

  // Approval stays blocked until a candidate is picked.
  context.window.agentCount();
  assert.equal(el('agentCount').textContent, '0 selected');
});

test('after picking a candidate and ticking the row, the picked id (not the model\'s default guess) is what gets sent to execute', async () => {
  const parseResponse = {
    proposalId: 'prop-amb-2',
    plan: { summary: 'One change', clarification: null, transcript: null },
    snapshot: { clients: [
      { id: 'client-uuid-jane-1', full_name: 'Jane Smith' },
      { id: 'client-uuid-jane-2', full_name: 'Jane Smith' },
    ], portfolios: [], positions: [] },
    actions: [{
      op: 'updateClient', ref: 'a1', target: { clientId: 'client-uuid-jane-1' },
      fields: { full_name: 'Jane Smith', _candidates: 'client-uuid-jane-1,client-uuid-jane-2' },
      confidence: 0.4, source: '', reasoning: '', valid: true, problems: [],
    }],
    errors: [],
  };
  const { fetchImpl } = queueJson(parseResponse);
  const { el, context } = makeSandbox({ fetchImpl });

  el('agentText').value = "set Jane's risk profile to aggressive";
  el('agentClarify').hidden = true;
  await context.window.agentSend();
  assert.equal(el('agentRows')._boxes[0].checked, false);

  // The manager picks the second Jane, then manually ticks the row —
  // agentPick's own logic (unchanged) updates row.target/row.valid; the
  // checkbox tick is the manager's separate approve gesture, same as any
  // other row.
  context.window.agentPick({ dataset: { row: '0', target: 'clientId' }, value: 'client-uuid-jane-2' });
  el('agentRows')._boxes[0].checked = true;

  const executeResponse = { results: [{ ref: 'a1', op: 'updateClient', ok: true, data: {} }] };
  const exec = queueJson(executeResponse);
  context.fetch = exec.fetchImpl;
  await context.window.agentExecute();

  const sent = JSON.parse(exec.calls[0].opts.body);
  assert.equal(sent.rows[0].target.clientId, 'client-uuid-jane-2', 'the picked candidate must be what is sent, not the model\'s arbitrary default');
});

test('the mic stream is released when recording stops normally, and again on pagehide', async () => {
  const { context, micTracks, windowListeners } = makeSandbox();

  await context.window.agentMic();
  assert.equal(micTracks.length, 1);
  assert.equal(micTracks[0].stopped, false);
  await context.window.agentMic(); // stop
  await flush();
  assert.equal(micTracks[0].stopped, true, 'the stream must be released when recording ends normally');

  // A second, still-live recording must also be released if the manager
  // navigates away mid-recording.
  await context.window.agentMic();
  assert.equal(micTracks[1].stopped, false);
  assert.equal(typeof windowListeners.pagehide, 'function', 'agent.js must register a pagehide listener to release the mic');
  windowListeners.pagehide();
  assert.equal(micTracks[1].stopped, true, 'navigating away mid-recording must not leave the mic stream open');
});
