# Paper Trading (Phase B-1, US equities) — Design

**Status:** Approved scope, implementing
**Date:** 2026-06-19

## Goal

Let the user place **simulated trades at real market prices** to prove the Goal
Planner's picks actually make money before risking real funds. A self-simulated
internal paper book tracks a cash account and positions, auto-closes at each
pick's target/stop, and reports a durable track record (win rate, total return).

## Scope decisions (from brainstorming)

- **Self-simulated** internal book (no external broker API).
- **Manual** "Paper Trade" button on picks **and** an optional **auto-mode** that
  takes every Goal Planner pick.
- Exits: **auto at target/stop** (using 1-min bar high/low since entry) **and
  manual close**.
- **US equities only** in this build.
- **Starting balance $10,000**, resettable. **60-second** mark/exit tick.

## Out of scope

Crypto/Hyperliquid (separate sub-project), real-money execution (Phase C),
slippage/commission modeling, multiple paper accounts, short selling (long-only,
matching the Goal Planner).

## Why the engine lives in the sidecar

The paper book must persist for weeks and auto-close positions while the user is
away. The **`quant-py` sidecar** is on the always-on `starter` plan with the
persistent disk (`/data`) where the SQLite stores already live; the Node app is
`free` and sleeps. So the engine, store, and the periodic tick run in the
sidecar. Node only proxies.

## Architecture

### Python sidecar

**`app/store/paper.py` — `PaperStore` (SQLite on `/data/paper.db`)**, mirroring
`CalibrationStore`. Tables:
- `account(id INTEGER PRIMARY KEY CHECK(id=1), cash REAL, starting REAL, created_at TEXT)`
  — single row; created with $10,000 if absent.
- `positions(id TEXT PRIMARY KEY, symbol TEXT, shares REAL, entry REAL,
  target REAL, stop REAL, opened_at TEXT, status TEXT, exit_price REAL,
  exit_reason TEXT, closed_at TEXT, source TEXT)`
  — `status` ∈ `open|closed`; `exit_reason` ∈ `target|stop|manual`; `source` ∈
  `manual|auto`.
- `settings(id INTEGER PRIMARY KEY CHECK(id=1), auto_enabled INTEGER,
  budget REAL, target REAL, risk TEXT)` — single row; auto-mode config.

Methods: `get_account`, `open_position`, `close_position`, `list_positions(status=None)`,
`get_settings`, `set_settings`, `reset(starting=10000)`.

**`app/paper/engine.py` — pure logic (no I/O):**
- `open_order(account_cash, symbol, price, budget, target, stop) -> dict|str` —
  `shares = floor(budget/price)`; cost `= shares*price`; reject (return an error
  string) if `shares < 1` or `cost > account_cash`; else return the position dict
  (status `open`) and the cash to deduct.
- `evaluate_exit(position, bars_since_entry) -> (reason, exit_price)|None` —
  scan the 1-min bars (each `{high, low, close}`) chronologically; first bar with
  `high >= target` → `("target", target)`; first with `low <= stop` →
  `("stop", stop)`; if a single bar crosses both, resolve as `stop` (conservative).
  Returns `None` if neither touched.
- `mark_to_market(position, last_price) -> dict` — unrealized P&L abs/pct for an
  open position.
- `portfolio_stats(closed_positions) -> dict` — `wins`, `losses`, `win_rate`,
  `avg_win`, `avg_loss`, `realized_pnl`, `total_return_pct` vs starting.

**Endpoints (`app/api.py`):**
- `POST /paper/order` — body `{symbol, budget, target, stop}` (entry omitted →
  filled at live price; target/stop optional → manual-close-only position).
  Fills at `_live_price`, opens the position, deducts cash. 400 on reject.
- `POST /paper/close/{id}` — manual close at live price (`exit_reason=manual`).
- `GET /paper/portfolio` — `{account:{cash,equity,starting}, open:[...marked],
  stats:{...}}` (equity = cash + Σ open position market value).
- `GET /paper/history` — closed positions (most recent first) + `stats`.
- `GET /paper/settings`, `POST /paper/settings` — auto-mode config.
- `POST /paper/reset` — wipe positions, reset cash to starting.

