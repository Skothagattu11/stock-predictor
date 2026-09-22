# Manager Agent Entry — Design Spec

**Date:** 2026-09-22
**Project:** candle-signal-dashboard (Wealth Manager portal)
**Author:** Suryateja Kothagattu
**Status:** Approved — ready for implementation

---

## 1. Overview

Add an agentic entry layer to the Wealth Manager portal so a manager can maintain the
book by **describing** a change instead of filling in forms. The manager types, drops an
image (a broker screenshot, a statement photo), or speaks; an LLM turns that into a list
of **proposed actions**; the manager reviews and edits that list; approved rows execute
against the existing manager data model.

The agent never writes. It produces a proposal. A separate executor — running the same
ownership checks and history writes as manual entry — is the only thing that touches data.

**Scope:** full CRUD over clients, portfolios, and positions.
**Input modes:** text, image, voice (all three handled natively by one multimodal call).
**Deployment:** same Express app, same Supabase project.

---

## 2. Use Cases

### UC-1: Screenshot a brokerage holdings page
Manager selects client "Jane Smith" → "Growth Portfolio", drops a screenshot showing six
holdings. Agent proposes six `addPosition` actions with symbol, shares, and avg cost
filled in. Manager corrects one misread cost basis, drops a row for a position already
tracked, approves the rest. Four rows execute; the drawer reports 4 added.

### UC-2: Voice note after a client call
Manager taps the mic: *"Sold all of Jane's NVDA at one ninety, and bump her risk profile
to aggressive."* The recording goes straight to the model; it proposes a `sellPosition`
(price 190) and an `updateClient` (`risk_profile: aggressive`), and shows the transcript
of what it heard. Manager confirms both.

### UC-3: Onboard a new client from a text paste
Manager pastes an intro email. Agent proposes `createClient` (name, email, phone, goal)
and a `createPortfolio` seeded from the strategy mentioned. Manager edits the portfolio
name, approves.

### UC-4: Ambiguous reference
Manager types *"add 10 NVDA at 182"* with no client selected. Agent returns no actions
and a clarification: *"Which client?"* Manager answers "Jane"; two Janes exist, so the
agent emits the action at low confidence with a candidate dropdown on the row.

---

## 3. Non-Goals (v1)

- Conversational queries over the book ("which clients hold NVDA?"). The endpoint shape
  supports adding this later; it is not built now.
- Autonomous execution. Every write passes a human confirm step. No exceptions, no
  "trusted" action types.
- Bulk file import (CSV, PDF statements). Images and text only.
- Editing share tokens, alerts, or anything outside clients/portfolios/positions.
- Undo. Rows are reviewed before execution; reversal is manual, as it is today.

---

## 4. Architecture

```
public/manager.html   composer bar (text · paperclip · mic) + proposal drawer
public/agent.js       capture input, render/edit proposal rows, POST approvals
                          │
src/agent-routes.js   POST /api/manager/agent/parse     (multipart: text, image, audio)
                      POST /api/manager/agent/execute   (proposalId + approved rows)
                          │
src/agent-service.js  snapshot → LLM → validate → resolve → persist proposal
src/agent-schema.js   Zod ActionPlan — the contract
src/manager-actions.js  the 8 write operations, shared by routes and executor
```

### 4.1 Refactor: `src/manager-actions.js`

The write logic currently lives inline in `manager-routes.js`. Extract each operation to
a plain function:

```js
async function addPosition(sb, managerId, input) -> { ok, data } | { ok: false, error }
```

Each function owns its ownership check (`manager_id = managerId`) and its
`position_history` write. `manager-routes.js` becomes thin HTTP wrappers; the executor
calls the same functions. One definition of "add a position", two callers.

This also removes the standing hazard in the current code: ownership is enforced by a
`.eq('manager_id', req.user.id)` filter repeated in every handler, which any new route
can forget. Moving the filter inside the action makes it structural.

**Operations:** `createClient`, `updateClient`, `deleteClient`, `createPortfolio`,
`addPosition`, `updatePosition`, `sellPosition`, `deletePosition`.

`deletePortfolio` is intentionally excluded from the agent surface — a whole portfolio is
too destructive to originate from a misread image. It stays manual.

