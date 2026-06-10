/* Live Candle Pattern Signal Dashboard — browser frontend.
 * Talks to the server over the /stream WebSocket and the REST search route.
 * No build step; vanilla JS. Analysis is computed server-side (see docs/CONTRACTS.md).
 */
(function () {
  'use strict';

  // ---------- State ----------
  var state = {
    symbol: 'MRVL',
    interval: '5m',   // candle size / live-update granularity
    range: '1D',      // how much history
    chartType: 'candles',
    simulate: false,
    candles: [],
    lastSignalLabel: null
  };

  // Intraday intervals get time-of-day axis labels; daily/weekly get dates.
  function isIntradayInterval(i) {
    return i === '1m' || i === '5m' || i === '15m' || i === '30m' || i === '1h';
  }

  // ---------- Chart setup (mirrors the reference, plus extra overlays) ----------
  // Lightweight Charts renders timestamps in UTC and has no built-in timezone
  // support, so we format axis ticks + crosshair in the BROWSER's local timezone.
  // (candle.time is a UTC unix-seconds value, so new Date(ts*1000) is the correct
  // moment; toLocale* then renders it in whatever timezone the user is in.)
  // Axis ticks: time-of-day for intraday periods, calendar dates for longer ones.
  function localTick(ts) {
    var d = new Date(ts * 1000);
    return isIntradayInterval(state.interval)
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  // Crosshair label: include date + time intraday, full date otherwise.
  function localCrosshair(ts) {
    var d = new Date(ts * 1000);
    return isIntradayInterval(state.interval)
      ? d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  }

  var chart = LightweightCharts.createChart(document.getElementById('chart'), {
    autoSize: true, // track the container's CSS width/height (incl. the taller #chart)
    layout: { background: { color: '#0b1220' }, textColor: '#cbd7e8' },
    grid: { vertLines: { color: '#18243a' }, horzLines: { color: '#18243a' } },
    rightPriceScale: {
      borderColor: '#253653',
      autoScale: true,           // tighten to the visible data (denser ticks as you zoom)
      ticksVisible: true,
      // Price uses the top ~80%; the bottom 20% is reserved for the volume pane
      // (contiguous with the volume scale margins below). Less empty padding ->
      // denser, more detailed price labels.
      scaleMargins: { top: 0.05, bottom: 0.2 }
    },
    localization: {
      timeFormatter: localCrosshair, // crosshair / tooltip label
      // Show 2-decimal prices in the crosshair label so detail isn't lost.
      priceFormatter: function (p) { return Number.isFinite(p) ? p.toFixed(2) : ''; }
    },
    timeScale: {
      borderColor: '#253653',
      timeVisible: true,
      secondsVisible: false,
      tickMarkFormatter: function (ts) { return localTick(ts); } // x-axis labels
    },
    crosshair: { mode: 1 },
    // Keep the price axis in AUTO mode so it always expands/shrinks to fit the
    // visible candles as you zoom/scroll. (Dragging the price axis would switch
    // it to manual and freeze the scale — so we disable price-axis drag.)
    handleScale: { axisPressedMouseMove: { time: true, price: false }, mouseWheel: true, pinch: true },
    handleScroll: true
  });

  // 2-decimal price format -> the Y-axis can render fine, $0.01-granular labels.
  var PRICE_FMT = { type: 'price', precision: 2, minMove: 0.01 };

  var candleSeries = chart.addCandlestickSeries({
    upColor: '#2fd17c', downColor: '#ff5c6c',
    borderUpColor: '#2fd17c', borderDownColor: '#ff5c6c',
    wickUpColor: '#2fd17c', wickDownColor: '#ff5c6c',
    priceFormat: PRICE_FMT
  });

  // Line view (close price) — toggled with candles via the Chart-style select.
  var lineSeries = chart.addLineSeries({
    color: '#7fd0ff', lineWidth: 2, priceLineVisible: false, lastValueVisible: true, visible: false,
    priceFormat: PRICE_FMT
  });

  function applyChartType() {
    var line = state.chartType === 'line';
    candleSeries.applyOptions({ visible: !line });
    lineSeries.applyOptions({ visible: line });
    // Legend: show candle up/down in candles mode, the close swatch in line mode.
    var up = $('lgUp'), down = $('lgDown'), close = $('lgClose');
    if (up) up.style.display = line ? 'none' : '';
    if (down) down.style.display = line ? 'none' : '';
    if (close) close.style.display = line ? '' : 'none';
    try { chart.timeScale().fitContent(); } catch (e) {}
  }

  // EMA overlays
  var ema9Series = chart.addLineSeries({ color: '#5aa7ff', lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
  var ema20Series = chart.addLineSeries({ color: '#ffbf47', lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
  var ema50Series = chart.addLineSeries({ color: 'rgba(179,136,255,.7)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
  // Bollinger bands (lighter)
  var bbUpperSeries = chart.addLineSeries({ color: 'rgba(149,163,184,.55)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, lineStyle: 2 });
  var bbLowerSeries = chart.addLineSeries({ color: 'rgba(149,163,184,.55)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, lineStyle: 2 });
  // Intraday overlays: session VWAP (white dashed reference line) + Supertrend (teal)
  var vwapSeries = chart.addLineSeries({ color: '#f2f5fb', lineWidth: 2, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });
  var stSeries = chart.addLineSeries({ color: '#36d1c4', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });

  // Volume histogram on its own (hidden) price scale at the bottom
  var volumeSeries = chart.addHistogramSeries({
    priceFormat: { type: 'volume' },
    priceScaleId: '',
    color: 'rgba(90,167,255,.4)'
  });
  volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

  // autoSize:true (above) makes the chart follow the container via ResizeObserver,
  // so no manual width/height handling is needed.

  // ---------- DOM helpers ----------
  function $(id) { return document.getElementById(id); }
  function setText(id, v) { var el = $(id); if (el) el.textContent = v; }
  function fmt(n, d) { return (n === null || n === undefined || isNaN(n)) ? '--' : Number(n).toFixed(d === undefined ? 2 : d); }
  function money(n) { return (n === null || n === undefined || isNaN(n)) ? '--' : '$' + Number(n).toFixed(2); }

  function volColor(c) {
    return c.close >= c.open ? 'rgba(47,209,124,.45)' : 'rgba(255,92,108,.45)';
  }

  // ---------- Rendering ----------
  function setCandles(candles) {
    state.candles = candles || [];
    candleSeries.setData(state.candles);
    lineSeries.setData(state.candles.map(function (c) {
      return { time: c.time, value: c.close };
    }));
    volumeSeries.setData(state.candles.map(function (c) {
      return { time: c.time, value: c.volume, color: volColor(c) };
    }));
  }

  // Drop any non-finite points so a stray NaN/null can't drag the price scale.
  function finite(arr) {
    return (arr || []).filter(function (p) { return p && Number.isFinite(p.value); });
  }

  function setOverlays(overlays) {
    if (!overlays) return;
    ema9Series.setData(finite(overlays.ema9));
    ema20Series.setData(finite(overlays.ema20));
    ema50Series.setData(finite(overlays.ema50));
    bbUpperSeries.setData(finite(overlays.bbUpper));
    bbLowerSeries.setData(finite(overlays.bbLower));
    // Intraday-only overlays (empty in swing mode).
    var vwapPts = finite(overlays.vwap);
    var stPts = finite(overlays.supertrend);
    var hasVwap = vwapPts.length > 0;
    var hasSt = stPts.length > 0;
    vwapSeries.setData(vwapPts);
    stSeries.setData(stPts);
    var lgV = $('lgVwap'), lgS = $('lgSt');
    if (lgV) lgV.style.display = hasVwap ? '' : 'none';
    if (lgS) lgS.style.display = hasSt ? '' : 'none';
  }

  // Map analysis.signal -> css class buy/sell/wait
  function signalClass(signal) {
    if (signal === 'BUY') return 'buy';
    if (signal === 'SELL') return 'sell';
    return 'wait';
  }

  function render(analysis) {
    if (!analysis) return;

    // Generic market read (the stock's signal).
    var mktCls = signalClass(analysis.signal);
    var mktLabel = analysis.signalLabel || analysis.signal || 'WAIT';

    // If you hold this ticker, the HEADLINE becomes your personalized call
    // (HOLD / SELL / TAKE-PROFIT…) and the market read drops to a sub-line.
    var pos = getPosition(state.symbol);
    var personal = pos && pos.cost > 0 && Number.isFinite(analysis.price);
    var headLabel, headCls, headReason, modeText, subText, headReasons;
    if (personal) {
      var rec = computeRecommendation(analysis, pos);
      headLabel = rec.action;
      headCls = rec.cls;
      headReasons = rec.reasons;
      headReason = rec.reasons[0] || '';
      modeText = 'Your position — ' + state.symbol + ' · what to do with your shares';
      subText = 'Market signal: ' + mktLabel + ' · ' + (analysis.score | 0) + '/100';
    } else {
      headLabel = mktLabel;
      headCls = mktCls;
      headReasons = analysis.reasons || [];
      headReason = headReasons[0] || 'Waiting for stronger confirmation.';
      modeText = analysis.mode === 'intraday'
        ? 'Intraday signal — VWAP · Supertrend · ORB confluence'
        : 'Overall signal — chart patterns + indicators';
      subText = analysis.mode === 'intraday' ? (analysis.setup || '') : '';
    }

    // signal box (headline)
    var box = $('signalBox');
    box.className = 'signalBox ' + headCls;
    setText('signalMode', modeText);
    setText('signalMain', headLabel);
    $('scoreBar').style.width = Math.max(0, Math.min(100, analysis.score || 0)) + '%';
    setText('signalText', headReason);
    var setupEl = $('setupTag');
    if (setupEl) {
      if (subText) { setupEl.textContent = subText; setupEl.classList.remove('hidden'); }
      else setupEl.classList.add('hidden');
    }

    // KPIs (the "Current signal" KPI always shows the generic market read)
    setText('price', money(analysis.price));
    if (analysis.dayRange) {
      setText('range', money(analysis.dayRange.low) + '–' + money(analysis.dayRange.high));
    }
    var kpi = $('signalKpi');
    kpi.textContent = mktLabel;
    kpi.className = mktCls === 'buy' ? 'green' : mktCls === 'sell' ? 'red' : 'amber';
    setText('confKpi', (analysis.confidence === undefined || analysis.confidence === null) ? '--%' : Math.round(analysis.confidence) + '%');

    // reasons (headline's reasons)
    $('reasons').innerHTML = headReasons.slice(0, 6).map(function (r) {
      return '<div>' + escapeHtml(r) + '</div>';
    }).join('');

    // levels
    if (analysis.levels) {
      setText('buyTrigger', money(analysis.levels.buyTrigger));
      setText('stopLoss', money(analysis.levels.stopLoss));
      setText('sellTarget', money(analysis.levels.sellTarget));
    }

    // indicator snapshot
    var ind = analysis.indicators || {};
    setText('rsi', fmt(ind.rsi, 1));
    setText('ema', fmt(ind.ema9) + ' / ' + fmt(ind.ema20) + ' / ' + fmt(ind.ema50));
    setText('vol', (ind.volRatio === undefined || isNaN(ind.volRatio)) ? '--' : fmt(ind.volRatio) + 'x avg');
    if (ind.macd) {
      setText('macd', fmt(ind.macd.macd) + ' / ' + fmt(ind.macd.signal) + ' (' + fmt(ind.macd.hist) + ')');
    } else {
      setText('macd', '--');
    }
    setText('atr', fmt(ind.atr));
    setText('vwap', money(ind.vwap));
    if (ind.bb) {
      setText('bb', fmt(ind.bb.lower) + ' / ' + fmt(ind.bb.mid) + ' / ' + fmt(ind.bb.upper));
    } else {
      setText('bb', '--');
    }

    // Intraday-specific snapshot fields (headline/mode are set above).
    if (analysis.mode === 'intraday') {
      var it = analysis.intraday || {};
      if (Number.isFinite(ind.vwap) && Number.isFinite(analysis.price)) {
        setText('vwapPos', analysis.price >= ind.vwap ? 'Above (bullish)' : 'Below (bearish)');
      } else setText('vwapPos', '--');
      if (it.supertrend && it.supertrend.trend) {
        setText('stTrend', (it.supertrend.trend === 'up' ? 'Up' : 'Down') + (it.supertrend.flipped ? ' (just flipped)' : ''));
      } else setText('stTrend', '--');
      if (it.openingRange && isFinite(it.openingRange.low) && isFinite(it.openingRange.high)) {
        setText('orbRange', money(it.openingRange.low) + ' – ' + money(it.openingRange.high));
      } else setText('orbRange', '--');
    } else {
      setText('vwapPos', '--'); setText('stTrend', '--'); setText('orbRange', '--');
    }

    // patterns table
    var pats = analysis.patterns || [];
    $('patterns').innerHTML = pats.map(function (p) {
      var sig = (p.signal || 'wait').toLowerCase();
      return '<tr><td>' + escapeHtml(p.name) + '</td><td>' + escapeHtml(p.meaning) +
        '</td><td><span class="badge ' + sig + '">' + sig.toUpperCase() + '</span></td></tr>';
    }).join('');

    // signal history — log ONLY when the headline call actually changes
    // (not every tick), so it's a calm record of real recommendation changes.
    if (headLabel !== state.lastSignalLabel) {
      if (state.lastSignalLabel !== null) {
        addHistory(headLabel, headCls);
      }
      state.lastSignalLabel = headLabel;
    }

    // personalized position tracking uses the latest analysis + live price
    state.lastAnalysis = analysis;
    if (isFinite(analysis.price)) priceMap[state.symbol] = analysis.price;
    renderPositionCard();
    renderPortfolio();
  }

  function addHistory(label, cls) {
    var log = $('history');
    var empty = log.querySelector('.empty');
    if (empty) empty.remove();
    var ts = new Date().toLocaleTimeString();
    var row = document.createElement('div');
    row.className = 'hrow';
    row.innerHTML = '<span class="ts">' + ts + '</span><span><span class="badge ' + cls + '">' +
      escapeHtml(label) + '</span> &nbsp;' + escapeHtml(state.symbol) + '</span>';
    log.insertBefore(row, log.firstChild);
    // cap history length
    while (log.children.length > 50) log.removeChild(log.lastChild);
  }

  function escapeHtml(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---------- Badges ----------
  function setConnBadge(connected) {
    var b = $('connBadge');
    b.className = 'pill ' + (connected ? 'ok' : 'bad');
    b.innerHTML = '<span class="dot"></span>' + (connected ? 'Connected' : 'Disconnected');
  }

  function setModeBadge(mode) {
    var b = $('modeBadge');
    var cls = 'sim', text = 'Simulated';
    if (mode === 'live') { cls = 'live'; text = 'Live'; }
    else if (mode === 'closed') { cls = 'closed'; text = 'Market closed'; }
    else { cls = 'sim'; text = 'Simulated'; }
    b.className = 'pill ' + cls;
    b.innerHTML = '<span class="dot"></span>' + text;
  }

  // ---------- Error banner (non-blocking) ----------
  var bannerTimer = null;
  function showBanner(msg) {
    var el = $('errorBanner');
    el.textContent = msg;
    el.classList.remove('hidden');
    if (bannerTimer) clearTimeout(bannerTimer);
    bannerTimer = setTimeout(function () { el.classList.add('hidden'); }, 6000);
  }

  // ---------- WebSocket with reconnect/backoff ----------
  var ws = null;
  var reconnectDelay = 1000;
  var reconnectTimer = null;
  var manualClose = false;

  function wsUrl() {
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return proto + '://' + location.host + '/stream';
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  function subscribe() {
    send({ type: 'subscribe', symbol: state.symbol, interval: state.interval, range: state.range });
  }

  function connect() {
    manualClose = false;
    try {
      ws = new WebSocket(wsUrl());
    } catch (e) {
      scheduleReconnect();
      return;
    }

    ws.onopen = function () {
      reconnectDelay = 1000;
      setConnBadge(true);
      subscribe();
      if (state.simulate) send({ type: 'simulate', on: true });
      fetchNews(state.symbol);
    };

    ws.onmessage = function (evt) {
      var msg;
      try { msg = JSON.parse(evt.data); } catch (e) { return; }
      handleMessage(msg);
    };

    ws.onclose = function () {
      setConnBadge(false);
      if (!manualClose) scheduleReconnect();
    };

    ws.onerror = function () {
      // onclose will follow and trigger reconnect
      try { ws.close(); } catch (e) {}
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15000); // exponential backoff, cap 15s
  }

  function handleMessage(msg) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'snapshot':
        if (msg.symbol) { state.symbol = msg.symbol; setText('symbolPill', msg.symbol); }
        if (msg.interval) { state.interval = msg.interval; }
        if (msg.range) { state.range = msg.range; } // server may clamp the range
        syncViewSelects();
        setCandles(msg.candles || []);
        var lastC = (msg.candles || [])[ (msg.candles || []).length - 1 ];
        state.livePrice = lastC && isFinite(lastC.close) ? lastC.close : null;
        if (state.livePrice != null) priceMap[state.symbol] = state.livePrice;
        if (msg.analysis) setOverlays(msg.analysis.overlays);
        chart.timeScale().fitContent();
        if (msg.analysis) render(msg.analysis);
        setModeBadge(msg.mode);
        break;

      case 'candle':
        if (msg.candle) {
          // closed=false updates the forming bar; closed=true also updates (new bar appended)
          candleSeries.update(msg.candle);
          lineSeries.update({ time: msg.candle.time, value: msg.candle.close });
          volumeSeries.update({ time: msg.candle.time, value: msg.candle.volume, color: volColor(msg.candle) });
          // keep local copy in sync
          var arr = state.candles;
          if (arr.length && arr[arr.length - 1].time === msg.candle.time) {
            arr[arr.length - 1] = msg.candle;
          } else {
            arr.push(msg.candle);
          }
          // live price -> update KPI + position/portfolio P/L immediately
          if (isFinite(msg.candle.close)) {
            state.livePrice = msg.candle.close;
            priceMap[state.symbol] = msg.candle.close;
            setText('price', money(msg.candle.close));
            renderPositionCard();
            renderPortfolio();
          }
        }
        break;

      case 'analysis':
        if (msg.analysis) {
          setOverlays(msg.analysis.overlays);
          render(msg.analysis);
        }
        break;

      case 'status':
        setConnBadge(!!msg.connected);
        setModeBadge(msg.mode);
        if (msg.message) setText('modeNote', msg.message);
        break;

      case 'error':
        showBanner(msg.message || 'An error occurred.');
        break;
    }
  }

  // ---------- Controls ----------
  function syncViewSelects() {
    var iv = $('interval'); if (iv) iv.value = state.interval;
    var rg = $('range'); if (rg) rg.value = state.range;
    var ct = $('chartType'); if (ct) ct.value = state.chartType;
  }

  $('interval').addEventListener('change', function () {
    state.interval = this.value;
    send({ type: 'setView', interval: state.interval, range: state.range });
  });

  $('range').addEventListener('change', function () {
    state.range = this.value;
    send({ type: 'setView', interval: state.interval, range: state.range });
  });

  $('chartType').addEventListener('change', function () {
    state.chartType = this.value;
    applyChartType();
  });

  $('analyze').addEventListener('click', function () {
    // Re-subscribe to request a fresh snapshot/analysis from the server.
    subscribe();
  });

  $('simulate').addEventListener('click', function () {
    state.simulate = !state.simulate;
    this.classList.toggle('on', state.simulate);
    send({ type: 'simulate', on: state.simulate });
  });

  // ---------- Ticker search (debounced) ----------
  var searchTimer = null;
  var searchInput = $('searchInput');
  var resultsBox = $('searchResults');

  searchInput.addEventListener('input', function () {
    var q = this.value.trim();
    if (searchTimer) clearTimeout(searchTimer);
    if (!q) { hideResults(); return; }
    searchTimer = setTimeout(function () { runSearch(q); }, 250);
  });

  searchInput.addEventListener('focus', function () {
    if (resultsBox.children.length) resultsBox.classList.remove('hidden');
  });

  document.addEventListener('click', function (e) {
    if (!resultsBox.contains(e.target) && e.target !== searchInput) hideResults();
  });

  function hideResults() { resultsBox.classList.add('hidden'); }

  function runSearch(q) {
    fetch('/api/search?q=' + encodeURIComponent(q))
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (list) { showResults(list || []); })
      .catch(function () { showResults([]); });
  }

  function showResults(list) {
    if (!list.length) {
      resultsBox.innerHTML = '<div class="empty">No matches.</div>';
      resultsBox.classList.remove('hidden');
      return;
    }
    resultsBox.innerHTML = '';
    list.slice(0, 20).forEach(function (item) {
      var div = document.createElement('div');
      div.className = 'item';
      div.innerHTML = '<b>' + escapeHtml(item.symbol) + '</b><span>' + escapeHtml(item.description || '') + '</span>';
      div.addEventListener('click', function () { selectSymbol(item.symbol); });
      resultsBox.appendChild(div);
    });
    resultsBox.classList.remove('hidden');
  }

  function selectSymbol(symbol) {
    if (!symbol || symbol === state.symbol) { hideResults(); return; }
    // unsubscribe old, clear chart, subscribe new
    send({ type: 'unsubscribe' });
    state.symbol = symbol;
    state.lastSignalLabel = null;
    state.lastAnalysis = null; // avoid showing the old ticker's signal for the new one
    state.livePrice = null;
    setText('symbolPill', symbol);
    clearChart();
    subscribe();
    if (state.simulate) send({ type: 'simulate', on: true });
    fetchNews(symbol);
    renderPositionCard();
    renderPortfolio();
    searchInput.value = '';
    hideResults();
  }

  // ---------- Market news ----------
  function relTime(unixSec) {
    if (!unixSec) return '';
    var diff = Math.floor(Date.now() / 1000) - unixSec;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }

  function fetchNews(symbol) {
    setText('newsSymbol', symbol);
    var box = $('news');
    box.innerHTML = '<div class="empty">Loading news…</div>';
    fetch('/api/news/' + encodeURIComponent(symbol))
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (items) { renderNews(items || []); })
      .catch(function () { box.innerHTML = '<div class="empty">Could not load news.</div>'; });
  }

  function renderNews(items) {
    var box = $('news');
    if (!items.length) { box.innerHTML = '<div class="empty">No recent news found.</div>'; return; }
    box.innerHTML = items.slice(0, 15).map(function (n) {
      var thumb = n.image ? '<img class="nthumb" src="' + encodeURI(n.image) + '" alt="" onerror="this.style.display=\'none\'"/>' : '';
      var meta = [escapeHtml(n.source), relTime(n.datetime)].filter(Boolean).join(' · ');
      var sum = n.summary ? '<div class="nsum">' + escapeHtml(n.summary) + '</div>' : '';
      return '<a class="nrow" href="' + encodeURI(n.url) + '" target="_blank" rel="noopener noreferrer">' +
        thumb +
        '<div class="nbody"><div class="nhead">' + escapeHtml(n.headline) + '</div>' +
        '<div class="nmeta">' + meta + '</div>' + sum + '</div></a>';
    }).join('');
  }

  function clearChart() {
    state.candles = [];
    candleSeries.setData([]);
    lineSeries.setData([]);
    volumeSeries.setData([]);
    ema9Series.setData([]); ema20Series.setData([]); ema50Series.setData([]);
    bbUpperSeries.setData([]); bbLowerSeries.setData([]);
    vwapSeries.setData([]); stSeries.setData([]);
  }

  // ---------- CSV backfill (visual only — server drives real analysis) ----------
  $('loadCsv').addEventListener('click', function () {
    var raw = $('csv').value.trim();
    var rows = raw.split(/\n+/).map(function (x) { return x.trim(); }).filter(Boolean);
    var now = Math.floor(Date.now() / 1000);
    var parsed = [];
    rows.forEach(function (row, i) {
      var parts = row.split(',').map(function (x) { return x.trim(); });
      var t = parts[0], o = parts[1], h = parts[2], l = parts[3], c = parts[4], v = parts[5];
      if (!o || !h || !l || !c) return;
      var time = isNaN(Date.parse(t)) ? now - (rows.length - i) * 300 : Math.floor(Date.parse(t) / 1000);
      parsed.push({ time: time, open: +o, high: +h, low: +l, close: +c, volume: +v || 0 });
    });
    if (parsed.length > 4) {
      setCandles(parsed);
      // CSV is visual only: no overlays/analysis are computed in the browser.
      ema9Series.setData([]); ema20Series.setData([]); ema50Series.setData([]);
      bbUpperSeries.setData([]); bbLowerSeries.setData([]);
      chart.timeScale().fitContent();
      setText('csvNote', 'Loaded ' + parsed.length + ' candles for visual backfill only. Live analysis is computed on the server, not in the browser.');
    } else {
      showBanner('Please paste at least 5 valid OHLCV rows.');
    }
  });

  $('sampleCsv').addEventListener('click', function () {
    $('csv').value = '09:30,300,304,298,302,1200000\n09:35,302,303,295,296,1800000\n09:40,296,298,289,294,2200000\n09:45,294,296,286,295,2500000\n09:50,295,304,293,303,3200000';
  });

  // ---------- Personalized position tracking (localStorage) ----------
  var PORTFOLIO_KEY = 'csd_portfolio_v1';
  var priceMap = {}; // symbol -> latest price (active ticker via stream, others via /api/price)

  function loadPortfolio() {
    try { return JSON.parse(localStorage.getItem(PORTFOLIO_KEY)) || []; }
    catch (e) { return []; }
  }
  function savePortfolio(arr) {
    try { localStorage.setItem(PORTFOLIO_KEY, JSON.stringify(arr)); } catch (e) {}
  }
  function getPosition(symbol) {
    return loadPortfolio().filter(function (p) { return p.symbol === symbol; })[0] || null;
  }
  function upsertPosition(symbol, shares, cost) {
    var arr = loadPortfolio().filter(function (p) { return p.symbol !== symbol; });
    arr.push({ symbol: symbol, shares: shares, cost: cost });
    savePortfolio(arr);
  }
  function removePosition(symbol) {
    savePortfolio(loadPortfolio().filter(function (p) { return p.symbol !== symbol; }));
  }
  function fmtShares(n) {
    if (!isFinite(n)) return '--';
    return (Math.round(n * 10000) / 10000).toString(); // up to 4 dp, trailing zeros trimmed
  }
  function currentPrice(symbol) {
    if (symbol === state.symbol) {
      // freshest first: the live forming-candle close, then the last analysis price
      if (isFinite(state.livePrice)) return state.livePrice;
      if (state.lastAnalysis && isFinite(state.lastAnalysis.price)) return state.lastAnalysis.price;
    }
    return priceMap[symbol];
  }

  // Personalized call = engine signal + your P/L + your entry vs stop/target.
  function computeRecommendation(analysis, pos) {
    var price = currentPrice(pos.symbol); // freshest live price (falls back internally)
    if (!isFinite(price) && analysis && isFinite(analysis.price)) price = analysis.price;
    var lv = (analysis && analysis.levels) || {};
    var sig = analysis && analysis.signal;
    // P/L% needs an average cost; null when the user only entered shares.
    var hasCost = pos.cost > 0 && isFinite(price);
    var plPct = hasCost ? (price - pos.cost) / pos.cost * 100 : null;
    var reasons = [];
    var action = 'HOLD', cls = 'wait';

    if (lv.stopLoss && isFinite(price) && price <= lv.stopLoss) {
      action = 'CUT LOSS'; cls = 'sell';
      reasons.push('Price ($' + price.toFixed(2) + ') is at/below the stop-loss zone ($' + lv.stopLoss.toFixed(2) + ').');
    } else if (lv.sellTarget && isFinite(price) && price >= lv.sellTarget) {
      action = 'TAKE PROFIT'; cls = 'sell';
      reasons.push('Price reached the target zone ($' + lv.sellTarget.toFixed(2) + ') — consider locking gains.');
    } else if (sig === 'SELL') {
      cls = 'sell';
      if (plPct === null) { action = 'SELL / REDUCE'; reasons.push('Bearish signal — consider trimming or waiting for stabilization.'); }
      else if (plPct >= 0) { action = 'SELL / TRIM'; reasons.push('Bearish signal while you are up ' + plPct.toFixed(1) + '% — consider trimming to protect gains.'); }
      else { action = 'REDUCE / TIGHTEN STOP'; reasons.push('Bearish signal and you are down ' + Math.abs(plPct).toFixed(1) + '% — consider cutting or tightening your stop.'); }
    } else if (sig === 'BUY') {
      cls = 'buy';
      action = (plPct !== null && plPct < 0) ? 'HOLD / ADD' : 'HOLD';
      reasons.push('Bullish signal — the trend supports holding' + (plPct !== null && plPct < 0 ? '; only average down with a defined risk plan.' : '.'));
      if (lv.buyTrigger && isFinite(price) && price < lv.buyTrigger) reasons.push('Adds are cleaner once price holds above the buy trigger ($' + lv.buyTrigger.toFixed(2) + ').');
    } else {
      action = 'HOLD'; cls = 'wait';
      reasons.push('No strong edge right now — hold and watch the next few candles.');
    }
    if (plPct !== null) {
      reasons.push((plPct >= 0 ? 'You are up ' : 'You are down ') + Math.abs(plPct).toFixed(2) + '% on this position.');
    } else if (pos.cost <= 0) {
      reasons.push('Add your average cost to see P/L % for this position.');
    }
    if (analysis && analysis.signalLabel) reasons.push('Chart signal: ' + analysis.signalLabel + ' (' + (analysis.score | 0) + '/100).');
    return { action: action, cls: cls, reasons: reasons };
  }

  // Fill the input fields from the stored position. Called ONLY on symbol change
  // / after save / remove — never on the live render tick, so it can't wipe what
  // you're typing.
  function fillPositionForm() {
    var pos = getPosition(state.symbol);
    var sharesEl = $('posShares'), amountEl = $('posAmount'), costEl = $('posCost');
    if (pos) {
      sharesEl.value = pos.shares > 0 ? fmtShares(pos.shares) : '';
      costEl.value = pos.cost > 0 ? pos.cost : '';
      amountEl.value = (pos.shares > 0 && pos.cost > 0) ? +(pos.shares * pos.cost).toFixed(2) : '';
    } else {
      sharesEl.value = ''; costEl.value = ''; amountEl.value = '';
    }
    state.formSymbol = state.symbol;
  }

  function renderPositionCard() {
    var sym = state.symbol;
    setText('posSymbol', sym);
    // Load this symbol's saved values into the form ONCE when the symbol changes;
    // after that, leave the inputs alone so live ticks don't overwrite typing.
    if (state.formSymbol !== sym) fillPositionForm();
    var pos = getPosition(sym);
    var hasPos = pos && (pos.shares > 0 || pos.cost > 0);
    $('posResult').classList.toggle('hidden', !hasPos);
    $('posEmpty').style.display = hasPos ? 'none' : '';
    $('posRemove').style.display = pos ? '' : 'none';
    if (!hasPos) return;

    var price = currentPrice(sym);
    var hasShares = pos.shares > 0, hasCost = pos.cost > 0;
    var basis = (hasShares && hasCost) ? pos.shares * pos.cost : null;
    var value = (hasShares && isFinite(price)) ? pos.shares * price : null;
    setText('posBasis', basis != null ? '$' + basis.toFixed(2) : '--');
    setText('posValue', value != null ? '$' + value.toFixed(2) : '--');
    var plEl = $('posPL');
    if (basis != null && value != null) {
      var pl = value - basis, plPct = pl / basis * 100;
      plEl.textContent = (pl >= 0 ? '+$' : '-$') + Math.abs(pl).toFixed(2) + ' (' + (pl >= 0 ? '+' : '') + plPct.toFixed(2) + '%)';
      plEl.className = pl >= 0 ? 'pos' : 'neg';
    } else if (hasCost && isFinite(price)) {
      var pct = (price - pos.cost) / pos.cost * 100;
      plEl.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
      plEl.className = pct >= 0 ? 'pos' : 'neg';
    } else {
      plEl.textContent = '--'; plEl.className = '';
    }
    if (state.lastAnalysis) {
      var rec = computeRecommendation(state.lastAnalysis, pos);
      $('posRecBox').className = 'posRecBox ' + rec.cls;
      setText('posRec', rec.action);
      $('posReasons').innerHTML = rec.reasons.slice(0, 5).map(function (r) { return '<div>' + escapeHtml(r) + '</div>'; }).join('');
    }
  }

  function renderPortfolio() {
    var arr = loadPortfolio();
    var tbody = $('portfolioRows');
    if (!arr.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty">No positions yet. Add one in “Your position” above.</td></tr>';
      setText('portfolioTotal', '');
      return;
    }
    var totBasis = 0, totVal = 0, anyDollar = false;
    tbody.innerHTML = arr.map(function (p) {
      var price = currentPrice(p.symbol);
      var hasShares = p.shares > 0, hasCost = p.cost > 0;
      var basis = (hasShares && hasCost) ? p.shares * p.cost : null;
      var value = (hasShares && isFinite(price)) ? p.shares * price : null;
      var pl = (basis != null && value != null) ? value - basis : null;
      var plPct = (hasCost && isFinite(price)) ? (price - p.cost) / p.cost * 100 : null;
      if (value != null && basis != null) { totVal += value; totBasis += basis; anyDollar = true; }
      var plCls = pl != null ? (pl >= 0 ? 'pos' : 'neg') : (plPct != null ? (plPct >= 0 ? 'pos' : 'neg') : '');
      var plTxt = pl != null ? ((pl >= 0 ? '+$' : '-$') + Math.abs(pl).toFixed(2)) : '--';
      var plPctTxt = plPct != null ? ((plPct >= 0 ? '+' : '') + plPct.toFixed(2) + '%') : '--';
      return '<tr data-sym="' + escapeHtml(p.symbol) + '">' +
        '<td><b>' + escapeHtml(p.symbol) + '</b></td>' +
        '<td>' + (hasShares ? fmtShares(p.shares) : '--') + '</td>' +
        '<td>' + (hasCost ? ('$' + (+p.cost).toFixed(2)) : '--') + '</td>' +
        '<td>' + (isFinite(price) ? ('$' + price.toFixed(2)) : '--') + '</td>' +
        '<td>' + (value != null ? '$' + value.toFixed(2) : '--') + '</td>' +
        '<td class="' + plCls + '">' + plTxt + '</td>' +
        '<td class="' + plCls + '">' + plPctTxt + '</td>' +
        '<td class="x"><button title="Remove" data-rm="' + escapeHtml(p.symbol) + '">✕</button></td>' +
        '</tr>';
    }).join('');
    if (anyDollar) {
      var totPl = totVal - totBasis; var totPct = totBasis > 0 ? totPl / totBasis * 100 : 0;
      var cls = totPl >= 0 ? 'pos' : 'neg';
      $('portfolioTotal').innerHTML = 'Total value $' + totVal.toFixed(2) + ' &nbsp;·&nbsp; <span class="' + cls + '">' +
        (totPl >= 0 ? '+$' : '-$') + Math.abs(totPl).toFixed(2) + ' (' + (totPl >= 0 ? '+' : '') + totPct.toFixed(2) + '%)</span>';
    } else { setText('portfolioTotal', ''); }
  }

  function refreshPortfolioPrices() {
    loadPortfolio().forEach(function (p) {
      if (p.symbol === state.symbol) return; // active ticker is priced live via the stream
      fetch('/api/price/' + encodeURIComponent(p.symbol))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { if (d && isFinite(d.price)) { priceMap[p.symbol] = d.price; renderPortfolio(); } })
        .catch(function () {});
    });
  }

  // Auto-calculate the empty field when the other two are filled (amount = shares × price).
  function recalcPosInputs() {
    var sEl = $('posShares'), pEl = $('posCost'), aEl = $('posAmount');
    var num = function (v) { var n = parseFloat(v); return n > 0 ? n : null; };
    var S = num(sEl.value), P = num(pEl.value), A = num(aEl.value);
    var f = document.activeElement;
    // Re-derive (live, on every keystroke) the ONE field the user is NOT editing
    // from the other two. Never overwrite the field being typed in.
    if (P && S && f !== aEl) aEl.value = +(S * P).toFixed(2);        // price + shares -> order value
    else if (P && A && f !== sEl) sEl.value = +(A / P).toFixed(4);   // price + order  -> shares
    else if (S && A && f !== pEl) pEl.value = +(A / S).toFixed(4);   // shares + order -> price
  }
  ['posShares', 'posCost', 'posAmount'].forEach(function (id) {
    $(id).addEventListener('input', recalcPosInputs);
  });

  $('posSave').addEventListener('click', function () {
    var S = parseFloat($('posShares').value);   // total shares
    var P = parseFloat($('posCost').value);     // avg price / share
    var A = parseFloat($('posAmount').value);   // order value (amount invested)
    S = S > 0 ? S : null; P = P > 0 ? P : null; A = A > 0 ? A : null;
    // Derive the missing value from any two (order value = shares × price).
    if (P == null && S && A) P = A / S;          // shares + amount  -> price
    else if (S == null && P && A) S = A / P;     // price  + amount  -> shares
    else if (A == null && S && P) A = S * P;     // shares + price   -> amount (implicit)
    if (P == null && S == null) {
      showBanner('Enter any two of: order value, avg price/share, total shares (or at least the price/share).');
      return;
    }
    upsertPosition(state.symbol, S || 0, P || 0);
    fillPositionForm();                          // show the normalized/derived values
    renderPositionCard(); renderPortfolio(); refreshPortfolioPrices();
  });
  $('posRemove').addEventListener('click', function () {
    removePosition(state.symbol);
    fillPositionForm();                          // clears the inputs
    renderPositionCard(); renderPortfolio();
  });
  $('portfolioRows').addEventListener('click', function (e) {
    var rm = e.target.getAttribute && e.target.getAttribute('data-rm');
    if (rm) { e.stopPropagation(); removePosition(rm); renderPositionCard(); renderPortfolio(); return; }
    var tr = e.target.closest && e.target.closest('tr[data-sym]');
    if (tr && tr.getAttribute('data-sym')) selectSymbol(tr.getAttribute('data-sym'));
  });

  // ---------- Draggable / minimizable signal-guide sticky note ----------
  (function () {
    var el = $('cheatsheet');
    if (!el) return;
    var head = $('stickyHead');
    var KEY = 'csd_sticky_v1';
    try {
      var saved = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (saved) {
        if (Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
          el.style.left = saved.left + 'px';
          el.style.top = saved.top + 'px';
          el.style.right = 'auto';
        }
        if (saved.min) el.classList.add('min');
      }
    } catch (e) {}

    function save() {
      var r = el.getBoundingClientRect();
      try {
        localStorage.setItem(KEY, JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top), min: el.classList.contains('min') }));
      } catch (e) {}
    }
    function point(e) {
      var t = e.touches && e.touches[0];
      return { x: t ? t.clientX : e.clientX, y: t ? t.clientY : e.clientY };
    }
    var drag = null;
    function down(e) {
      if (e.target.closest('button')) return; // let the minimize button work
      var p = point(e);
      var r = el.getBoundingClientRect();
      drag = { dx: p.x - r.left, dy: p.y - r.top };
      el.style.right = 'auto';
      document.addEventListener('mousemove', moveE);
      document.addEventListener('mouseup', up);
      document.addEventListener('touchmove', moveE, { passive: false });
      document.addEventListener('touchend', up);
      e.preventDefault();
    }
    function moveE(e) {
      if (!drag) return;
      var p = point(e);
      var maxL = window.innerWidth - el.offsetWidth - 6;
      var maxT = window.innerHeight - 44;
      el.style.left = Math.max(6, Math.min(maxL, p.x - drag.dx)) + 'px';
      el.style.top = Math.max(6, Math.min(maxT, p.y - drag.dy)) + 'px';
      e.preventDefault();
    }
    function up() {
      drag = null;
      document.removeEventListener('mousemove', moveE);
      document.removeEventListener('mouseup', up);
      document.removeEventListener('touchmove', moveE);
      document.removeEventListener('touchend', up);
      save();
    }
    head.addEventListener('mousedown', down);
    head.addEventListener('touchstart', down, { passive: false });
    $('stMin').addEventListener('click', function () {
      el.classList.toggle('min');
      $('stMin').textContent = el.classList.contains('min') ? '+' : '–';
      save();
    });
    $('stMin').textContent = el.classList.contains('min') ? '+' : '–';
  })();

  // ---------- Floating AI assistant (Gemini via /api/chat) ----------
  (function () {
    var el = $('chatbot');
    if (!el) return;
    var head = $('chatHead'), msgsEl = $('chatMsgs'), inputEl = $('chatInput');
    var KEY = 'csd_chat_v1';
    var convo = []; // {role:'user'|'assistant', text}
    try {
      var s = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (s) {
        if (Number.isFinite(s.left) && Number.isFinite(s.top)) {
          el.style.left = s.left + 'px'; el.style.top = s.top + 'px';
          el.style.right = 'auto'; el.style.bottom = 'auto';
        }
        if (s.min === false) el.classList.remove('min');
      }
    } catch (e) {}
    $('chatMin').textContent = el.classList.contains('min') ? '+' : '–';

    function save() {
      var r = el.getBoundingClientRect();
      try { localStorage.setItem(KEY, JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top), min: el.classList.contains('min') })); } catch (e) {}
    }
    function point(e) { var t = e.touches && e.touches[0]; return { x: t ? t.clientX : e.clientX, y: t ? t.clientY : e.clientY }; }
    var drag = null;
    function down(e) {
      if (e.target.closest('button') || e.target.closest('input') || e.target.closest('textarea')) return;
      var p = point(e), r = el.getBoundingClientRect();
      drag = { dx: p.x - r.left, dy: p.y - r.top };
      el.style.right = 'auto'; el.style.bottom = 'auto';
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
      document.addEventListener('touchmove', mv, { passive: false }); document.addEventListener('touchend', up);
      e.preventDefault();
    }
    function mv(e) {
      if (!drag) return; var p = point(e);
      el.style.left = Math.max(6, Math.min(window.innerWidth - el.offsetWidth - 6, p.x - drag.dx)) + 'px';
      el.style.top = Math.max(6, Math.min(window.innerHeight - 44, p.y - drag.dy)) + 'px';
      e.preventDefault();
    }
    function up() {
      drag = null;
      document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up);
      document.removeEventListener('touchmove', mv); document.removeEventListener('touchend', up);
      save();
    }
    head.addEventListener('mousedown', down);
    head.addEventListener('touchstart', down, { passive: false });
    $('chatMin').addEventListener('click', function () {
      el.classList.toggle('min');
      $('chatMin').textContent = el.classList.contains('min') ? '+' : '–';
      save();
      if (!el.classList.contains('min')) inputEl.focus();
    });

    function mdLite(t) {
      var e = escapeHtml(t);
      e = e.replace(/`([^`]+)`/g, '<code>$1</code>');
      e = e.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
      e = e.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      e = e.replace(/\n/g, '<br>');
      return e;
    }
    function addMsg(role, html, cls) {
      var d = document.createElement('div');
      d.className = 'chatMsg ' + (cls || (role === 'user' ? 'user' : 'bot'));
      d.innerHTML = html;
      msgsEl.appendChild(d);
      msgsEl.scrollTop = msgsEl.scrollHeight;
      return d;
    }
    function chatContext() {
      var a = state.lastAnalysis || {};
      var pos = getPosition(state.symbol);
      var ind = a.indicators || {};
      return {
        ticker: state.symbol, interval: state.interval, range: state.range,
        price: a.price, marketSignal: a.signalLabel, score: a.score, setup: a.setup, mode: a.mode,
        indicators: { rsi: ind.rsi, ema9: ind.ema9, ema20: ind.ema20, ema50: ind.ema50, macd: ind.macd, atr: ind.atr, vwap: ind.vwap, volRatio: ind.volRatio },
        levels: a.levels,
        patterns: (a.patterns || []).map(function (p) { return p.name + ' (' + p.signal + ')'; }),
        yourPosition: pos ? { shares: pos.shares, avgPricePerShare: pos.cost } : null
      };
    }
    var sending = false;
    function send() {
      if (sending) return;                       // in-flight lock — no rapid re-sends
      var q = (inputEl.value || '').trim();
      if (!q) return;
      if (q.length > 1500) q = q.slice(0, 1500);  // cap input length (matches server)
      sending = true;
      var btn = $('chatSend'); btn.disabled = true; btn.textContent = '…';
      inputEl.value = ''; inputEl.style.height = 'auto';
      addMsg('user', escapeHtml(q));
      convo.push({ role: 'user', text: q });
      if (convo.length > 16) convo = convo.slice(-16); // bound client history
      var thinking = addMsg('bot', 'Thinking…', 'bot think');
      var done = function () { sending = false; btn.disabled = false; btn.textContent = 'Send'; };
      fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: convo, context: chatContext(), webSearch: $('chatWeb').checked })
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          thinking.remove(); done();
          if (d && d.text) {
            var html = mdLite(d.text);
            if (d.sources && d.sources.length) {
              html += '<span class="src">Sources: ' + d.sources.slice(0, 5).map(function (s) {
                return '<a href="' + encodeURI(s.uri) + '" target="_blank" rel="noopener">' + escapeHtml(s.title || 'link') + '</a>';
              }).join('') + '</span>';
            }
            addMsg('bot', html);
            if (!d.needsKey) convo.push({ role: 'assistant', text: d.text });
          } else {
            addMsg('bot', escapeHtml((d && d.error) || 'No response.'));
          }
        })
        .catch(function () { thinking.remove(); done(); addMsg('bot', 'Could not reach the assistant. Please try again.'); });
    }
    $('chatSend').addEventListener('click', send);
    inputEl.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    inputEl.addEventListener('input', function () { this.style.height = 'auto'; this.style.height = Math.min(120, this.scrollHeight) + 'px'; });
  })();

  // ---------- Live clock (always reflects the current date/time) ----------
  function tickClock() {
    var d = new Date();
    setText('clock', d.toLocaleString([], {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }));
  }
  tickClock();
  setInterval(tickClock, 1000);

  // ---------- Boot ----------
  setConnBadge(false);
  setModeBadge('simulated');
  syncViewSelects();
  applyChartType();
  renderPositionCard();
  renderPortfolio();
  refreshPortfolioPrices();
  setInterval(refreshPortfolioPrices, 30000);
  connect();
})();
