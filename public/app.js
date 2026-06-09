/* Live Candle Pattern Signal Dashboard — browser frontend.
 * Talks to the server over the /stream WebSocket and the REST search route.
 * No build step; vanilla JS. Analysis is computed server-side (see docs/CONTRACTS.md).
 */
(function () {
  'use strict';

  // ---------- State ----------
  var state = {
    symbol: 'MRVL',
    timeframe: 5,
    simulate: false,
    candles: [],
    lastSignalLabel: null
  };

  // ---------- Chart setup (mirrors the reference, plus extra overlays) ----------
  // Lightweight Charts renders timestamps in UTC and has no built-in timezone
  // support, so we format axis ticks + crosshair in the BROWSER's local timezone.
  // (candle.time is a UTC unix-seconds value, so new Date(ts*1000) is the correct
  // moment; toLocale* then renders it in whatever timezone the user is in.)
  function localTime(ts) {
    return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function localDateTime(ts) {
    return new Date(ts * 1000).toLocaleString([], {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  }

  var chart = LightweightCharts.createChart(document.getElementById('chart'), {
    autoSize: true, // track the container's CSS width/height (incl. the taller #chart)
    layout: { background: { color: '#0b1220' }, textColor: '#cbd7e8' },
    grid: { vertLines: { color: '#18243a' }, horzLines: { color: '#18243a' } },
    rightPriceScale: { borderColor: '#253653' },
    localization: { timeFormatter: localDateTime }, // crosshair / tooltip label
    timeScale: {
      borderColor: '#253653',
      timeVisible: true,
      secondsVisible: false,
      tickMarkFormatter: function (ts) { return localTime(ts); } // x-axis labels
    },
    crosshair: { mode: 1 }
  });

  var candleSeries = chart.addCandlestickSeries({
    upColor: '#2fd17c', downColor: '#ff5c6c',
    borderUpColor: '#2fd17c', borderDownColor: '#ff5c6c',
    wickUpColor: '#2fd17c', wickDownColor: '#ff5c6c'
  });

  // EMA overlays
  var ema9Series = chart.addLineSeries({ color: '#5aa7ff', lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
  var ema20Series = chart.addLineSeries({ color: '#ffbf47', lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
  var ema50Series = chart.addLineSeries({ color: '#b388ff', lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
  // Bollinger bands (lighter)
  var bbUpperSeries = chart.addLineSeries({ color: 'rgba(149,163,184,.55)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, lineStyle: 2 });
  var bbLowerSeries = chart.addLineSeries({ color: 'rgba(149,163,184,.55)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, lineStyle: 2 });

  // Volume histogram on its own (hidden) price scale at the bottom
  var volumeSeries = chart.addHistogramSeries({
    priceFormat: { type: 'volume' },
    priceScaleId: '',
    color: 'rgba(90,167,255,.4)'
  });
  volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

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
    volumeSeries.setData(state.candles.map(function (c) {
      return { time: c.time, value: c.volume, color: volColor(c) };
    }));
  }

  function setOverlays(overlays) {
    if (!overlays) return;
    ema9Series.setData(overlays.ema9 || []);
    ema20Series.setData(overlays.ema20 || []);
    ema50Series.setData(overlays.ema50 || []);
    bbUpperSeries.setData(overlays.bbUpper || []);
    bbLowerSeries.setData(overlays.bbLower || []);
  }

  // Map analysis.signal -> css class buy/sell/wait
  function signalClass(signal) {
    if (signal === 'BUY') return 'buy';
    if (signal === 'SELL') return 'sell';
    return 'wait';
  }

  function render(analysis) {
    if (!analysis) return;
    var cls = signalClass(analysis.signal);
    var label = analysis.signalLabel || analysis.signal || 'WAIT';

    // signal box
    var box = $('signalBox');
    box.className = 'signalBox ' + cls;
    setText('signalMain', label);
    $('scoreBar').style.width = Math.max(0, Math.min(100, analysis.score || 0)) + '%';
    setText('signalText', (analysis.reasons && analysis.reasons[0]) || 'Waiting for stronger confirmation.');

    // KPIs
    setText('price', money(analysis.price));
    if (analysis.dayRange) {
      setText('range', money(analysis.dayRange.low) + '–' + money(analysis.dayRange.high));
    }
    var kpi = $('signalKpi');
    kpi.textContent = label;
    kpi.className = cls === 'buy' ? 'green' : cls === 'sell' ? 'red' : 'amber';
    setText('confKpi', (analysis.confidence === undefined || analysis.confidence === null) ? '--%' : Math.round(analysis.confidence) + '%');

    // reasons
    var reasons = analysis.reasons || [];
    $('reasons').innerHTML = reasons.slice(0, 6).map(function (r) {
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

    // patterns table
    var pats = analysis.patterns || [];
    $('patterns').innerHTML = pats.map(function (p) {
      var sig = (p.signal || 'wait').toLowerCase();
      return '<tr><td>' + escapeHtml(p.name) + '</td><td>' + escapeHtml(p.meaning) +
        '</td><td><span class="badge ' + sig + '">' + sig.toUpperCase() + '</span></td></tr>';
    }).join('');

    // signal history — log only when the label actually changes
    if (label !== state.lastSignalLabel) {
      if (state.lastSignalLabel !== null) {
        addHistory(label, cls);
      }
      state.lastSignalLabel = label;
    }
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
    send({ type: 'subscribe', symbol: state.symbol, timeframe: state.timeframe });
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
        if (msg.timeframe) { state.timeframe = +msg.timeframe; syncTimeframeSelect(); }
        setCandles(msg.candles || []);
        if (msg.analysis) setOverlays(msg.analysis.overlays);
        chart.timeScale().fitContent();
        if (msg.analysis) render(msg.analysis);
        setModeBadge(msg.mode);
        break;

      case 'candle':
        if (msg.candle) {
          // closed=false updates the forming bar; closed=true also updates (new bar appended)
          candleSeries.update(msg.candle);
          volumeSeries.update({ time: msg.candle.time, value: msg.candle.volume, color: volColor(msg.candle) });
          // keep local copy in sync
          var arr = state.candles;
          if (arr.length && arr[arr.length - 1].time === msg.candle.time) {
            arr[arr.length - 1] = msg.candle;
          } else {
            arr.push(msg.candle);
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
  function syncTimeframeSelect() {
    var sel = $('timeframe');
    if (sel) sel.value = String(state.timeframe);
  }

  $('timeframe').addEventListener('change', function () {
    state.timeframe = +this.value;
    send({ type: 'setTimeframe', timeframe: state.timeframe });
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
    setText('symbolPill', symbol);
    clearChart();
    subscribe();
    if (state.simulate) send({ type: 'simulate', on: true });
    searchInput.value = '';
    hideResults();
  }

  function clearChart() {
    state.candles = [];
    candleSeries.setData([]);
    volumeSeries.setData([]);
    ema9Series.setData([]); ema20Series.setData([]); ema50Series.setData([]);
    bbUpperSeries.setData([]); bbLowerSeries.setData([]);
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

  // ---------- Boot ----------
  setConnBadge(false);
  setModeBadge('simulated');
  syncTimeframeSelect();
  connect();
})();
