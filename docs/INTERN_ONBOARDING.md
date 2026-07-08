# Intern Onboarding Guide — AI Equity Analyst Feature

Welcome. This guide walks you through everything you need to get productive on this codebase in one sitting. Read it top to bottom before writing any code.

---

## What You're Building

A new `/analyst.html` page that takes a US stock ticker, fetches fundamental data (Financial Modeling Prep) and technical indicators (Yahoo Finance), feeds both to an LLM (Gemini/Claude), and outputs a 6-section institutional research report with a BUY/HOLD/SELL verdict and a 0–100% confidence score.

The detailed design spec lives at:
```
docs/superpowers/specs/2026-07-08-ai-equity-analyst-design.md
```

The step-by-step implementation plan lives at:
```
docs/superpowers/plans/2026-07-08-ai-equity-analyst.md
```

**Read the spec first. Read the plan second. Then start coding.**

---

## Step 1 — Clone and Install

```bash
git clone <repo-url>
cd candle-signal-dashboard
npm install
```

Copy the environment file:
```bash
cp .env.example .env
```

---

## Step 2 — Fill In Environment Variables

Open `.env`. You need these three values:

```
SUPABASE_URL=https://drcehombkpiyhrckbadz.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<ask supervisor for the key>
FMP_API_KEY=<register free at financialmodelingprep.com — no credit card needed>
```

Get your free FMP key at: https://financialmodelingprep.com/developer/docs/

For the LLM, either `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` must be set (check `.env.example` for the exact variable names). The pipeline uses Gemini as primary. Ask your supervisor which one is available.

---

## Step 3 — Start the Server

```bash
npm start
```

Open http://localhost:3000 and confirm:
- The main signal dashboard loads
- The Manager pill navigates to `/login.html`
- No console errors in the browser

---

## Step 4 — Install Claude Code Superpowers Skills

This project uses **Claude Code** as your AI pair programmer (via the CLI). The skills system extends what Claude can do — like having domain-expert plugins.

### What are skills?

Skills are modular packages that give Claude specialized knowledge. Without them, Claude gives you generic answers. With them, Claude knows the exact workflow for TDD, structured LLM output, Node.js backend patterns, etc.

### Install Node Package Manager for skills

```bash
npm install -g npx
```

### Install the 5 required skills for this feature

Run these from the project root:

```bash
npx skills add staskh/trading_skills@technical-analysis -g -y
npx skills add wshobson/agents@nodejs-backend-patterns -g -y
npx skills add sickn33/antigravity-awesome-skills@llm-structured-output -g -y
npx skills add antvis/chart-visualization-skills@chart-visualization -g -y
npx skills add tradermonty/claude-trading-skills@edge-hint-extractor -g -y
```

Also install the superpowers bundle (brainstorming, writing plans, etc.):
```bash
npx skills add claude-plugins-official/superpowers -g -y
```

Verify all installed:
```bash
npx skills list
```

You should see all 5 technical skills listed.

### When to invoke a skill

In your Claude Code session, when you're about to work on something, type the skill name with a `/` prefix:

| Task | Skill to invoke |
|---|---|
| Computing RSI, MACD, Bollinger Bands | `/technical-analysis` |
| Adding an Express route or middleware | `/nodejs-backend-patterns` |
| Writing LLM prompts that return structured JSON | `/llm-structured-output` |
| Drawing charts or indicator displays | `/chart-visualization` |
| Working out confidence scoring logic | `/edge-hint-extractor` |
| Designing a new feature from scratch | `/brainstorming` |
| Writing an implementation plan | `/writing-plans` |

Claude will then follow that skill's specialized workflow instead of guessing.

---

## Step 5 — How to Work With Claude Code

Claude Code is your AI pair. Open it in your terminal:

```bash
claude
```

### The golden rule

**Check for a skill before doing anything.** If there's even a 1% chance a skill applies to what you're about to do, type the skill command first. This is enforced by the superpowers system — Claude will remind you if you forget.

### Workflow during implementation

For each task in the plan:

1. Open the plan file: `docs/superpowers/plans/2026-07-08-ai-equity-analyst.md`
2. Find the next unchecked task
3. Tell Claude: *"I'm starting Task N — [task name]. The plan is at docs/superpowers/plans/2026-07-08-ai-equity-analyst.md"*
4. Claude will read the plan and execute each step with you
5. After the task is done, check the checkbox in the plan file

### TDD is mandatory

Every task in the plan follows this exact cycle — do not skip steps:

```
Write failing test → Run to confirm it fails → Implement code → Run to confirm pass → Commit
```