**Background tick (FastAPI lifespan task, ~60s):**
1. For each **open** position: fetch today's 1-min bars, take those with
   `timestamp >= opened_at`, run `evaluate_exit`; if it returns, `close_position`
   (credit `shares*exit_price` to cash) and record win/loss.
2. If `settings.auto_enabled`: run `scan_opportunities(md, budget, target, risk)`
   (factored out of the `/opportunities` endpoint so both share one code path),
   and for each pick not already held with an open position, `open_order` it
   (`source=auto`), skipping on insufficient cash / duplicate symbol.

The tick guards every external call in try/except so one bad symbol never stops
the loop. It is disabled cleanly during tests (only starts under the app
lifespan, not on import).

### Node orchestrator

- `src/sidecar.js`: add `paperOrder(body)`, `paperClose(id)`, `paperPortfolio()`,
  `paperHistory()`, `paperSettings()`, `paperSetSettings(body)`, `paperReset()`.
- `src/paper-routes.js`: `createPaperRouter({ sidecar })` mounting
  `/api/paper/*` → sidecar, **uncached** (state is live). Reuses the existing
  `wrap` error pattern (forwards upstream status).
- `src/server.js`: mount `app.use('/api/paper', createPaperRouter({ sidecar }))`.

### Frontend

- **`public/paper.js`** — a "Paper Trading" panel: account equity / cash /
  realized P&L / **win rate**, a table of open positions (live unrealized P&L,
  per-row "Close" button), a closed-trade history table, and an **Auto-mode**
  toggle with budget/target/risk inputs (POST `/api/paper/settings`). Polls
  `/api/paper/portfolio` every 30s while visible.
- **`public/opportunities.js`** — add a **"Paper Trade"** button to each pick row
  that POSTs `/api/paper/order` with the pick's `symbol`, `invested`-derived
  budget, `entry_high` (→ uses live fill), `target_dollars`-derived target price,
  and stop. (Target price = `entry*(1+required_move_pct)`; stop price =
  `entry*(1 - risk_dollars/invested)`.) On success, refresh the paper panel.
- `public/index.html` — add the Paper Trading panel (card structure, matching the
  existing `card`/`cardBody` classes) and the `<script src="paper.js">` include.

## Data flow

```
Manual: click "Paper Trade" on a pick
  → POST /api/paper/order {symbol,budget,target,stop}
    → sidecar fills at _live_price, opens position, deducts cash
Auto:   toggle on (budget/target/risk persisted)
    → sidecar tick scans opportunities, opens new picks (source=auto)
Exit:   sidecar tick → bars since entry → target/stop touch → close win/loss
View:   GET /api/paper/portfolio  &  /api/paper/history
```

## Error handling

- Insufficient cash or `shares < 1` → order rejected (HTTP 400 with reason; auto
  skips silently).
- Duplicate open position for a symbol → rejected (manual) / skipped (auto).
- Live-price or bar fetch failure → that order/position skipped this tick; loop
  continues.
- Position with no target/stop → never auto-closes; manual close only.
- Empty/again-unconfigured settings → auto-mode treated as off.

## Persistence & starting balance

SQLite at `/data/paper.db` on the sidecar's mounted disk. First run seeds the
account with **$10,000**. `POST /paper/reset` restores it and clears positions.

## Realism caveats (documented, not bugs)

- Fills at the latest 1-min close/level; **no slippage or commission** in v1.
- 60-second tick can miss a target/stop touched and reversed entirely within one
  minute (the bar high/low check mitigates most of this).

## Testing

**pytest:**
- `engine.open_order`: shares/cost math; reject on `shares<1` and on
  `cost>cash`.
- `engine.evaluate_exit`: target-touch → win; stop-touch → loss; both-in-one-bar
  → stop; neither → None; only bars after entry counted.
- `engine.portfolio_stats`: win rate, avg win/loss, total return.
- `PaperStore`: seed $10k, open/close round-trip, list by status, reset.
- endpoints: order opens + deducts cash; close credits cash; portfolio marks
  open positions; reset restores; insufficient cash → 400.

**node:test:** `/api/paper/*` proxy routes pass bodies through and return JSON;
upstream 400/503 forwarded.

## Security

No new secrets. Paper state is non-sensitive simulated data on the existing disk.
The standing rule holds: `.env` never committed; verified unstaged before commits.
