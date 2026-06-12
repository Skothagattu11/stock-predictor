# Phase 7: UI — Predictions Section (horizon cards + multi-predictor consensus) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Frontend is vanilla JS with no DOM test harness, so verification is by `node --check` (syntax) + serving the page and a render screenshot, not unit tests. Commit per task.

**Goal:** Surface everything the backend now produces. Add a **Predictions** section to the dashboard: a horizon ribbon, a **Market view** (Intraday + Outlook insight cards, each with the multi-model consensus + per-model rows) and a **Your view** (Position + Portfolio cards), every card carrying the honesty primitives (HorizonBadge, ConfidenceMeter, FreshnessTag, AIBadge, SignalChip, DriverPills). Outlook shows a bull/base/bear fan.

**Architecture:** A self-contained `public/predictions.js` (IIFE exposing `window.Predictions.load(symbol, ctx)`) does all fetching (`/api/insight/*`, `/api/predict/position`, `/api/predict/portfolio`) and rendering. `index.html` gains the section markup + styles (reusing existing CSS variables). `app.js` gets ONE hook: call `Predictions.load` on symbol change/connect. No backend changes, no new deps.

**Tech Stack:** Vanilla ES5-ish browser JS (match existing `app.js` style — `var`, function declarations), existing dark theme.

**Builds on:** Phases 4–5 (`/api/predict/*`, `/api/insight/*`). Endpoints 503 gracefully → cards show a friendly "unavailable" state.

---

## File structure

```
public/
  predictions.js     # NEW: fetch + render the predictions section
  index.html         # MODIFY: add the Predictions section markup, styles, <script>
  app.js             # MODIFY: one hook to call Predictions.load on symbol change
```

---

## Task 1: `public/predictions.js`

**Files:** Create `public/predictions.js`

> **Implementer:** first open `public/index.html` and note the CSS custom properties used in its `<style>` (colors like `--bg`, `--panel`, `--ink`, accent vars, etc.). The classes added in Task 2 must reuse those variables so the section matches the theme. This task's JS only manipulates DOM/classes — it does not hardcode colors.

- [ ] **Step 1: Create `public/predictions.js`**

