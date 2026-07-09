'use strict';
// AI Equity Analyst — two-stage pipeline orchestrator.
//
// STRICT CONTRACT (choice A + documented <50 => HOLD):
//   1. report.recommendation.verdict comes from the LLM narrative schema.
//   2. top-level verdict mirrors it.
//   3. confidence is deterministic — Doc 2's exact blendConfidence() over Stage-A data.
//   4. if confidence < 50, override nested + top-level verdict to HOLD (Doc 1:
//      "Mixed signals — default to HOLD"). No BUY/SELL thresholds are invented.
//   5. all numeric/structured fields come from Stage A, never the LLM.
//   6. no `meta` in the public response.
//   7. public method is positional: report(ticker, mode, depth, fresh).
//
// DEVIATION FROM SPEC (design §11): Gemini-primary → Claude(Anthropic)-primary,
// OpenAI-fallback. Reason: no Gemini key provisioned; Anthropic+OpenAI keys live;
// the spec's Gemini rationale (Google Search grounding) does not materialize through
// the existing generateObject() adapter; spec itself calls Claude "more reliable on
// schema". Provider order is injected, so this is wiring, not lock-in.
//
// Dependency-injected so it is fully unit-testable offline with stubbed fmp/llm.

const { LlmNarrativeSchema, ComparisonRankSchema, DISCLAIMER } = require('./analyst-schema');

const REQUIRED_SECTIONS = ['overview', 'financials', 'strengthsRisks', 'valuation', 'technical', 'recommendation'];
const VALID_VERDICTS = new Set(['BUY', 'HOLD', 'SELL']);

// Final merged-report validator (Doc 2 lines 830-835, hand-rolled).
function validateReport(report) {
  const missing = REQUIRED_SECTIONS.filter((s) => !report || !(s in report));
  if (missing.length) throw new Error(`Report missing sections: ${missing.join(', ')}`);
  const v = report.recommendation && report.recommendation.verdict;
  if (!VALID_VERDICTS.has(v)) throw new Error(`Invalid verdict: "${v}" must be BUY, HOLD, or SELL`);
}

// Deterministic confidence — Doc 2 lines 865-886, verbatim heuristic.
function blendConfidence(fundamentals, technicals) {
  let bullish = 0, total = 0;
  if (technicals && technicals.available) {
    total += 4;
    if (technicals.rsi && technicals.rsi.value < 70 && technicals.rsi.value > 30) bullish++;
    if (technicals.macd && technicals.macd.crossover === 'bullish') bullish += 2;
    if (technicals.movingAverages) {
      const ma = technicals.movingAverages;
      if (ma.priceVsSma200 === 'above') bullish++;
    }
  }
  if (fundamentals && fundamentals.metrics) {
    const m = fundamentals.metrics;
    total += 3;
    // Positive P/E under 40 = attractively valued. A negative P/E (unprofitable) or
    // 0 must NOT score bullish.
    if (m.peRatio != null && m.peRatio > 0 && m.peRatio < 40) bullish++;
    // Low leverage is bullish — INCLUDE debt-free (0). `!= null` avoids the falsy-zero trap.
    if (m.debtToEquity != null && m.debtToEquity < 1) bullish++;
    // Revenue growth needs two REAL periods; a null prior (single-statement ticker)
    // must not coerce to 0 and spuriously grant the point.
    const inc = fundamentals.income;
    if (inc && inc.length > 1 && inc[0] && inc[1] &&
        inc[0].revenue != null && inc[1].revenue != null &&
        inc[0].revenue > inc[1].revenue) bullish++;
  }
  if (total === 0) return 50; // no data
  return Math.round((bullish / total) * 100);
}

const DEFAULTS = { reportTtlMs: 30 * 60 * 1000, llmTimeoutMs: 10 * 1000, maxSchemaRetries: 2 };

function classifyError(err) {
  if (err && err.kind) return err.kind;
  const s = `${(err && err.name) || ''} ${(err && err.message) || ''}`;
  if (/abort|timeout/i.test(s)) return 'timeout';
  // Schema-only markers. Deliberately NOT "invalid"/"parse" — those match auth/config
  // errors like "invalid API key", which must fail over, not retry the same provider.
  if (/schema|noobjectgenerated|zod|validation|does not match/i.test(s)) return 'schema';
  return 'error';
}