### 4.2 Parse flow

1. **`POST /api/manager/agent/parse`** (behind `requireAuth`). Multipart body: `text`,
   `image`, `audio`, plus `context` (`selectedClientId`, `selectedPortfolioId`).
2. `text`, `image`, and `audio` are assembled into a **single multimodal message**. Gemini
   accepts audio inline, so there is no separate transcription step and no second vendor
   call — the model hears the note and emits the plan in one request. The audio's
   transcript is requested as part of the plan (`ActionPlan.transcript`) purely so the
   manager can see what was heard.
3. **`buildSnapshot(managerId)`** — one Supabase query returning client ids + names +
   risk profile, portfolio ids + names, position ids + symbols. **Names and ids only; no
   dollar amounts, no share counts.** A 50-client book is roughly 4 KB.
4. **`generateObject({ model, schema: ActionPlanSchema, prompt, images })`** via the
   existing `src/llm/adapters/` layer.
5. **Code validates** — see §6. The model's output is a proposal, not a command.
6. Persist to `agent_proposals` with status `pending`; return the plan to the browser.

### 4.3 Execute flow

1. **`POST /api/manager/agent/execute`** with `proposalId` and the approved rows.
2. Every row is **re-validated server-side against the snapshot**. The browser's edits are
   untrusted input, not a pass-through. A row whose `clientId` is not owned by the caller
   is rejected regardless of what the stored proposal said.
3. Rows dispatch to `manager-actions.js` **sequentially** — an `addPosition` may depend on
   a `createPortfolio` earlier in the same plan, which depends on a `createClient`. Ids
   created mid-plan are threaded to later rows by their `ref` field (§5).
4. Each row returns `ok` or an error. Partial success is expected and correct: failed rows
   stay in the drawer, editable and re-approvable.
5. Proposal marked `executed` with the per-row outcome stored.
6. Writes land in `position_history` exactly as manual entry does, with `source: 'agent'`
   and the proposal id, so the audit trail distinguishes agent-originated entries.

### 4.4 Provider — Gemini 2.5 Flash

Primary: **Gemini 2.5 Flash** via `src/llm/adapters/google.js`. Already the configured
default (`src/config.js:8`, `GEMINI_MODEL`), key already provisioned, adapter already
registered in `src/llm/adapters/index.js`. Chosen for cost: it is the cheapest model in
the repo's stack that handles all three of image input, audio input, and schema-
constrained structured output — the exact three things this feature needs.

Fallback: Claude via the existing router order, used only when Gemini errors.

**Cost controls, in order of impact:**

1. **No Whisper.** Gemini ingests audio directly, removing a per-minute transcription
   charge and a round-trip from every voice entry.
2. **Downscale images client-side** before upload — longest edge 1568 px, JPEG q80, in a
   canvas in `agent.js`. A phone screenshot drops from ~3 MB to ~200 KB with no loss of
   legibility for tickers and prices. This is the single largest token line item.
3. **Snapshot is ids + names only** (§4.2) — no dollars, no share counts. ~4 KB for a
   50-client book.
4. **One call per parse.** No agent loop, no tool round-trips — the reason approach A was
   chosen over a tool-calling agent.
5. **No re-parse on edit.** Row edits are local; only `execute` goes back to the server,
   and it calls no model at all.
6. **`GEMINI_MODEL` is an env knob.** Dropping to `gemini-2.5-flash-lite` for cheaper
   text-only parses is a config change, zero code. Keep Flash for images — screenshot
   OCR is where accuracy pays for itself.

**Adapter change required:** `createGoogleAdapter().generate(prompt, schema)` takes a
string prompt only. It needs to accept an array of content parts (text / image / audio)
so multimodal input reaches `generateObject`. Additive change, signature stays
backward-compatible: `generate(promptOrParts, schema)`.