```js
/* Predictions section: multi-horizon, multi-model. Self-contained.
   Exposes window.Predictions.load(symbol, ctx) where ctx may include
   { position: {cost_basis, shares, portfolio_value}, holdings: [{symbol,value}] }. */
(function () {
  'use strict';

  function el(id) { return document.getElementById(id); }
  function h(html) { var d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function pct(x) { return (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%'; }
  function money(x) { return '$' + Number(x).toFixed(2); }

  async function getJSON(url) {
    var r = await fetch(url);
    if (!r.ok) { var e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
    return r.json();
  }

  // ---- honesty primitives (return HTML strings) ----------------------------
  var STANCE_META = {
    bullish: { label: 'BULLISH', icon: '▲', cls: 'st-bull' },
    bearish: { label: 'BEARISH', icon: '▼', cls: 'st-bear' },
    neutral: { label: 'NEUTRAL', icon: '▬', cls: 'st-neu' },
  };
  var ACTION_META = {
    HOLD: { icon: '▬', cls: 'st-neu' }, ADD: { icon: '▲', cls: 'st-bull' },
    TRIM: { icon: '▼', cls: 'st-warn' }, EXIT: { icon: '✖', cls: 'st-bear' },
  };
  function signalChip(label, icon, cls, lowConf) {
    return '<span class="pchip ' + cls + (lowConf ? ' pchip-dim' : '') + '">' +
      '<span class="pchip-ic">' + icon + '</span>' + esc(label) + '</span>';
  }
  function band(conf) { return conf >= 0.66 ? 'High' : conf >= 0.33 ? 'Moderate' : 'Low'; }
  function confidenceMeter(conf) {
    var b = band(conf);
    return '<span class="pconf pconf-' + b.toLowerCase() + '">' + b +
      ' · ' + Math.round(conf * 100) + '%</span>';
  }
  function freshnessTag(asOf) {
    var t = asOf ? new Date(asOf) : null;
    var label = t && !isNaN(t) ? t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
    return '<span class="pfresh">as of ' + esc(label) + '</span>';
  }
  function aiBadge(sources) {
    var n = (sources || []).length;
    return '<span class="pai" title="AI estimate — not investment advice">AI estimate · not advice' +
      (n ? ' · ' + n + ' src' : '') + '</span>';
  }
  function driverPills(drivers) {
    if (!drivers || !drivers.length) return '';
    return '<div class="pdrivers">' + drivers.slice(0, 4).map(function (d) {
      var a = d.direction === 'up' ? '▲' : d.direction === 'down' ? '▼' : '▬';
      return '<span class="pdriver ' + (d.direction === 'up' ? 'd-up' : d.direction === 'down' ? 'd-dn' : '') +
        '">' + esc(d.name) + ' ' + a + '</span>';
    }).join('') + '</div>';
  }
  function consensusRows(consensus) {
    if (!consensus || !consensus.votes) return '';
    var rows = consensus.votes.map(function (v) {
      var m = STANCE_META[v.stance] || STANCE_META.neutral;
      return '<div class="prow"><span class="prow-name">' + esc(v.name) + '</span>' +
        '<span class="prow-stance ' + m.cls + '">' + m.icon + ' ' + m.label + '</span>' +
        '<span class="prow-conf">' + Math.round((v.confidence || 0) * 100) + '%</span></div>';
    }).join('');
    var div = consensus.divergence
      ? '<span class="pdiverge">models split · low conviction</span>' : '';
    return '<div class="pconsensus"><div class="pconsensus-h">Predictors · ' +
      Math.round(consensus.agreement * 100) + '% agree ' + div + '</div>' + rows + '</div>';
  }

  // ---- card renderers ------------------------------------------------------
  function insightCard(node, data, horizon) {
    var c = data.consensus || { stance: 'neutral', agreement: 0, divergence: true, votes: [] };
    var m = STANCE_META[c.stance] || STANCE_META.neutral;
    var conf = c.agreement || 0;
    var html =
      '<div class="pcard-head"><span class="phbadge">' + esc(horizon) + '</span>' + freshnessTag(data.quant && data.quant.as_of) + '</div>' +
      '<div class="pcard-sig">' + signalChip(m.label, m.icon, m.cls, conf < 0.33) + confidenceMeter(conf) + '</div>' +
      driverPills(data.quant && data.quant.drivers) +
      (horizon.indexOf('Week') > -1 ? scenarioFan(data.quant) : '') +
      consensusRows(c) +
      '<div class="pcard-foot">' + aiBadge(collectSources(data.models)) + '</div>';
    node.innerHTML = html;
  }
  function collectSources(models) {
    var s = []; (models || []).forEach(function (m) { (m.sources || []).forEach(function (x) { if (s.indexOf(x) < 0) s.push(x); }); });
    return s;
  }
  function scenarioFan(quant) {
    if (!quant || !quant.scenarios) return '';
    var byCase = {}; quant.scenarios.forEach(function (s) { byCase[s.case] = s; });
    function row(label, s, cls) {
      if (!s) return '';
      return '<div class="pscn ' + cls + '"><span>' + label + '</span>' +
        '<span>' + money(s.target_price) + '</span><span>' + pct(s.target_return_pct) +
        '</span><span>' + Math.round(s.probability * 100) + '%</span></div>';
    }
    return '<div class="pfan">' + row('Bull', byCase.bull, 'pscn-bull') +
      row('Base', byCase.base, 'pscn-base') + row('Bear', byCase.bear, 'pscn-bear') + '</div>';
  }
  function positionCard(node, data) {
    var m = ACTION_META[data.action] || ACTION_META.HOLD;
    node.innerHTML =
      '<div class="pcard-head"><span class="phbadge">Your position</span>' + freshnessTag(data.as_of) + '</div>' +
      '<div class="pcard-sig">' + signalChip(data.action, m.icon, m.cls, false) +
      '<span class="ppnl ' + (data.unrealized_pnl_pct >= 0 ? 'd-up' : 'd-dn') + '">' + pct(data.unrealized_pnl_pct) +
      ' (' + money(data.unrealized_pnl_abs) + ')</span></div>' +
      driverPills(data.drivers) +
      '<div class="pcard-foot">' + aiBadge([]) + '</div>';
  }
  function portfolioCard(node, data) {
    var flags = (data.flags || []).map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('');
    node.innerHTML =
      '<div class="pcard-head"><span class="phbadge">Across holdings</span>' + freshnessTag(data.as_of) + '</div>' +
      '<div class="pcard-sig"><span class="pchip ' + ((data.flags || []).length ? 'st-warn' : 'st-neu') + '">' +
      ((data.flags || []).length ? '⚠ REVIEW' : '✓ BALANCED') + '</span>' +
      '<span class="pconf">HHI ' + (data.concentration_hhi != null ? data.concentration_hhi.toFixed(2) : '—') + '</span></div>' +
      (flags ? '<ul class="pflags">' + flags + '</ul>' : '<div class="pmuted">No concentration/correlation issues.</div>') +
      '<div class="pcard-foot">' + aiBadge([]) + '</div>';
  }
  function errorCard(node, horizon, e) {
    var msg = e && e.status === 503 ? 'Live model unavailable (keys/sidecar not configured).' :
      'Could not load (' + (e && e.message || 'error') + ').';
    node.innerHTML = '<div class="pcard-head"><span class="phbadge">' + esc(horizon) + '</span></div>' +
      '<div class="pmuted">' + esc(msg) + '</div>';
  }
  function loadingCard(node, horizon) {
    node.innerHTML = '<div class="pcard-head"><span class="phbadge">' + esc(horizon) + '</span></div>' +
      '<div class="pmuted">Analyzing…</div>';
  }

  // ---- orchestration -------------------------------------------------------
  async function load(symbol, ctx) {
    ctx = ctx || {};
    var cards = { intraday: el('predIntraday'), outlook: el('predOutlook'),
                  position: el('predPosition'), portfolio: el('predPortfolio') };
    if (!cards.intraday) return;   // section not present

    loadingCard(cards.intraday, 'Today'); loadingCard(cards.outlook, 'Weeks–Months');

    getJSON('/api/insight/intraday/' + encodeURIComponent(symbol))
      .then(function (d) { insightCard(cards.intraday, d, 'Today'); })
      .catch(function (e) { errorCard(cards.intraday, 'Today', e); });

    getJSON('/api/insight/outlook/' + encodeURIComponent(symbol))
      .then(function (d) { insightCard(cards.outlook, d, 'Weeks–Months'); })
      .catch(function (e) { errorCard(cards.outlook, 'Weeks–Months', e); });

    var pos = ctx.position;
    if (pos && pos.cost_basis && cards.position) {
      var q = new URLSearchParams({ current_price: pos.current_price || pos.cost_basis,
        cost_basis: pos.cost_basis });
      if (pos.shares) q.set('shares', pos.shares);
      if (pos.portfolio_value) q.set('portfolio_value', pos.portfolio_value);
      getJSON('/api/predict/position/' + encodeURIComponent(symbol) + '?' + q.toString())
        .then(function (d) { positionCard(cards.position, d); })
        .catch(function (e) { errorCard(cards.position, 'Your position', e); });
    } else if (cards.position) {
      cards.position.innerHTML = '<div class="pcard-head"><span class="phbadge">Your position</span></div>' +
        '<div class="pmuted">Save a position to get a personalized call.</div>';
    }

    var holdings = ctx.holdings || [];
    if (holdings.length && cards.portfolio) {
      fetch('/api/predict/portfolio', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ holdings: holdings }) })
        .then(function (r) { if (!r.ok) { var e = new Error('HTTP ' + r.status); e.status = r.status; throw e; } return r.json(); })
        .then(function (d) { portfolioCard(cards.portfolio, d); })
        .catch(function (e) { errorCard(cards.portfolio, 'Across holdings', e); });
    } else if (cards.portfolio) {
      cards.portfolio.innerHTML = '<div class="pcard-head"><span class="phbadge">Across holdings</span></div>' +
        '<div class="pmuted">Add holdings to see portfolio fit.</div>';
    }
  }

  window.Predictions = { load: load };
})();
```

