# stock-predictor — Implementation Guide

Cloned from: https://github.com/HolisticOS/stock-predictor.git

## Project overview

Live candlestick pattern signal dashboard (Finnhub WebSocket + Yahoo Finance) with an added Wealth Manager layer for portfolio managers to track client investments.

## Stack

- **Backend**: Node.js + Express 4, WebSocket (`ws`), vanilla JS frontend
- **Auth + DB**: Supabase (PostgreSQL via Supabase REST, Supabase Auth JWT verification)
- **No ORM**: Direct Supabase JS client calls
- **Frontend**: Vanilla HTML/CSS/JS (no bundler, no framework)

## Features

### Existing (DO NOT touch)
- `src/server.js` — WebSocket streaming, candle aggregator, quote polling
- `src/rest-routes.js` — `/api/search`, `/api/quote/:symbol`, `/api/news/:symbol`
- `public/app.js` — chart, signals, indicators
- `public/predictions.js`, `discover.js`, `alerts.js`, `opportunities.js`, `paper.js`

### Added: Wealth Manager
- **Login**: `public/login.html` + `public/login.js` → auth via `/api/manager/auth/login`
- **Manager dashboard**: `public/manager.html` + `public/manager.js`
- **Public share page**: `public/share.html` + `public/share.js`
- **API routes**: `src/manager-routes.js` mounted at `/api/manager`
- **Auth middleware**: `src/auth-middleware.js` (Supabase JWT verification)
- **Supabase client**: `src/supabase.js` (service role, server-side only)

## Pages

| URL | Description |
|-----|-------------|
| `/` | Main stock signals dashboard (public) |
| `/login.html` | Wealth manager sign-in / register |
| `/manager.html` | Wealth manager dashboard (auth required) |
| `/share.html?token=TOKEN` | Public read-only portfolio view |

## API routes (`/api/manager/...`)

### Auth (no JWT required)
- `POST /auth/login` — sign in, returns `{ access_token, user }`
- `POST /auth/signup` — create account + auto sign-in

### Clients (JWT required)
- `GET /clients` — list all clients for the logged-in manager
- `POST /clients` — create client
- `GET /clients/:id` — get client + portfolios
- `PUT /clients/:id` — update client
- `DELETE /clients/:id` — delete client + all portfolios

### Portfolios (JWT required)
- `GET /clients/:clientId/portfolios` — list portfolios
- `POST /clients/:clientId/portfolios` — create portfolio
- `GET /portfolios/:id` — get portfolio + positions
- `DELETE /portfolios/:id` — delete portfolio

### Positions (JWT required)
- `POST /portfolios/:portfolioId/positions` — add position (logs BUY event)
- `PUT /positions/:id` — update position (logs REBALANCE event)
- `DELETE /positions/:id` — close position with sell price (logs SELL event)

### History (JWT required)
- `GET /portfolios/:portfolioId/history` — get trade event timeline

### Share tokens (JWT required for manage; public for view)
- `GET /portfolios/:portfolioId/share` — get or create share token
- `PUT /portfolios/:portfolioId/share` — update `{ is_active, expires_at }`
- `DELETE /portfolios/:portfolioId/share` — revoke (sets is_active=false)
- `GET /share/:token/view` — **public** — read-only portfolio snapshot + live prices

## Database schema

Run `supabase-migration.sql` in Supabase SQL Editor before first use.

Tables:
- `manager_clients` — clients, linked to `auth.users.id` (manager_id)
- `client_portfolios` — portfolios per client
- `portfolio_positions` — individual stock positions
- `position_history` — audit trail (BUY/SELL/REBALANCE/NOTE); position_id is nullable (SET NULL on delete so SELL records survive)
- `share_tokens` — public portfolio link tokens with expiry + revoke support

## Auth flow

1. Browser POSTs to `/api/manager/auth/login` with email + password
2. Server calls `supabase.auth.signInWithPassword(...)` (service role client — avoids exposing anon key)
3. Returns `access_token` → stored in `localStorage` as `wm_token`
4. All manager API calls include `Authorization: Bearer <token>`
5. `src/auth-middleware.js` calls `supabase.auth.getUser(token)` to verify + extract `user.id`