If you skip the "run failing test" step, you might write a test that passes vacuously (i.e., it's testing nothing). The failing run is the proof the test is real.

### Commit after every task

The plan ends each task with a commit step. Do it. Small commits = easy code review = faster approval.

---

## Step 6 — Project Structure You Need to Know

```
candle-signal-dashboard/
├── src/
│   ├── server.js           ← Express app entry — you add one app.use() line here
│   ├── rest-routes.js      ← Existing REST routes (DO NOT MODIFY)
│   ├── manager-routes.js   ← Wealth Manager routes (DO NOT MODIFY)
│   ├── auth-middleware.js  ← Supabase JWT auth (DO NOT MODIFY)
│   ├── cache.js            ← In-memory TTL cache — you use this
│   ├── yahoo-client.js     ← Yahoo Finance candle fetcher — you use this
│   ├── sidecar.js          ← Quant sidecar client (DO NOT MODIFY)
│   └── predict-service.js  ← Prediction service (DO NOT MODIFY)
│
├── public/
│   ├── index.html          ← Main dashboard — you add ONE nav pill
│   ├── manager.html/.js    ← Wealth Manager — you add ONE button per position row
│   ├── paper.js            ← Paper trading — you add ONE button per signal card
│   └── (your new files here)
│
├── docs/
│   ├── AI_Equity_Analyst_Plan.md           ← Background reading
│   ├── INTERN_ONBOARDING.md                ← This file
│   └── superpowers/
│       ├── specs/2026-07-08-ai-equity-analyst-design.md  ← THE SPEC
│       └── plans/2026-07-08-ai-equity-analyst.md         ← THE PLAN
│
├── tests/
│   ├── unit/               ← Unit tests (no network, fast)
│   └── integration/        ← Integration tests (require network + server)
│
└── .env                    ← Your secrets (never commit this)
```

### Files you will CREATE (all new)

```
src/fmp-client.js           ← FMP API wrapper
src/technicals.js           ← RSI, MACD, Bollinger, SMA
src/analyst-service.js      ← Two-stage pipeline orchestrator
src/analyst-routes.js       ← Express router for /api/analyst/*
src/analyst-observability.js← Logging + metrics ring buffer
public/analyst.html         ← The new analyst page
public/analyst.js           ← Frontend logic
public/admin.html           ← Observability dashboard
```

### Files you will MODIFY (minimally — follow the plan exactly)

```
src/server.js               ← Add: app.use('/api/analyst', analystRouter)
public/index.html           ← Add: Analyst nav pill
public/manager.js           ← Add: Analyst Report button per position
public/paper.js             ← Add: Analyst Report button per signal card
```

---

## Step 7 — Running Tests

Unit tests (fast, no network):
```bash
npm test
```

Integration tests (slow, need network + running server):
```bash
# In one terminal:
npm start

# In another terminal:
npm run test:integration
```

A test failing with `FMP_API_KEY not set` is a skip, not a failure — set the key in `.env` and retry.

---

## Step 8 — The 5 Milestones

The plan is organized into 5 milestones. Work them in order — each milestone produces something testable before you move on.

| Milestone | What you build | Deliverable |
|---|---|---|
| **M1** | FMP client + technical indicators + integration tests | Real data from FMP and Yahoo verified locally |
| **M2** | Backend API — routes, pipeline, observability | `curl POST /api/analyst/report` returns a real LLM report |
| **M3** | Frontend — analyst page + admin panel | `/analyst.html` renders full 6-section report |
| **M4** | Integrations — manager.js + paper.js buttons | One-click Analyst Report from any position or signal |
| **M5** | Comparison mode + full test suite green | All unit + integration tests pass; comparison table works |

**Start with M1.** Do not touch the frontend until the backend is working.

---

## Step 9 — Requesting Code Review

When you finish a milestone, ping your supervisor with:

1. The milestone number and what it covers
2. A link to the PR or branch
3. The test output showing all tests green

Example message:
> "M1 done — FMP client and technicals. All 10 unit tests pass, FMP integration shows real AAPL data. Branch: `feat/analyst-m1`. Tests: [screenshot or output]"

Your supervisor will review before you proceed to the next milestone.

---

## Step 10 — What NOT to Do

These things will break existing features or waste time:

- **Do not modify** `server.js`, `rest-routes.js`, `manager-routes.js`, `auth-middleware.js`, `yahoo-client.js`, `sidecar.js`, or `predict-service.js` beyond what the plan explicitly says.
- **Do not add** npm packages without checking with your supervisor. The plan uses only Node.js built-ins + existing `@supabase/supabase-js`.
- **Do not use** React, TypeScript, bundlers, or any frontend framework. This codebase is vanilla JS only.
- **Do not skip** the failing-test step. Red before green is mandatory.
- **Do not commit** your `.env` file. Ever.

---

## Quick Reference

| Thing | Where |
|---|---|
| Spec (architecture, data flow, use cases) | `docs/superpowers/specs/2026-07-08-ai-equity-analyst-design.md` |
| Plan (step-by-step tasks with code) | `docs/superpowers/plans/2026-07-08-ai-equity-analyst.md` |
| Background / NVDA example | `docs/AI_Equity_Analyst_Plan.md` |
| Project setup / stack | `CLAUDE.md` (project root) |
| FMP free tier | https://financialmodelingprep.com/developer/docs/ |
| Run unit tests | `npm test` |
| Run integration tests | `npm run test:integration` |
| Invoke a skill in Claude | `/skill-name` at the start of your Claude session |

---

*Questions? Ask your supervisor before guessing. A 5-minute question saves 2 hours of wrong work.*
