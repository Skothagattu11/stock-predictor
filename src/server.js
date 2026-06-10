'use strict';

// Main entry: Express (static + REST) + ws WebSocketServer on /stream.
// Per-connection: one active subscription, mode-selected (live vs simulated).

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const config = require('./config');
const proto = require('./ws-protocol');
const { isMarketOpen, marketSession } = require('./market-hours');
const { CandleAggregator } = require('./candle-aggregator');
const simulator = require('./simulator');
const yahoo = require('./yahoo-client');
const { FinnhubClient } = require('./finnhub-client');
const { createRouter } = require('./rest-routes');
const { analyze } = require('../engine');

const SIM_INTERVAL_MS = 2000; // simulated candle push cadence
const ANALYSIS_THROTTLE_MS = 1000; // max 1 analysis recompute per second
const SEED_COUNT = 60; // initial sim candles to seed live mode chart
const REAL_REFRESH_MS = 12000; // how often to re-pull real intraday candles (live)
const QUOTE_POLL_MS = 5000; // live US-stock price poll cadence
// Finnhub free tier does NOT stream US-stock trades over WebSocket (paid only),
// but the /quote REST endpoint IS real-time and free. So live stock mode is
// driven by polling /quote. Free /quote has no intraday volume, so we attach an
// approximate per-poll volume purely so the chart's volume pane isn't empty.
const POLL_SYNTH_VOLUME = 15000;

// ---- Shared Finnhub client + reference-counted symbol subscriptions -------

const finnhub = new FinnhubClient(config.FINNHUB_API_KEY);
const symbolRefs = new Map(); // symbol -> count

finnhub.on('error', (err) => {
  // Never crash on upstream errors; just log.
  console.error('[finnhub] error:', err && err.message ? err.message : err);
});
finnhub.on('open', () => console.log('[finnhub] upstream connected'));
finnhub.on('close', () => console.log('[finnhub] upstream closed'));

if (config.hasKey) finnhub.connect();

function refSubscribe(symbol) {
  const n = (symbolRefs.get(symbol) || 0) + 1;
  symbolRefs.set(symbol, n);
  if (n === 1) finnhub.subscribe(symbol);
}

function refUnsubscribe(symbol) {
  if (!symbolRefs.has(symbol)) return;
  const n = symbolRefs.get(symbol) - 1;
  if (n <= 0) {
    symbolRefs.delete(symbol);
    finnhub.unsubscribe(symbol);
  } else {
    symbolRefs.set(symbol, n);
  }
}

// Fetch the real current price so seeded candles start near reality (Finnhub
// free tier has no historical candles, so we seed around the live quote and let
// real ticks extend the series). Returns null when no key / fetch fails.
async function fetchQuote(symbol) {
  if (!config.hasKey) return null;
  try {
    const url =
      'https://finnhub.io/api/v1/quote?symbol=' +
      encodeURIComponent(symbol) +
      '&token=' +
      config.FINNHUB_API_KEY;
    const res = await fetch(url);
    if (!res.ok) return null;
    const q = await res.json();
    return q && typeof q.c === 'number' && q.c > 0 ? q : null;
  } catch (_) {
    return null;
  }
}

async function fetchSeedPrice(symbol) {
  const q = await fetchQuote(symbol);
  return q ? q.c : null;
}

// ---- HTTP / Express -------------------------------------------------------

const app = express();
app.set('trust proxy', true); // correct client IP behind Render's proxy (rate limiting)
app.use(express.json({ limit: '64kb' })); // cap request body size
app.use('/api', createRouter());
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/stream' });

// ---- Per-connection session ----------------------------------------------

function safeSend(ws, obj) {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(obj));
  } catch (err) {
    console.error('[ws] send failed:', err && err.message);
  }
}

/**
 * Decide mode for a (symbol, forceSim) request.
 *  - live      : have key AND market open AND not forced sim
 *  - closed    : have key, market closed, not forced sim (use simulator engine)
 *  - simulated : no key, OR client forced simulate
 */
