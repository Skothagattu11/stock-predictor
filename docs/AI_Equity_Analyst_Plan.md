# AI-Powered Equity Analyst — Platform Plan
**Project:** candle-signal-dashboard
**Date:** 2026-07-08
**Version:** 1.0

---

## 1. What We Are Building

An institutional-grade AI equity research feature added as a new page (`/analyst.html`)
to the existing candle-signal-dashboard. It takes a stock ticker, gathers fundamental
and technical data from multiple sources, and outputs a structured 6-section research
report with a BUY / HOLD / SELL recommendation and a 0–100% confidence score.

---

## 2. What QuantConnect Adds (The Backtesting Layer)

QuantConnect is an open-source algorithmic trading platform built around the LEAN engine.

### What it provides:
| Capability              | What it means for us                                      |
|-------------------------|-----------------------------------------------------------|
| Historical OHLCV data   | Daily/minute bars going back 20+ years                    |
| Morningstar fundamentals| Clean P/E, EPS, revenue, margins — structured             |
| Backtesting engine      | Run a signal against 5+ years of history                  |
| Universe selection      | Screen 8,000+ stocks by criteria                          |
| Live trading bridge     | Route orders to Interactive Brokers, Tradier, etc.        |
| Research notebooks      | Jupyter environment with full data access                 |
| Alpha Streams           | Publish or sell validated signals                         |

### Without vs. With QuantConnect:

**Without QuantConnect:**
> "NVDA looks bullish based on today's candles" — a one-moment opinion

**With QuantConnect:**
> "NVDA's candlestick BUY signal has historically returned +12.4% over the next
> 20 days, with 68% win rate across 847 occurrences since 2018. Current setup
> matches the 2023 pre-breakout pattern."

QuantConnect turns the dashboard from a live signal viewer into a backtested,
statistically validated research tool. The AI analyst report gains a historical
performance section — not just "RSI is 62 and trending up" but "when RSI crossed
60 from below on weekly chart, NVDA was up 15%+ within 30 days in 71% of cases."

---

## 3. The Spec — What the Documents Describe

### Input Fields
| Field | Options        | Notes                                     |
|-------|----------------|-------------------------------------------|
| Query | Ticker or name | e.g. NVDA or "Nvidia"                     |
| Mode  | Single / Comparison | Comparison = 2+ tickers side-by-side |
| Depth | Standard / Deep | Deep = extended history + peer set       |

### Fundamental Analysis Module
- Revenue, EPS, margins, FCF — latest quarter + 4–8 quarter trailing trend
- P/E, P/S, EV/EBITDA, PEG, P/B — vs. sector average and own historical range
- Revenue/earnings CAGR, guidance trajectory, margin direction
- Debt/equity, interest coverage, cash position

### Technical Analysis Module
- RSI (14), MACD (12/26/9)
- 20/50/200-day moving averages, golden/death cross detection
- Bollinger Bands, recent pivot support/resistance levels
- Volume confirmation of trend moves

### Output — 6-Section Report
1. **Company Overview** — sector, market cap, one-line thesis
2. **Financial Performance Analysis** — metrics + trend direction, flag beats/misses
3. **Key Strengths & Risks** — bulleted, ranked by materiality
4. **Valuation Insights** — cheap/fair/expensive vs. benchmark
5. **Technical Trend Analysis** — current setup, momentum state, key levels
6. **Final Recommendation** — BUY / HOLD / SELL + reasoning + confidence level

### Recommendation Engine
Blend fundamental score + technical score → single directional call.
Each recommendation must state:
- 2–3 primary drivers
- Invalidation condition (what would break the thesis)
- Confidence level justified by data agreement

| Confidence Range | Meaning                              |
|-----------------|--------------------------------------|
| 80–100%         | Strong signal alignment              |
| 50–79%          | Moderate conviction, some conflict   |
| < 50%           | Mixed signals — default to HOLD      |

### Tone & Style Rules
- Lead with conclusion, then support it
- Quantify every claim ("margins expanded 240bps YoY", not "margins improved")
- No hype language, no investment guarantees
- Every report closes: *"For research purposes; not personalized investment advice."*

### Architecture (from spec)
- **Two-stage pipeline**: Stage A gathers data → Stage B generates structured report
- **Data source**: FMP (Financial Modeling Prep) for fundamentals; Yahoo for technicals
- **Delivery**: New standalone page, vanilla JS (matching existing project stack)
- **Verification**: Real-time data must confirm recommendation before surfacing

---

## 4. Detailed Example — NVDA Analysis

### Input
```
Ticker: NVDA
Mode:   Single
Depth:  Deep
```

---

### Stage A — Data Gathered (all parallel, ~2–3 seconds)

**Fundamentals via FMP:**
```
Revenue (TTM):        $96.3B   ↑ +122% YoY
EPS (TTM):            $1.69    ↑ +147% YoY
Gross Margin:         75.0%    ↑ from 56.9% prior year (+1,810bps)
Free Cash Flow:       $60.8B
P/E:                  35.2x    vs. Semis sector avg 28x
P/S:                  19.1x
EV/EBITDA:            29.4x
PEG:                  0.24     (below 1 = potentially undervalued for growth)
Debt/Equity:          0.41     (low leverage)
Interest Coverage:    112x     (extremely healthy)
Cash:                 $34.8B
```