function withTimeout(promiseLike, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { const e = new Error(`llm timeout after ${ms}ms`); e.kind = 'timeout'; reject(e); }, ms);
  });
  return Promise.race([Promise.resolve(promiseLike), timeout]).finally(() => clearTimeout(timer));
}

function buildPrompt(symbol, fundamentals, technicals, news, strictNote, peers) {
  return [
    `You are an institutional equity research analyst. Analyse ${symbol}.`,
    'Return ONLY the narrative fields defined by the schema — do NOT invent numeric values; the system supplies all numbers from data.',
    'Rules: verdict MUST be exactly BUY, HOLD, or SELL; lead with the conclusion; quantify claims from the data provided; no hype, no guarantees.',
    strictNote || '',
    `--- FUNDAMENTAL DATA ---\n${JSON.stringify(fundamentals)}`,
    `--- TECHNICAL DATA ---\n${JSON.stringify(technicals)}`,
    `--- RECENT NEWS HEADLINES ---\n${JSON.stringify((news || []).slice(0, 5).map((n) => n && n.headline))}`,
    peers && peers.length ? `--- PEER SET (deep mode) ---\n${JSON.stringify(peers.slice(0, 6))}` : '',
  ].filter(Boolean).join('\n\n');
}

const STRICT_NOTE = 'IMPORTANT: your previous output failed schema validation. Return STRICTLY valid structured output with every required narrative field present and correctly typed.';

function num(x) { return typeof x === 'number' && !Number.isNaN(x) ? x : null; }