## Share link flow

1. Manager visits a portfolio → clicks Share → `GET /api/manager/portfolios/:id/share` creates token in DB
2. Share URL: `http://localhost:3000/share.html?token=<uuid>`
3. Public viewer loads `share.js` → calls `GET /api/manager/share/:token/view` (no auth)
4. Server fetches live prices via the existing `/api/quote/:symbol` endpoint
5. Manager can revoke or set expiry via `PUT/DELETE /api/manager/portfolios/:id/share`

## Environment variables (.env)

```
# Required for Wealth Manager
SUPABASE_URL=https://drcehombkpiyhrckbadz.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role_key>
APP_URL=http://localhost:3000
```

## Setup steps

1. `npm install` (installs `@supabase/supabase-js`)
2. Copy `.env.example` → `.env`, fill in Supabase keys
3. Run `supabase-migration.sql` in Supabase SQL Editor
4. `npm start` (or `npm run dev`)
5. Open http://localhost:3000 — click "Manager" pill → login → create clients

## Key design decisions

- **Server proxies auth**: The browser never sees the Supabase anon key. Login is done through `/api/manager/auth/login` which uses the service role client.
- **position_history.position_id is nullable**: Uses `ON DELETE SET NULL` so SELL event records survive after a position is deleted. This preserves the audit trail.
- **No React/Next.js**: This app uses vanilla JS. The manager UI is a standalone HTML page with inline fetch calls.
- **Live prices in share view**: The public share endpoint reuses the existing `/api/quote/:symbol` Finnhub route to show live prices.
- **Existing features untouched**: All WebSocket, signals, predictions, paper trading, discovery, and AI chat features remain exactly as they were.

---

## AI Equity Analyst Feature

Planned new page (`/analyst.html`) implementing institutional-grade equity research.
Full spec and implementation plan: `docs/AI_Equity_Analyst_Plan.md`

### New files (when built)
- `src/analyst-routes.js` — `POST /api/analyst/report`
- `src/analyst-service.js` — two-stage pipeline (data gather → LLM report)
- `src/fmp-client.js` — Financial Modeling Prep API (free tier, 250 calls/day)
- `src/technicals.js` — RSI(14), MACD(12/26/9), MAs, Bollinger from Yahoo candles
- `public/analyst.html` + `public/analyst.js` — report UI with confidence meter

### New environment variable
```
FMP_API_KEY=<your_key>   # Free at financialmodelingprep.com — no credit card
```

### Pages added
| URL | Description |
|-----|-------------|
| `/analyst.html` | AI equity analyst — BUY/HOLD/SELL report for any ticker |

---

## Required Skills — AI Equity Analyst

The following skills must be installed for AI-assisted development of this project.
If any are missing, install them with the commands below.

### Check what's installed
```bash
npx skills check
```

### Install all required skills (run if missing)
```bash
# Technical indicators — RSI, MACD, Bollinger, Moving Averages
npx skills add staskh/trading_skills@technical-analysis -g -y

# Node.js backend service patterns — Express routes, middleware, error handling
npx skills add wshobson/agents@nodejs-backend-patterns -g -y

# LLM structured output — schema-locked JSON responses across Anthropic/OpenAI/Gemini
npx skills add sickn33/antigravity-awesome-skills@llm-structured-output -g -y

# Chart & data visualization — confidence meters, sparklines, comparison tables
npx skills add antvis/chart-visualization-skills@chart-visualization -g -y

# Trading edge extraction — signal quality scoring, alpha hint patterns
npx skills add tradermonty/claude-trading-skills@edge-hint-extractor -g -y
```

### What each skill is used for
| Skill | Used in |
|---|---|
| `technical-analysis` | `src/technicals.js` — computing RSI, MACD, MAs from Yahoo candles |
| `nodejs-backend-patterns` | `src/analyst-routes.js`, `src/analyst-service.js` — service architecture |
| `llm-structured-output` | `src/llm/` — locking report to 6-section schema |
| `chart-visualization` | `public/analyst.js` — confidence meter, valuation charts |
| `edge-hint-extractor` | `src/analyst-service.js` — signal quality scoring for confidence % |