function chooseMode(forceSim) {
  if (forceSim) return proto.MODE.SIMULATED;
  if (config.hasKey && isMarketOpen()) return proto.MODE.LIVE;
  if (config.hasKey) return proto.MODE.CLOSED;
  return proto.MODE.SIMULATED;
}

wss.on('connection', (ws) => {
  // Mutable per-connection session state.
  const session = {
    symbol: null,
    interval: '5m',
    range: '1D',
    mode: null,
    forceSim: false,
    aggregator: null,
    simTimer: null,
    quoteTimer: null,
    priceTimer: null,
    lastAnalysisAt: 0,
    tradeHandler: null,
    subscribedSymbol: null, // symbol we hold a live ref for
  };

  function teardown() {
    if (session.simTimer) {
      clearInterval(session.simTimer);
      session.simTimer = null;
    }
    if (session.quoteTimer) {
      clearInterval(session.quoteTimer);
      session.quoteTimer = null;
    }
    if (session.priceTimer) {
      clearInterval(session.priceTimer);
      session.priceTimer = null;
    }
    if (session.tradeHandler) {
      finnhub.off('trade', session.tradeHandler);
      session.tradeHandler = null;
    }
    if (session.subscribedSymbol) {
      refUnsubscribe(session.subscribedSymbol);
      session.subscribedSymbol = null;
    }
    session.aggregator = null;
  }

  // Recompute analysis at most ~1/sec; force=true bypasses throttle.
  function maybeSendAnalysis(candles, force) {
    const now = Date.now();
    if (!force && now - session.lastAnalysisAt < ANALYSIS_THROTTLE_MS) return;
    session.lastAnalysisAt = now;
    try {
      const a = analyze(candles, { intraday: yahoo.isIntraday(session.interval) });
      safeSend(ws, proto.analysis(a));
    } catch (err) {
      safeSend(ws, proto.error('Analysis failed: ' + (err && err.message)));
    }
  }

  function startSafe(symbol, interval, range, forceSim) {
    start(symbol, interval, range, forceSim).catch((err) =>
      safeSend(ws, proto.error('Start failed: ' + (err && err.message)))
    );
  }

  async function start(symbol, interval, range, forceSim) {
    teardown();
    interval = yahoo.normInterval(interval);
    range = yahoo.normRange(range);
    session.symbol = symbol;
    session.interval = interval;
    session.range = range;
    session.forceSim = Boolean(forceSim);
    const tfMinutes = intervalToMinutes(interval);
    session.aggregator = new CandleAggregator(tfMinutes);

    const marketOpen = isMarketOpen();
    const intraday = yahoo.isIntraday(interval);
    // session was re-targeted while awaiting? bail helper.
    const stale = () => session.symbol !== symbol || session.interval !== interval || session.range !== range;

    let analysisObj;
    let candles;
    let effRange = range;

    // PRIMARY SOURCE: real OHLCV candles from Yahoo Finance (no key needed).
    // Pattern detection / signals MUST run on real candles. The simulator is
    // only a fallback when the real fetch fails or sim is forced.
    let usedReal = false;
    if (!session.forceSim) {
      try {
        const real = await yahoo.fetchCandles(symbol, interval, range);
        if (stale()) return;
        if (real && real.candles.length >= 5) {
          effRange = real.effRange || range;
          session.aggregator.seed(real.candles);
          candles = real.candles;
          usedReal = true;
        }
      } catch (err) {
        console.error('[yahoo] candle fetch failed for ' + symbol + ':', err && err.message);
      }
    }

    if (usedReal) {
      session.connected = true;
      const clampNote = effRange !== range ? ' (range adjusted to ' + effRange + ' for ' + interval + ')' : '';
      const sess = marketSession(); // 'open' | 'pre' | 'after' | 'closed'
      if (intraday) {
        if (sess === 'closed') {
          session.mode = proto.MODE.CLOSED;
          session.statusMsg = 'Market closed — real ' + interval + ' candles (last session); auto-resumes at next open.' + clampNote;
        } else {
          session.mode = proto.MODE.LIVE;
          const label = sess === 'open' ? 'market open'
            : (sess === 'pre' ? 'pre-market (extended hours)' : 'after-hours (extended)');
          session.statusMsg = 'Live — ' + label + ' · real ' + interval + ' candles' + clampNote;
        }
      } else {
        session.mode = proto.MODE.LIVE;
        session.statusMsg = 'Real ' + interval + ' candles · ' + effRange + ' (auto-refresh)' + clampNote;
      }
      // Refresh fast while trades can flow (regular OR extended hours); slower
      // overnight/weekends, but keep polling so it resumes the moment trading reopens.
      const refreshMs = intraday ? (sess === 'closed' ? 60000 : REAL_REFRESH_MS) : 60000;

      // Re-pull real candles periodically; merge the latest/new bars into chart.
      const refresh = async () => {
        try {
          const real = await yahoo.fetchCandles(session.symbol, session.interval, session.range);
          if (stale() || !real || !real.candles.length) return;
          const prev = session.aggregator.getCandles();
          const lastPrevTime = prev.length ? prev[prev.length - 1].time : 0;
          session.aggregator.seed(real.candles);
          for (const c of real.candles) {
            if (c.time >= lastPrevTime) {
              safeSend(ws, proto.candle(c, c.time > lastPrevTime));
            }
          }
          maybeSendAnalysis(real.candles, true);
        } catch (err) {
          safeSend(ws, proto.status({
            connected: true, marketOpen: isMarketOpen(), mode: session.mode,
            message: 'Refresh failed, retrying… (' + (err && err.message) + ')',
          }));
        }
      };
      session.quoteTimer = setInterval(refresh, refreshMs);

      // Faster near-real-time tick: while trading, poll just the current price
      // (~5s) and nudge the forming candle's close/high/low between full fetches.
      if (sess !== 'closed') {
        const fastPrice = async () => {
          try {
            const q = await yahoo.fetchPrice(session.symbol);
            if (stale() || !q || !Number.isFinite(q.price)) return;
            const arr = session.aggregator.getCandles();
            if (!arr.length) return;
            const lastC = arr[arr.length - 1];
            lastC.close = q.price;
            if (q.price > lastC.high) lastC.high = q.price;
            if (q.price < lastC.low) lastC.low = q.price;
            session.aggregator.seed(arr);
            safeSend(ws, proto.candle(lastC, false));
            maybeSendAnalysis(arr, false);
          } catch (_) { /* ignore transient price errors */ }
        };
        session.priceTimer = setInterval(fastPrice, 5000);
      }
    } else {
      // FALLBACK: simulator (real data unavailable, or user forced simulate).
      session.mode = session.forceSim
        ? proto.MODE.SIMULATED
        : (marketOpen ? proto.MODE.SIMULATED : proto.MODE.CLOSED);
      session.connected = true;
      session.statusMsg = session.forceSim
        ? 'Simulated mode (forced)'
        : 'Live data unavailable — showing simulated candles';
      const seedPrice = (await fetchSeedPrice(symbol)) || 200;
      if (stale()) return;
      candles = simulator.generateCandles(tfMinutes, 120, seedPrice);
      session.aggregator.seed(candles);

      session.simTimer = setInterval(() => {
        try {
          const prev = session.aggregator.getCandles();
          const next = simulator.nextSimCandle(prev, tfMinutes);
          const last = prev[prev.length - 1];
          const closed = !last || next.time > last.time;
          if (closed) { prev.push(next); } else { prev[prev.length - 1] = next; }
          session.aggregator.seed(prev);
          safeSend(ws, proto.candle(next, closed));
          maybeSendAnalysis(session.aggregator.getCandles(), false);
        } catch (err) {
          safeSend(ws, proto.error('Simulation failed: ' + (err && err.message)));
        }
      }, SIM_INTERVAL_MS);
    }

    try {
      analysisObj = analyze(candles, { intraday });
    } catch (err) {
      analysisObj = null;
      safeSend(ws, proto.error('Initial analysis failed: ' + (err && err.message)));
    }

    // Initial snapshot + status.
    safeSend(
      ws,
      proto.snapshot({
        symbol,
        interval,
        range: effRange,
        candles,
        analysis: analysisObj,
        mode: session.mode,
        marketOpen,
      })
    );
    safeSend(
      ws,
      proto.status({
        connected: session.connected !== false,
        marketOpen,
        mode: session.mode,
        message: session.statusMsg || statusMessage(session.mode, marketOpen),
      })
    );
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      safeSend(ws, proto.error('Invalid JSON message'));
      return;
    }
    try {
      handleClientMessage(msg);
    } catch (err) {
      safeSend(ws, proto.error('Server error: ' + (err && err.message)));
    }
  });

  function handleClientMessage(msg) {
    if (!msg || typeof msg !== 'object') {
      safeSend(ws, proto.error('Malformed message'));
      return;
    }
    switch (msg.type) {
      case proto.C2S.SUBSCRIBE: {
        const symbol = String(msg.symbol || '').trim().toUpperCase();
        const interval = yahoo.normInterval(msg.interval);
        const range = yahoo.normRange(msg.range);
        if (!symbol) {
          safeSend(ws, proto.error('subscribe requires a symbol'));
          return;
        }
        startSafe(symbol, interval, range, session.forceSim);
        break;
      }
      case proto.C2S.SET_VIEW: {
        if (!session.symbol) {
          safeSend(ws, proto.error('setView before subscribe'));
          return;
        }
        const interval = yahoo.normInterval(msg.interval != null ? msg.interval : session.interval);
        const range = yahoo.normRange(msg.range != null ? msg.range : session.range);
        startSafe(session.symbol, interval, range, session.forceSim);
        break;
      }
      case proto.C2S.SIMULATE: {
        session.forceSim = Boolean(msg.on);
        if (session.symbol) {
          startSafe(session.symbol, session.interval, session.range, session.forceSim);
        }
        break;
      }
      case proto.C2S.UNSUBSCRIBE: {
        teardown();
        session.symbol = null;
        safeSend(
          ws,
          proto.status({
            connected: false,
            marketOpen: isMarketOpen(),
            mode: session.mode,
            message: 'Unsubscribed',
          })
        );
        break;
      }
      default:
        safeSend(ws, proto.error('Unknown message type: ' + msg.type));
    }
  }

  ws.on('close', teardown);
  ws.on('error', (err) => {
    console.error('[ws] connection error:', err && err.message);
    teardown();
  });
});

