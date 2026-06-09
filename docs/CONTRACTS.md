# Interface Contracts — read before writing any module

All modules code against THESE shapes. Do not change a shape without updating this file.

## Candle object (canonical everywhere)

```js
{ time: <unix seconds, integer>, open: number, high: number, low: number, close: number, volume: number }
```
- `candles` is always an array sorted ascending by `time`.
- The LAST element is the most recent (possibly still-forming) candle.

---

## engine/indicators.js — exports (CommonJS `module.exports`)

```js
ema(candles, period)            -> [{ time, value }]      // EMA series, same length as candles
rsi(candles, period=14)         -> number                  // latest RSI (0..100)
rsiSeries(candles, period=14)   -> [{ time, value }]
macd(candles, fast=12, slow=26, signal=9)
    -> { macd:number, signal:number, hist:number,         // latest values
         series:{ macd:[{time,value}], signal:[...], hist:[...] } }
bollinger(candles, period=20, mult=2)
    -> { upper:[{time,value}], mid:[{time,value}], lower:[{time,value}],
         last:{ upper, mid, lower } }
atr(candles, period=14)         -> number                  // latest ATR
vwap(candles)                   -> number                  // session VWAP (cumulative)
avgVolume(candles, n=20)        -> number
```
Return `NaN`/`null` safely when not enough data; never throw on short arrays.

## engine/patterns.js — exports

```js
detectPatterns(candles) -> [
  { name:string, meaning:string, signal:'buy'|'sell'|'wait', strength:1|2|3 }
]
```
- Inspect the last up-to-3 candles. `strength` = rough conviction (3 = strongest).
- If none match, return a single `{ name:'No strong pattern', ..., signal:'wait', strength:1 }`.
- Also export helpers: `body(c) range(c) upperWick(c) lowerWick(c) isBull(c) isBear(c)`.

## engine/scorer.js — exports

```js
score({ candles, indicators, patterns }) -> {
  score: number,        // 0..100
  confidence: number,   // 0..100
  signal: 'BUY'|'SELL'|'WAIT',
  signalLabel: string,  // 'BUY WATCH' | 'SELL / AVOID' | 'WAIT'
  reasons: string[],    // human-readable, max ~6
  levels: { buyTrigger:number, stopLoss:number, sellTarget:number }
}
```
`indicators` arg shape (precomputed by index.js):
`{ rsi, ema9, ema20, ema50, macd:{macd,signal,hist}, bb:{upper,mid,lower}, atr, vwap, volRatio }`
(ema9/20/50 are latest numeric values; volRatio = lastVolume / avgVolume).

## engine/index.js — facade

```js
analyze(candles) -> {
  price: number,
  dayRange: { low:number, high:number },
  signal, signalLabel, score, confidence, reasons, levels,   // from scorer
  indicators: { rsi, ema9, ema20, ema50, macd:{macd,signal,hist},
                bb:{upper,mid,lower}, atr, vwap, volRatio },
  patterns: [{ name, meaning, signal, strength }],
  overlays: {                                                // for charting
    ema9:[{time,value}], ema20:[{time,value}], ema50:[{time,value}],
    bbUpper:[{time,value}], bbMid:[{time,value}], bbLower:[{time,value}]
  }
}
```
Requires >= 2 candles; with very few candles, fill what's possible and default signal 'WAIT'.

---

## Browser <-> Server WebSocket protocol (path `/stream`)

The chart view is an INTERVAL (candle size) + RANGE (lookback):
- interval: `1m | 5m | 15m | 30m | 1h | 1D | 1W`
- range:    `1D | 5D | 1M | 3M | 6M | YTD | 1Y | 5Y | MAX`
The server clamps the range to what the interval allows (e.g. `1m` → max ~5D) and
returns the effective `range` in the snapshot.

Messages are JSON. Client → Server:
```js
{ type:'subscribe', symbol:'MRVL', interval:'5m', range:'1D' }
{ type:'unsubscribe' }
{ type:'setView', interval:'15m', range:'1M' }        // change interval and/or range
{ type:'simulate', on:true }                           // force simulated candles
```
Server → Client:
```js
{ type:'snapshot', symbol, interval, range, candles:[...], analysis:{...},
  mode:'live'|'simulated'|'closed', marketOpen:boolean }  // range may be clamped
{ type:'candle', candle:{...}, closed:boolean }       // closed=false updates last; true appends
{ type:'analysis', analysis:{...} }                   // recomputed analysis object
{ type:'status', connected:boolean, marketOpen:boolean,
  mode:'live'|'simulated'|'closed', message:string }
{ type:'error', message:string }
```

## REST routes

```
GET /api/search?q=<text>   -> [{ symbol, description }]      (proxy Finnhub /search; mock list if no key)
GET /api/quote/:symbol     -> { c, h, l, o, pc }              (proxy Finnhub /quote; mock if no key)
GET /api/news/:symbol      -> [{ headline, source, url, datetime, summary, image }]
                             (Finnhub company-news w/ key; Yahoo news fallback)
GET /api/price/:symbol     -> { price, prevClose }   (Yahoo, real, no key; values portfolio)
GET /api/health            -> { ok:true, mode, hasKey }
```

## Personalized positions (client-side)

Positions live in the browser (`localStorage` key `csd_portfolio_v1`) as
`[{ symbol, shares, cost }]` where `cost` is the buy price per share and
`shares = amountInvested / cost`. P/L and a position-aware recommendation
(HOLD / SELL-TRIM / BUY-more / TAKE-PROFIT / CUT-LOSS) are computed in the
browser from the live analysis (signal + levels) and the user's entry. No server
storage / auth.

Candles come from Yahoo Finance (`src/yahoo-client.js`) — real OHLCV, no key needed.

## Env (`.env`)

```
FINNHUB_API_KEY=         # empty => simulated mode
PORT=3000
```
