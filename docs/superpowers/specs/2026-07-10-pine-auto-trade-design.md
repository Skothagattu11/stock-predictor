# Pine Script → Auto Paper Trade Bridge

**Date:** 2026-07-10
**Status:** Approved

---

## Overview

Connect the existing TradingView webhook receiver to the paper trading engine so Pine Script alerts can automatically open and close paper positions. The wealth manager controls all behaviour through a new "Pine Signals" section in the existing paper settings panel — choosing between fully automatic execution or an approval queue where each signal is reviewed before it trades.

---

## Architecture

```
Pine Script alert
      │
      ▼
POST /api/tv/webhook
      │  reads pine settings from PaperStore
      ├─ enabled=false → store signal only (existing behaviour, no change)
      │
      ├─ mode="auto"
      │     ├─ bullish → onDuplicate logic → paperOrder() immediately
      │     └─ bearish/neutral → onExit logic → paperClose() immediately
      │
      └─ mode="approval"
            └─ push to in-memory PendingQueue (capped 50)
                  │
                  └─ Manager reviews in UI
                        ├─ Approve → execute paperOrder() / paperClose()
                        └─ Reject  → discard
```

---

## Storage

### Pine settings block (extends existing paper settings JSON)

```json
{
  "pine": {
    "enabled": false,
    "mode": "auto",
    "onDuplicate": "skip",
    "onExit": "closeAll"
  }
}
```

- `enabled` — master on/off switch. Default `false` (opt-in).
- `mode` — `"auto"` executes immediately; `"approval"` queues for review.
- `onDuplicate` — behaviour when a BUY signal arrives for a ticker already held:
  - `"skip"` — ignore the signal
  - `"stack"` — open a new independent position
  - `"scale"` — add to the most recent open position (increase quantity)
- `onExit` — behaviour when a SELL/EXIT/NEUTRAL signal arrives:
  - `"closeAll"` — close every open position for that ticker
  - `"closeLatest"` — close only the most recent position
  - `"ignore"` — take no action; manual close only

No schema migration needed — existing settings endpoint stores and returns arbitrary JSON.

### Approval queue

In-memory, capped at 50. Not persisted — server restart drops pending signals (acceptable; Pine re-fires if condition holds). Each entry:

```json
{
  "id": "<uuid>",
  "ts": 1720612345000,
  "symbol": "NVDA",
  "stance": "bullish",
  "action": "buy",
  "price": 875.20,
  "strategy": "Golden Cross"
}
```

---

## API

### Modified endpoints

| Endpoint | Change |
|---|---|
| `POST /api/tv/webhook` | After `store.record()`, reads pine settings from sidecar and executes or queues |
| `GET /api/paper/settings` | Returns pine block merged with defaults |
| `POST /api/paper/settings` | Accepts and persists pine block |

### New endpoints (mounted on `/api/tv`)

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /tv/pending` | None | Returns pending approval queue array |
| `POST /tv/pending/:id/approve` | None | Executes the queued signal then removes it |
| `POST /tv/pending/:id/reject` | None | Removes signal from queue, no trade |

No JWT auth on pending endpoints — consistent with paper trading endpoints which are also unprotected (paper trading is single-user, local).

---

## File changes

| File | Change |
|---|---|
| `src/tv-webhook.js` | Accept `{ sidecar, getPineSettings }` in `createTvRouter`. Add `PendingQueue` class. Add execution logic in webhook handler. Add `/pending`, `/pending/:id/approve`, `/pending/:id/reject` routes |
| `src/server.js` | Pass `sidecar` and `getPineSettings` into `createTvRouter` |
| `public/paper.js` | Add Pine settings section to settings modal. Add pending approvals panel with 15s polling |

---

## UI

### Pine settings section (inside existing paper settings modal)

```
┌─ Pine Script / TradingView Signals ──────────────────┐
│  Enable auto-trading from Pine alerts   [ON / OFF]   │
│                                                       │
│  Execution mode                                       │
│    ○ Auto — execute immediately on signal             │
│    ○ Approval — queue for my review                   │
│                                                       │
│  When already holding the ticker                      │
│    ○ Skip — ignore duplicate signal                   │
│    ○ Stack — open another position                    │
│    ○ Scale — add to existing position                 │
│                                                       │
│  On EXIT / SELL signal                                │
│    ○ Close all positions for that ticker              │
│    ○ Close most recent position only                  │
│    ○ Ignore — manual close only                       │
└───────────────────────────────────────────────────────┘
```

### Pending approvals panel (below positions, approval mode only)

Visible only when `pine.mode="approval"` and queue is non-empty. Polls `GET /api/tv/pending` every 15 seconds.

```
┌─ Pending Pine Signals (2) ───────────────────────────┐
│  NVDA  BUY  $875.20  Golden Cross  2 min ago          │
│  [Approve]  [Reject]                                  │
│                                                       │
│  TSLA  EXIT  $214.50  RSI Overbought  5 min ago       │
│  [Approve]  [Reject]                                  │
└───────────────────────────────────────────────────────┘
```

---

## Error handling

| Scenario | Behaviour |
|---|---|
| Insufficient cash on auto-execute | `200` returned to TradingView (signal accepted); error logged; pending panel shows failure note if approval mode |
| EXIT signal, no open position | No-op, `200` returned silently |
| `onDuplicate=scale`, no position exists | Treat as fresh open — place normal order |
| Approval queue full (50) | Oldest entry dropped, new one queued, warning badge shown in UI |
| `pine.enabled=false` | Existing behaviour only — signal stored, no trade |
| Bad/missing webhook secret | `401` before any logic runs |

---

## Pine Script alert template

Managers point TradingView alerts at `POST /api/tv/webhook` with this JSON message body:

```json
{
  "symbol": "{{ticker}}",
  "action": "{{strategy.order.action}}",
  "price": {{close}},
  "strategy": "My Strategy Name",
  "secret": "optional_secret_here"
}
```

Accepted `action` values: `buy`, `long`, `bull` → bullish · `sell`, `short`, `bear` → bearish · `exit`, `flat`, `close`, `hold`, `neutral` → neutral/exit.

---

## Out of scope

- Persisting the approval queue across server restarts
- Per-ticker pine settings (global settings only)
- Live WebSocket push for new pending signals (polling is sufficient)
- Any changes to the analyst or wealth manager pages