function statusMessage(mode, marketOpen) {
  if (mode === proto.MODE.LIVE) return 'Live — real-time Finnhub quote (~5s)';
  if (mode === proto.MODE.CLOSED) return 'Market closed — showing simulated candles';
  return marketOpen ? 'Simulated mode' : 'Market closed — simulated mode';
}

// Representative bucket size (minutes) per interval — only used by the simulator
// fallback and the candle store; real candles come pre-bucketed from Yahoo.
function intervalToMinutes(interval) {
  switch (interval) {
    case '1m': return 1;
    case '5m': return 5;
    case '15m': return 15;
    case '30m': return 30;
    case '1h': return 60;
    case '1D': return 1440;
    case '1W': return 1440 * 7;
    default: return 5;
  }
}

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(
      `\n✗ Port ${config.PORT} is already in use.\n` +
        `  Another process (maybe a previous run of this server) is holding it.\n` +
        `  Fix it one of these ways:\n` +
        `    • Set a different port:  PORT=3200 npm start   (or edit PORT in .env)\n` +
        `    • Free the port (PowerShell):\n` +
        `        Get-NetTCPConnection -LocalPort ${config.PORT} -State Listen | ` +
        `Select-Object -Expand OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }\n`
    );
    process.exit(1);
  }
  console.error('[server] error:', err && err.message ? err.message : err);
  process.exit(1);
});

server.listen(config.PORT, () => {
  const mode = config.hasKey ? 'live-capable' : 'simulated (no API key)';
  console.log(`Candle Signal Dashboard listening on http://localhost:${config.PORT}  [${mode}]`);
});

module.exports = { app, server, wss };
