# Implementation Plan — Sprint Tickets

Built in a new folder `candle-signal-dashboard/`. Engine and backend are CommonJS
(`require`/`module.exports`). Frontend is browser ES (script tags).

## Sprint 0 — Scaffold & contracts (main agent) ✅
- `package.json`, `.env.example`, `.gitignore`, `README.md`
- `docs/` : design spec, CONTRACTS.md, this plan
- Defines all interfaces so sprints 1–3 run in parallel.

## Sprint 1 — Analytics engine (parallel: 1A, 1B, 1C)
- **1A** `engine/indicators.js` + `test/indicators.test.js`
- **1B** `engine/patterns.js` + `test/patterns.test.js`
- **1C** `engine/scorer.js`, `engine/index.js` + `test/scorer.test.js`
- All code strictly to `docs/CONTRACTS.md`. Pure functions, no I/O.

## Sprint 2 — Node backend (parallel with 1 & 3)
- `src/config.js`, `src/ws-protocol.js`, `src/market-hours.js`
- `src/finnhub-client.js` — upstream WS, subscribe, reconnect/backoff
- `src/candle-aggregator.js` — ticks → OHLCV per symbol/timeframe
- `src/simulator.js` — off-hours / no-key candle generator (seeded)
- `src/rest-routes.js` — `/api/search`, `/api/quote`, `/api/health`
- `src/server.js` — Express static + `ws` server on `/stream`, wires engine
- Calls `engine/index.js#analyze` (interface only) and emits protocol messages.

## Sprint 3 — Frontend (parallel with 1 & 2)
- `public/index.html` — reference aesthetic, enhanced (search, badges, history log)
- `public/app.js` — `/stream` WS client, Lightweight Charts, overlays, render,
  simulated toggle, CSV backfill
- Codes to the WS protocol + analysis object in CONTRACTS.md.

## Sprint 4 — Integration & verification (main agent)
- `npm install`; `npm test` (node --test) — fix engine failures.
- `npm start`; smoke-test simulated mode (no key) end-to-end.
- Document Finnhub key setup; verify live path wiring.
- Final README pass.

## Parallelization
Sprints 1A/1B/1C/2/3 are mutually independent because every cross-module call is
pinned by CONTRACTS.md. Each owns a disjoint set of files → no write conflicts.
Sprint 4 integrates.