- [ ] **Step 2: Syntax check**

Run: `node --check public/predictions.js`
Expected: no output (valid).

- [ ] **Step 3: Commit**
```
git checkout -b feat/phase-7-ui
git add public/predictions.js
git commit -m "feat(ui): add predictions module (cards, consensus, honesty primitives)"
```

---

## Task 2: Predictions section markup + styles in `index.html`

**Files:** Modify `public/index.html`

- [ ] **Step 1: Add the section markup.** Insert this block in the dashboard where it reads well (the implementer chooses a sensible spot — e.g., directly under the chart/hero row, above the existing bento/portfolio area). Keep IDs exactly as written (predictions.js depends on them):

```html
<section class="predictions" id="predictions">
  <div class="pribbon">
    <span class="pribbon-step">Today</span><span class="pribbon-sep">—</span>
    <span class="pribbon-step">Days</span><span class="pribbon-sep">—</span>
    <span class="pribbon-step">Weeks–Months</span><span class="pribbon-sep">—</span>
    <span class="pribbon-step">Position</span><span class="pribbon-sep">—</span>
    <span class="pribbon-step">Portfolio</span>
  </div>
  <div class="pscope">Market view</div>
  <div class="pgrid">
    <div class="pcard" id="predIntraday"></div>
    <div class="pcard" id="predOutlook"></div>
  </div>
  <div class="pscope">Your view</div>
  <div class="pgrid">
    <div class="pcard" id="predPosition"></div>
    <div class="pcard" id="predPortfolio"></div>
  </div>
</section>
```