**Technicals via Yahoo candles (1Y daily):**
```
RSI (14):             62.4     — not overbought, momentum building
MACD:                 Signal crossover 3 days ago — bullish
20-day MA:            $115.40  — price ($118.20) above
50-day MA:            $109.80  — price above, acting as support
200-day MA:           $98.50   — price well above, strong uptrend
Golden Cross:         YES — 50d crossed above 200d 47 days ago
Bollinger Bands:      Price near upper band — strong trend
Volume:               3-day avg 20% above 30-day avg — trend confirmed
Support Level:        $112.00 (20d MA region)
Resistance Level:     $124.50 (prior high)
```

**News context via Finnhub:**
```
- "Nvidia beats Q1 estimates, raises guidance" (2 days ago)
- "Blackwell GPU demand outstrips supply into 2026" (4 days ago)
- "Microsoft, Google double down on Nvidia chip orders" (1 week ago)
```

---

### Stage B — LLM Generated Report

#### Section 1: Company Overview
```
NVDA — NVIDIA Corporation
Sector: Semiconductors | Market Cap: $2.89T
Thesis: The dominant AI chip platform, capturing ~85% of GPU compute spend
for model training and inference, with accelerating revenue growth as
hyperscaler capex continues to expand.
```

#### Section 2: Financial Performance Analysis
```
Q1 FY2026 Revenue: $44.1B (+69% YoY) — beat consensus by $2.1B ✓ BEAT
EPS: $0.96 — beat consensus $0.89 ✓ BEAT
Gross Margin: 75.0% — expanded +1,810bps YoY — structural, not cyclical
FCF: $60.8B TTM — self-funding growth with zero dilution risk
Revenue CAGR (3yr): 74%
Guidance raised: Q2 FY2026 guided $45.5B vs. consensus $43.8B
⚠ Risk flag: Gross margin may compress 200–400bps in H2 as Blackwell
  ramp costs are absorbed.
```

#### Section 3: Key Strengths & Risks
```
STRENGTHS (ranked by materiality):
1. Monopoly-like GPU market share — CUDA ecosystem moat is 10+ years deep
2. Revenue growth re-accelerating (+122% YoY) as AI capex enters phase 2
3. PEG of 0.24 — growth-adjusted valuation is cheap despite headline P/E
4. Balance sheet fortress — $34.8B cash, 0.41 D/E, 112x interest coverage
5. Supply constraint = pricing power — not demand-driven shortfall

RISKS (ranked by materiality):
1. US export controls on H20/A800 chips to China — ~$15B revenue at risk
2. Customer concentration — MSFT, GOOG, META ~40% of revenue
3. AMD MI300X and custom silicon (TPU, Trainium) gaining traction
4. Valuation: P/E 35x leaves no margin of safety if growth slows to <40%
```

#### Section 4: Valuation Insights
```
Current P/E: 35.2x  |  Sector avg: 28x  |  Own 3yr range: 18x–68x
Assessment: FAIR-TO-CHEAP on a growth-adjusted basis

PEG of 0.24 is the key signal — a company growing EPS at 147% YoY
trading at 35x earnings is statistically cheap vs. its own history.
EV/EBITDA of 29.4x vs. 22x sector avg looks rich in isolation, but
NVDA's EBITDA grew 420% YoY — the ratio is compressing rapidly.
Verdict: Not cheap on trailing multiples. Cheap on forward + PEG basis.
Fair value range: $110–$145 over 12 months (base case: $128).
```

#### Section 5: Technical Trend Analysis
```
Current setup: BULLISH
- Above all three MAs (20/50/200) in ascending order — textbook uptrend
- Golden cross confirmed 47 days ago — structural shift, not a fake-out
- RSI at 62.4 — room to run before overbought (>70)
- MACD bullish crossover 3 days ago — early momentum signal
- Volume spike (+20% vs. 30d avg) confirms institutional participation

Key levels:
  Support:    $112.00 (20d MA — first stop on any pullback)
  Support 2:  $109.80 (50d MA — major structural support)
  Resistance: $124.50 (prior all-time high — break = new leg up)

Watch: Price near upper Bollinger Band — brief consolidation to $114–$116
before next leg is a healthy scenario, not a bearish signal.
```

#### Section 6: Final Recommendation
```
╔══════════════════════════════════╗
║   BUY    |   Confidence: 84%    ║
╚══════════════════════════════════╝

PRIMARY DRIVERS:
1. Fundamental + technical signals fully aligned (both bullish)
2. PEG of 0.24 makes current valuation defensible even at 35x P/E
3. Earnings momentum accelerating — two consecutive beats with raised guidance

INVALIDATION CONDITIONS (thesis breaks if):
- Gross margin falls below 70% for two consecutive quarters
- US expands chip export ban to cover remaining data center GPUs
- Revenue growth decelerates below 40% YoY on two consecutive prints

Confidence: 84% — HIGH
Fundamentals bullish + technicals aligned + news flow positive.
The only drag: China export risk creates a known ~$15B binary event
risk that technicals cannot price.

For research purposes; not personalized investment advice.
```