**Future option — Jev (typesafe.ai) for entity resolution.** Jev is a "System One" model:
typed structured decisions, 70–500 ms, bounded cardinality ≤ 255, free output tokens. It
cannot take images and cannot generate strings, so it is unsuitable for the parser. It
maps cleanly onto the `resolveEntity()` step ("given this utterance and these N client
names, which id?"), which the design isolates for exactly this reason. Not a v1
dependency; revisit once it leaves early access.

---

## 5. The Contract — `src/agent-schema.js`

```js
const Op = z.enum([
  'createClient', 'updateClient', 'deleteClient',
  'createPortfolio',
  'addPosition', 'updatePosition', 'sellPosition', 'deletePosition',
]);

const Action = z.object({
  op: Op,
  ref: z.string(),                       // plan-local id, e.g. "a1"
  dependsOn: z.string().nullable(),      // another action's ref, for create-then-fill
  target: z.object({
    clientId: z.string().nullable(),
    portfolioId: z.string().nullable(),
    positionId: z.string().nullable(),
  }),
  fields: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
  confidence: z.number().min(0).max(1),
  source: z.string(),                    // the snippet / image region this came from
  reasoning: z.string(),
});

const ActionPlan = z.object({
  actions: z.array(Action),
  clarification: z.string().nullable(),
  summary: z.string(),
  transcript: z.string().nullable(),   // what the model heard, when audio was sent
});
```

`op` is a closed enum: an operation outside the list is structurally impossible, not
merely discouraged. `fields` is validated per-`op` by a second pass in code (§6) rather
than by a union schema, so a malformed field fails with a message the retry can act on.

`ref` / `dependsOn` express in-plan ordering: `createClient` (ref `a1`) →
`createPortfolio` (`dependsOn: "a1"`) → `addPosition` (`dependsOn: "a2"`). The executor
resolves each created id into its dependents before dispatching them.

---

## 6. Validation

Applied in `agent-service.js` after the LLM call, and again in the executor:

| Check | Rule |
|---|---|
| Entity existence | Every non-null `clientId` / `portfolioId` / `positionId` must appear in the caller's snapshot. The model cannot invent an id. |
| Ownership | Re-verified at execute time against the DB, not the snapshot. |
| Ticker | Resolved through the existing `/api/search`. Unresolvable symbol → row flagged, not executed. |
| Numbers | Coerced; `entry_price > 0`, `shares >= 0`, `sell_price > 0`. Non-finite rejected. |
| Required fields | Per-`op`: `createClient` needs `full_name`; `addPosition` needs `symbol` + `entry_price`; `sellPosition` needs `sell_price`. |
| Dependencies | `dependsOn` must reference a `ref` present in the same plan; cycles rejected. |
| Plan size | Max 25 actions per proposal. |

Anything failing validation is returned to the drawer as a flagged row with the reason,
never silently dropped.

---

## 7. Ambiguity

The model does not guess identities.

- **Resolvable but uncertain** — "Jane" matches two clients. The action is emitted with
  `confidence < 0.6` and the candidate ids in `fields._candidates`. The row renders amber
  with a dropdown of the real candidates; approval is blocked until one is picked.
- **Not resolvable** — no client named, none selected. `actions: []` and a `clarification`
  string. The composer shows the question inline; the manager's answer is appended to the
  original input and resent, image included, so nothing is re-uploaded or retyped.

---

## 8. Confirmation UI

The proposal drawer opens above the composer. One row per action:

- Operation verb and target entity in plain language ("Add position to Jane Smith ·
  Growth Portfolio")
- Field-by-field values, each **editable inline**
- Confidence indicator: green ≥ 0.8, amber 0.6–0.8, red < 0.6 or flagged
- `source` shown on the row — the text snippet or image region it was read from
- Per-row checkbox, plus "approve all" / "reject all"

Execute runs only checked rows. The result replaces the drawer with a per-row outcome
list; failed rows remain editable and can be re-approved without re-parsing.

Composer sits at the bottom of `manager.html`, always visible, context-aware: a selected
client and portfolio are passed as `context` so "add 10 NVDA at 182" needs no names.

---

## 9. Data Model

One new table:

```sql
CREATE TABLE IF NOT EXISTS agent_proposals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  input_text   text,
  input_kind   text NOT NULL,          -- 'text' | 'image' | 'voice' | 'mixed'
  transcript   text,                   -- what the model heard, when voice
  plan         jsonb NOT NULL,         -- the validated ActionPlan
  status       text NOT NULL DEFAULT 'pending',  -- pending | executed | discarded
  results      jsonb,                  -- per-row outcome after execute
  created_at   timestamptz NOT NULL DEFAULT now(),
  executed_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_agent_proposals_manager ON agent_proposals(manager_id);
ALTER TABLE agent_proposals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "proposals_own" ON agent_proposals
  FOR ALL USING (manager_id = auth.uid()) WITH CHECK (manager_id = auth.uid());
```

Images are **not** persisted — they are held in memory for the parse call and discarded.
The extracted `plan` and `input_text` are the record.

`position_history` gains two nullable columns: `source text` (default `'manual'`) and
`proposal_id uuid`.

---

## 10. Error Handling

| Failure | Behaviour |
|---|---|
| Gemini rejects the audio (format/length) | Composer reports it, keeps the recording, offers text entry. Nothing retyped. |
| LLM call fails | Falls through the router to Claude; if all fail, a plain message and the input is preserved. |
| Schema validation fails | One retry with the validator's complaint appended to the prompt — the pattern in `src/llm/reconcile.js`. Then surface failure. |
| Row fails at execute | Per-row error in the outcome list; other rows unaffected. Failed rows stay editable. |
| Empty plan, no clarification | Treated as "nothing actionable found" with the input shown back, not as an error. |

---

## 11. Testing

`agent-service` is dependency-injected like `analyst-service`, so unit tests run offline
with a stubbed adapter.

**Unit — parse:**
- Fixture broker-screenshot text → expected multi-row `ActionPlan`
- "sold all my NVDA at 190" with client context → single `sellPosition`
- New-client intro paste → `createClient` + `createPortfolio` with correct `dependsOn`
- Ambiguous name → low confidence + `_candidates`
- No client resolvable → `actions: []` + `clarification`

**Unit — validation (the ones that matter):**
- Invented `clientId` not in snapshot → rejected
- `entry_price: "abc"` → rejected
- `op: "dropTable"` → schema rejection
- `dependsOn` cycle → rejected
- Plan of 30 actions → rejected

**Unit — executor:**
- Edited row pointing at another manager's portfolio → rejected at execute despite a
  valid stored proposal
- Mid-plan `createClient` failure → dependents skipped, independent rows still run
- Every executed row writes `position_history` with `source: 'agent'`

**E2E (Playwright, `tests/e2e/agent.spec.js`):** compose text → drawer renders → edit a
field → uncheck a row → execute → outcome list → the position appears in the portfolio
table.

---

## 12. Build Sequence

1. **`manager-actions.js` extraction** + existing tests still green. No behaviour change.
2. **`agent-schema.js`** + validation pass, with unit tests. No LLM yet.
3. **`agent-service.js`** parse path (text only) against a stubbed adapter.
   Extend `google.js` to accept content parts (§4.4) when step 6 lands.
4. **`agent-routes.js`** + `agent_proposals` migration; wire the real adapter.
5. **Composer + drawer** in `manager.html` / `agent.js`, text only, end to end.
6. **Image input** — multimodal message, screenshot fixtures.
7. **Voice** — `MediaRecorder` in the browser, audio part appended to the same
   multimodal call. No transcription service.
8. **E2E spec** + `WEALTH_MANAGER_GUIDE.md` section.

Steps 1–5 are a shippable increment: typed entry with confirm-then-execute. Image and
voice extend the same pipeline without touching the executor or the UI contract.

---

## 13. Open Risks

- **Image misreads on cost basis.** A wrong decimal in an avg cost is plausible and
  costly. Mitigation: the confirm screen shows `source` per row, and numeric fields are
  the ones most likely to be edited. Accepted — this is why nothing auto-executes.
- **Flash on hard screenshots.** A dense, low-contrast broker table is the case where a
  cheaper model shows its limits. Mitigation is the confirm screen, which exists anyway;
  if a specific broker's layout misreads repeatedly, that parse can be pinned to Claude
  by input kind without touching anything else.
- **Snapshot growth.** At several hundred clients the snapshot stops being cheap. Current
  scale is far below that; revisit with a name-search tool call if it becomes real.
- **Sequential execution latency.** A 25-row plan is 25 round-trips to Supabase. Acceptable
  for a confirm-gated human action; parallelise independent rows if it becomes noticeable.