- [ ] **Step 2: Add styles** to the existing `<style>` block, reusing the file's existing CSS variables (match the names actually defined in this file — e.g., panel/border/ink/muted colors). Use accessible stance colors (green/red PLUS icon+label already in markup; amber for warn, blue-grey for neutral) and a banded confidence look. Reference styling:

```css
.predictions { margin: 18px 0; }
.pribbon { display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:12px;
  color: var(--muted, #8a97b1); margin-bottom:10px; }
.pribbon-step { padding:2px 8px; border:1px solid var(--border,#243049); border-radius:999px; }
.pscope { font-size:11px; text-transform:uppercase; letter-spacing:.6px;
  color: var(--muted,#8a97b1); margin:10px 0 8px; }
.pgrid { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
@media (max-width:760px){ .pgrid { grid-template-columns:1fr; } }
.pcard { background: var(--panel,#121826); border:1px solid var(--border,#243049);
  border-radius:14px; padding:14px; min-width:0; }
.pcard-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; }
.phbadge { font-size:11px; padding:2px 9px; border-radius:999px;
  background: var(--chip,#1a2236); color: var(--muted,#8a97b1); }
.pfresh { font-size:11px; color: var(--muted,#5f6c86); }
.pcard-sig { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:10px; }
.pchip { display:inline-flex; align-items:center; gap:6px; font-weight:700; font-size:13px;
  padding:4px 10px; border-radius:8px; }
.pchip-ic { font-size:12px; }
.pchip-dim { opacity:.55; }
.st-bull { background:#10241b; color:#39d98a; border:1px solid #1f5a3f; }
.st-bear { background:#2a1414; color:#ff6b6b; border:1px solid #5a2a2a; }
.st-neu  { background:#16203a; color:#8aa0c6; border:1px solid #28365a; }
.st-warn { background:#241d10; color:#ffb454; border:1px solid #6b4f1f; }
.pconf { font-size:12px; padding:2px 8px; border-radius:999px; border:1px solid var(--border,#243049);
  color: var(--muted,#8a97b1); }
.pconf-high { color:#39d98a; } .pconf-moderate { color:#ffb454; } .pconf-low { color:#8aa0c6; }
.pdrivers { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:10px; }
.pdriver { font-size:11px; padding:2px 8px; border-radius:999px; background: var(--chip,#1a2236);
  border:1px solid var(--border,#243049); color: var(--muted,#8a97b1); }
.d-up { color:#39d98a; } .d-dn { color:#ff6b6b; }
.pfan { display:flex; flex-direction:column; gap:4px; margin-bottom:10px; }
.pscn { display:grid; grid-template-columns:48px 1fr 1fr 44px; gap:6px; font-size:12px;
  padding:3px 6px; border-radius:6px; }
.pscn-bull { background:#10241b; } .pscn-base { background:#16203a; } .pscn-bear { background:#2a1414; }
.pconsensus { border-top:1px solid var(--border,#243049); padding-top:8px; margin-top:4px; }
.pconsensus-h { font-size:11px; text-transform:uppercase; letter-spacing:.5px;
  color: var(--muted,#5f6c86); margin-bottom:6px; }
.pdiverge { color:#ffb454; text-transform:none; letter-spacing:0; margin-left:6px; }
.prow { display:grid; grid-template-columns:1fr auto 44px; gap:8px; font-size:12px; padding:2px 0; }
.prow-name { color: var(--ink,#e7ecf5); text-transform:capitalize; }
.prow-stance { font-weight:600; } .prow-conf { color: var(--muted,#8a97b1); text-align:right; }
.pcard-foot { margin-top:8px; }
.pai { font-size:10px; color: var(--muted,#5f6c86); border:1px solid var(--border,#243049);
  border-radius:999px; padding:1px 7px; }
.ppnl { font-size:13px; font-weight:600; }
.pflags { margin:0; padding-left:18px; font-size:12px; color:#ffb454; }
.pmuted { color: var(--muted,#8a97b1); font-size:13px; }
```

- [ ] **Step 3: Include the script** before the closing `</body>` (after `app.js` is fine):
```html
<script src="predictions.js"></script>
```

- [ ] **Step 4: Commit**
```
git add public/index.html
git commit -m "feat(ui): add predictions section markup + themed styles"
```