function createAnalystService(deps = {}) {
  const {
    fmp, technicals: techModule, cache, llm,
    config = {},
    obs = { log() {}, logError() {} },
    news = { fetchNews: async () => [] },
    now = () => new Date().toISOString(),
    clock = () => Date.now(),  // numeric ms, for stage timings
  } = deps;

  if (!fmp || !techModule || !cache || !llm) {
    throw new Error('createAnalystService requires { fmp, technicals, cache, llm }');
  }

  const reportTtlMs = config.reportTtlMs || DEFAULTS.reportTtlMs;
  const fundTtlMs = config.fundTtlMs || 12 * 60 * 60 * 1000;   // fundamentals: 12h (spec)
  const techTtlMs = config.techTtlMs || 2 * 60 * 1000;         // technicals: 2min (spec)
  const newsTtlMs = config.newsTtlMs || 10 * 60 * 1000;        // news: 10min
  const llmTimeoutMs = config.llmTimeoutMs || DEFAULTS.llmTimeoutMs;
  const maxSchemaRetries = config.maxSchemaRetries ?? DEFAULTS.maxSchemaRetries;
  const fmpCallsPerFetch = config.fmpCallsPerFetch || 0;
  const providers = Array.isArray(llm) ? llm : (llm.providers || [llm]);

  const peekState = (key) => (typeof cache.peek === 'function' ? cache.peek(key) : 'miss');

  // Stage A — gather in parallel, each source cached at its own TTL (fundamentals 12h,
  // technicals 2min, news 10min). FMP fundamentals are the CORE source: on failure we
  // fail the pipeline (spec UC-5), rather than emit a report on fabricated-empty
  // fundamentals. Technicals and news degrade gracefully. `deep` mode also pulls peers.
  async function stageA(symbol, depth) {
    const deep = depth === 'deep';
    const fmpKey = `fmp:${symbol}`;
    const fmpWasMiss = peekState(fmpKey) === 'miss';
    const tasks = [
      cache.getOrLoad(fmpKey, fundTtlMs, () => fmp.getFundamentals(symbol, config.FMP_API_KEY)),
      cache.getOrLoad(`tech:${symbol}`, techTtlMs, () => techModule.computeTechnicals(symbol)),
      cache.getOrLoad(`news:${symbol}`, newsTtlMs, () => news.fetchNews(symbol)),
    ];
    let peersWasMiss = false;
    if (deep && typeof fmp.getPeers === 'function') {
      peersWasMiss = peekState(`peers:${symbol}`) === 'miss';
      tasks.push(cache.getOrLoad(`peers:${symbol}`, fundTtlMs, () => fmp.getPeers(symbol, config.FMP_API_KEY)));
    }
    const [f, t, n, pr] = await Promise.allSettled(tasks);
    if (f.status === 'rejected') {
      const e = f.reason instanceof Error ? f.reason : new Error(String(f.reason));
      if (!e.status) e.status = 503; // preserve upstream (e.g. 429) if present
      throw e;
    }
    let fmpCalls = fmpWasMiss ? fmpCallsPerFetch : 0;
    if (deep && peersWasMiss) fmpCalls += 1;
    return {
      fundamentals: f.value || {},
      tech: t.status === 'fulfilled' && t.value ? t.value : { available: false },
      news: n.status === 'fulfilled' && n.value ? n.value : [],
      peers: deep && pr && pr.status === 'fulfilled' ? pr.value : null,
      fmpCalls,
    };
  }

  // Stage B — narrative only: primary → fallback; stricter-prompt retry on schema fail.
  async function stageB(symbol, fundamentals, tech, newsItems, peers) {
    let lastErr;
    let retries = 0;
    for (const provider of providers) {
      let strict = '';
      for (let attempt = 0; attempt <= maxSchemaRetries; attempt++) {
        try {
          const prompt = buildPrompt(symbol, fundamentals, tech, newsItems, strict, peers);
          const obj = await withTimeout(provider.generate(prompt, LlmNarrativeSchema), llmTimeoutMs);
          const parsed = LlmNarrativeSchema.safeParse(obj);
          if (!parsed.success) { const e = new Error('schema validation failed'); e.kind = 'schema'; throw e; }
          // Strict structured-output allows empty arrays (the schema can't require
          // .min(1) without breaking OpenAI/Anthropic). Enforce the "must state
          // drivers/strengths/risks" contract here so an empty one RETRIES the
          // stricter prompt rather than serving a verdict with no support.
          const n = parsed.data;
          if (!n.recommendation.primaryDrivers.length || !n.strengthsRisks.strengths.length || !n.strengthsRisks.risks.length) {
            const e = new Error('schema: required narrative arrays are empty'); e.kind = 'schema'; throw e;
          }
          return { narrative: n, model: provider.name, retries };
        } catch (err) {
          lastErr = err;
          if (classifyError(err) === 'schema' && attempt < maxSchemaRetries) { strict = STRICT_NOTE; retries++; continue; }
          break;
        }
      }
    }
    const e = new Error(`LLM stage failed: ${(lastErr && lastErr.message) || 'no providers'}`);
    e.status = 503; e.cause = lastErr;
    throw e;
  }

  // Merge Stage-A numbers + Stage-B narrative into the doc-shaped 6-section report.
  function mergeReport(fundamentals, tech, narrative) {
    const profile = fundamentals.profile || {};
    const income = Array.isArray(fundamentals.income) ? fundamentals.income : [];
    const metrics = fundamentals.metrics || {};
    const q0 = income[0] || {};
    return {
      overview: {
        sector: profile.sector || '',
        mktCap: num(profile.mktCap),
        thesis: narrative.overview.thesis,
      },
      financials: {
        revenue: num(q0.revenue),
        eps: num(q0.eps),
        margins: num(q0.grossMargin),
        // fcf = total free cash flow. The documented fmp-client output exposes only
        // freeCashFlowPerShare (a per-share metric), which is NOT fcf — so we leave
        // this null until fmp-client is extended with a cash-flow-statement endpoint.
        fcf: num(fundamentals.cashFlow && fundamentals.cashFlow.freeCashFlow),
        trend: narrative.financials.trend,
        beatMiss: narrative.financials.beatMiss,
      },
      strengthsRisks: {
        strengths: narrative.strengthsRisks.strengths,
        risks: narrative.strengthsRisks.risks,
      },
      valuation: {
        ratios: {
          pe: num(metrics.peRatio), ps: num(metrics.priceToSalesRatio),
          evEbitda: num(metrics.evToEbitda), peg: num(metrics.pegRatio), pb: num(metrics.pbRatio),
        },
        vsSector: narrative.valuation.vsSector,
        vsHistory: narrative.valuation.vsHistory,
        assessment: narrative.valuation.assessment,
      },
      technical: {
        setup: tech.available ? narrative.technical.setup : 'unavailable',
        indicators: tech.available ? {
          rsi: tech.rsi, macd: tech.macd, movingAverages: tech.movingAverages,
          bollinger: tech.bollinger, cross: tech.cross, volume: tech.volume,
        } : {},
        keyLevels: tech.available && tech.pivots ? tech.pivots : {},
        available: tech.available === true,
      },
      recommendation: {
        verdict: narrative.recommendation.verdict, // may be overridden to HOLD below
        primaryDrivers: narrative.recommendation.primaryDrivers,
        invalidationConditions: narrative.recommendation.invalidationConditions,
        confidenceJustification: narrative.recommendation.confidenceJustification,
      },
    };
  }

  async function buildReport(ticker, mode, depth) {
    const tA = clock();
    const { fundamentals, tech, news: newsItems, peers, fmpCalls } = await stageA(ticker, depth);
    const stageAMs = clock() - tA;

    const tB = clock();
    const { narrative, model, retries } = await stageB(ticker, fundamentals, tech, newsItems, peers);
    const stageBMs = clock() - tB;

    const report = mergeReport(fundamentals, tech, narrative);
    const confidence = blendConfidence(fundamentals, tech);

    // Choice A: verdict LLM-owned; documented override only.
    let verdict = report.recommendation.verdict;
    if (confidence < 50) verdict = 'HOLD';
    report.recommendation.verdict = verdict;

    validateReport(report);

    const result = {
      ticker,
      generatedAt: now(),
      cacheHit: false,
      dataFreshness: { fundamentals: '12h', technicals: tech.available ? '2min' : 'unavailable' },
      verdict,
      confidence,
      report,
      disclaimer: DISCLAIMER,
    };
    // Non-public diagnostics for logging (analyst-routes.js strips this before res.json,
    // and does the single obs.log with path/totalMs). Do NOT obs.log here (double-count).
    result._diag = { stageAMs, stageBMs, fmpCalls, llmModel: model, llmRetries: retries };
    return result;
  }

  // Public entry (Doc 2 signature).
  async function report(ticker, mode = 'single', depth = 'standard', fresh = false) {
    const symbol = String(ticker || '').trim().toUpperCase();
    if (!symbol) { const e = new Error('ticker required'); e.status = 400; throw e; }
    const key = `analyst:${symbol}:${mode}:${depth}`;

    if (fresh) {
      const val = await buildReport(symbol, mode, depth);
      cache.set(key, val, reportTtlMs);
      return { ...val, cacheHit: false };
    }
    // Determine hit/miss from the cache state BEFORE loading. Stale entries are
    // served immediately (a hit from the caller's view) while revalidating in the
    // background, so both 'fresh' and 'stale' count as cacheHit:true.
    const state = typeof cache.peek === 'function' ? cache.peek(key) : 'miss';
    const val = await cache.getOrLoad(key, reportTtlMs, () => buildReport(symbol, mode, depth));
    return { ...val, cacheHit: state !== 'miss' };
  }

  // Comparison mode (M5): per-ticker reports in parallel + a second LLM ranking pass.
  // Single-ticker behavior is unchanged; each report() still gates on FMP as before.
  async function comparison(tickers, depth = 'standard', fresh = false) {
    const results = await Promise.all(tickers.map((t) => report(t, 'single', depth, fresh)));

    const summaries = results.map((r) => ({
      ticker: r.ticker,
      verdict: r.verdict,
      confidence: r.confidence,
      assessment: r.report && r.report.valuation && r.report.valuation.assessment,
      thesis: r.report && r.report.overview && r.report.overview.thesis,
    }));

    // Fallback ranking if the LLM pass fails: order by confidence desc.
    let rankedVerdict = {
      ranked: [...results].sort((a, b) => b.confidence - a.confidence).map((r) => r.ticker),
      rationale: 'Ranked by model confidence; see individual reports.',
    };

    const prompt = [
      'Rank these equity analyses from best to worst investment opportunity and explain in 1-2 sentences why.',
      'Return ONLY the structured fields: ranked (tickers best→worst) and a rationale string.',
      JSON.stringify(summaries),
    ].join('\n\n');

    for (const provider of providers) {
      try {
        const obj = await withTimeout(provider.generate(prompt, ComparisonRankSchema), llmTimeoutMs);
        const parsed = ComparisonRankSchema.safeParse(obj);
        if (parsed.success) { rankedVerdict = parsed.data; break; }
      } catch (_) { /* try next provider, else keep confidence-sorted fallback */ }
    }

    return { mode: 'comparison', results, rankedVerdict };
  }

  return { report, comparison };
}

module.exports = { createAnalystService, validateReport, blendConfidence, buildPrompt };