---

## 5. What This Adds to the Dashboard

| Today (existing) | After this feature |
|---|---|
| Live candlestick signals | + On-demand institutional-grade research any ticker |
| Short-term intraday predictions | + Historical signal validation (with QuantConnect) |
| Paper trading | + Analyst Report button on every paper trade |
| Wealth Manager client portfolios | + One-click analyst report per client position |

---

## 6. Implementation Plan

### Phase 1 — Core Analyst Page (FMP + Yahoo + LLM)
New files:
```
src/analyst-routes.js    — POST /api/analyst/report
src/analyst-service.js   — two-stage pipeline orchestrator
src/fmp-client.js        — FMP API (free tier) for fundamentals
src/technicals.js        — RSI, MACD, MAs, Bollinger from Yahoo candles
public/analyst.html      — new standalone page
public/analyst.js        — ticker input, 6-section report, confidence meter
```

Reused as-is:
```
yahoo-client.js          — candle history for technical computation
src/llm/ adapters        — Anthropic/OpenAI/Gemini/Perplexity ensemble
cache.js                 — 12h TTL fundamentals, 2min technicals
rest-routes.js           — /api/quote/:symbol for live price
```

### Phase 2 — Comparison Mode
Side-by-side table: valuation, growth, margins, technical, recommendation.
Ranked verdict across 2+ tickers.

### Phase 3 — QuantConnect Backtest Layer (optional)
Historical signal validation: "this exact RSI+MACD setup occurred N times,
avg return +X% over 20 days, Y% win rate."

---

## 7. Skills Available (from skills.sh search)

### Stock Analysis & Trading
| Skill | Installs | Purpose |
|---|---|---|
| `skills.volces.com@us-stock-analyst` | 48 | US stock analysis workflows |
| `staskh/trading_skills@technical-analysis` | 443 | RSI, MACD, MA patterns |
| `marketcalls/openalgo-indicator-skills@indicator-chart` | 416 | Indicator charting |
| `longbridge/skills@longbridge-market-scanner` | 505 | Market scanning |
| `tradermonty/claude-trading-skills@edge-hint-extractor` | 705 | Trading edge extraction |
| `kirkluokun/awesome-a-stock-openclawskills@stock-trade-journal` | 614 | Trade journaling |
| `skills.volces.com@stock-analysis` | 450 | General stock analysis |
| `jacobhsu/skillsmp-stock-analyzer@stock-analyzer` | 40 | Stock analyzer workflows |

### Data Visualization
| Skill | Installs | Purpose |
|---|---|---|
| `antvis/chart-visualization-skills@chart-visualization` | 4,800 | Chart/graph rendering |
| `claude-dev-suite/claude-dev-suite@charting` | 60 | Charting patterns |
| `aladicf/better-web-ui@data-viz` | 43 | Data visualization UI |

### LLM & Structured Output
| Skill | Installs | Purpose |
|---|---|---|
| `sickn33/antigravity-awesome-skills@llm-structured-output` | 73 | Structured LLM output |
| `davila7/claude-code-templates@instructor` | 368 | LLM instructor patterns |
| `mphinance/alpha-skills@edge-hint-extractor` | 71 | Alpha signal extraction |

### Backend / API
| Skill | Installs | Purpose |
|---|---|---|
| `wshobson/agents@nodejs-backend-patterns` | 39,100 | Node.js backend patterns |
| `asgard-ai-platform/skills@tech-api-integration` | 25 | API integration patterns |

---

## 8. FMP Free Tier — What's Available

Financial Modeling Prep free tier provides:
- Company profile (sector, market cap, description)
- Income statement (revenue, EPS, margins) — quarterly, 4 periods
- Balance sheet (cash, debt/equity)
- Cash flow statement (FCF)
- Key metrics (P/E, P/S, EV/EBITDA, PEG, P/B)
- Stock screener (limited)

**Free tier limits:** 250 API calls/day, 5 years of historical data.
**API key:** Register at financialmodelingprep.com — free, no credit card.

---

## 9. Data Flow Diagram

```
User enters ticker (NVDA)
        |
        v
POST /api/analyst/report
        |
   ┌────┴────┐
   |  Stage A | (parallel data fetch, ~2-3s)
   └────┬────┘
        |
   ┌────┼────────────────────┐
   v    v                    v
  FMP  Yahoo candles      Finnhub news
  (fundamentals)         (technicals        (sentiment)
   P/E, EPS,              RSI, MACD,
   margins, FCF)          MAs, Bollinger)
        |
   ┌────┴────┐
   |  Stage B | (LLM report generation, ~3-5s)
   └────┬────┘
        |
   Schema-locked prompt → Claude/Gemini/GPT-4
        |
        v
   6-section structured report
   + BUY/HOLD/SELL + confidence 0-100%
        |
        v
   /analyst.html renders report
   with confidence meter + recommendation badge
```

---

*Document generated: 2026-07-08*
*Project: candle-signal-dashboard | Stack: Node.js + Express + Vanilla JS + Supabase*