---

## Task 3: Hook `app.js` to refresh predictions on symbol change

**Files:** Modify `public/app.js`

- [ ] **Step 1:** Find where the active symbol becomes known/changes — on initial connect and whenever the user switches symbol (search for where `state.symbol` is set after a `subscribe`/`snapshot`, e.g. near the `subscribe` send or the snapshot handler). Add a single call (guarded so it never breaks if the module/endpoints are absent):

```js
function refreshPredictions() {
  if (!window.Predictions) return;
  var pos = (typeof getPosition === 'function') ? getPosition(state.symbol) : null;
  var ctx = {};
  if (pos && (pos.avgCost || pos.costBasis)) {
    ctx.position = {
      cost_basis: pos.avgCost || pos.costBasis,
      current_price: state.livePrice || priceMap[state.symbol] || (pos.avgCost || pos.costBasis),
      shares: pos.shares, portfolio_value: pos.portfolioValue,
    };
  }
  try { window.Predictions.load(state.symbol, ctx); } catch (e) { /* non-fatal */ }
}
```

- [ ] **Step 2:** Call `refreshPredictions()` (a) once after the first snapshot renders and (b) whenever the symbol changes. Place the call next to the existing `fetchNews(state.symbol)` call(s) — that already fires on connect and symbol change, so co-locating keeps the refresh in sync:
```js
fetchNews(state.symbol);
refreshPredictions();
```
> **Implementer note:** adapt the property names in `refreshPredictions` (`avgCost`/`costBasis`/`shares`/`portfolioValue`) to whatever `getPosition()` actually returns — open `app.js`, read the position object shape, and map accordingly. The call must be additive and never throw.

- [ ] **Step 3: Syntax check + full backend suite still green**
```
node --check public/app.js
node --test
```
Expected: app.js valid; all backend tests still pass (no backend changes).

- [ ] **Step 4: Commit**
```
git add public/app.js
git commit -m "feat(ui): refresh predictions on symbol change"
```

---

## Task 4: Manual render verification

- [ ] **Step 1:** Start the server (`npm start`) and open `http://localhost:<PORT>/`. Confirm:
  - The Predictions section renders with the horizon ribbon and Market/Your split.
  - With no sidecar/keys configured, the Intraday/Outlook cards show the friendly "Live model unavailable" state (503) rather than breaking — and the rest of the dashboard (chart, KPIs, news, chatbot) is unaffected.
  - No console errors from `predictions.js`.
- [ ] **Step 2:** (If the sidecar is running locally with `QUANT_SIDECAR_URL` set) confirm the cards populate with stance/confidence/drivers and the consensus rows show the quant voice (+ any LLM voices when keys are set).

---

## Acceptance criteria
- [ ] `node --check public/predictions.js` and `node --check public/app.js` pass; `node --test` still green.
- [ ] Predictions section renders: horizon ribbon, Market view (Intraday/Outlook) + Your view (Position/Portfolio).
- [ ] Each card shows HorizonBadge + SignalChip (icon+label+color, dimmed when low confidence) + ConfidenceMeter (banded) + FreshnessTag + AIBadge; drivers as pills; outlook shows bull/base/bear fan; consensus rows list each predictor voice with a divergence flag when split.
- [ ] 503/empty states are friendly; the existing dashboard is untouched and still works.
- [ ] Theme matches (reuses existing CSS variables); responsive (1-col on narrow screens).
- [ ] `.env` never staged. Branch `feat/phase-7-ui` ready to merge.

## Self-review notes
- **Spec coverage:** implements spec §"UI redesign" — horizon ribbon, Market/Your split, four cards, the four honesty primitives, SignalChip with non-color cues (WCAG), DriverPills, outlook fan, and the multi-predictor/consensus panel made visible.
- **Additive & low-risk:** new self-contained module + section + one guarded hook; no backend change, no new deps, existing chart/news/chatbot untouched. Endpoints failing → friendly states, never a broken page.
- **Accessibility:** every stance uses icon + label + color (not color alone); confidence is banded text, not a bare needle; amber/blue used for warn/neutral so states don't rely on red-vs-green.
- **Consistency:** IDs (`predIntraday/predOutlook/predPosition/predPortfolio`) are the contract between `index.html` and `predictions.js`; `Predictions.load(symbol, ctx)` is the single entry point `app.js` calls.

## Follow-ups (later phases)
- Wire reconciliation flags + per-model rationale tooltips into the cards (Phase 5 produced the data).
- Phase 8 calibration stats can render a small "track record" line under ConfidenceMeter.
