(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function num(v, opts) {
    if (v == null || Number.isNaN(v)) return '<span class="pending">pending</span>';
    const abs = Math.abs(v);
    if (opts === 'pct') return (v * 100).toFixed(1) + '%';
    if (abs >= 1e12) return '$' + (v / 1e12).toFixed(2) + 'T';
    if (abs >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
    return String(+v.toFixed(2));
  }
  const confColor = (c) => (c >= 80 ? 'var(--green)' : c >= 50 ? 'var(--amber)' : 'var(--red)');
  const fmtCross = (v) => ({ golden: 'Golden Cross', death: 'Death Cross', golden_active: 'Above 200-day (Golden)', death_active: 'Below 200-day (Death)', none: '—' }[v] || esc(v) || '—');
  const fmtMacd = (v) => ({ bullish: 'Bullish crossover', bearish: 'Bearish crossover', above: 'Above signal', below: 'Below signal', none: '—' }[v] || esc(v) || '—');

  function showState(html, isErr) {
    const el = $('state');
    el.style.display = 'block';
    el.className = 'state' + (isErr ? ' err' : '');
    el.innerHTML = html;
  }
  function clearAll() {
    $('state').style.display = 'none';
    $('report').innerHTML = '';
    $('comparison').innerHTML = '';
  }

  function li(items) {
    if (!items || !items.length) return '<li class="pending">none provided</li>';
    return items.map((x) => `<li>${esc(x)}</li>`).join('');
  }

  // Ticker autocomplete — searches on the last comma-separated segment
  (function () {
    const inp = $('ticker-input');
    const drop = $('tickerDrop');
    if (!inp || !drop) return;
    let timer = null;

    function lastSegment() {
      const parts = inp.value.split(',');
      return parts[parts.length - 1].trim();
    }

    function pickResult(symbol) {
      const parts = inp.value.split(',').map((s) => s.trim()).filter(Boolean);
      parts[parts.length > 0 ? parts.length - 1 : 0] = symbol;
      inp.value = parts.join(', ') + (parts.length > 1 ? '' : '');
      drop.classList.remove('open');
      drop.innerHTML = '';
      inp.focus();
    }

    function showDrop(list) {
      if (!list.length) { drop.classList.remove('open'); return; }
      drop.innerHTML = list.slice(0, 8).map((r) =>
        `<div class="ticker-item" data-sym="${esc(r.symbol)}"><b>${esc(r.symbol)}</b><span>${esc(r.description || '')}</span></div>`
      ).join('');
      drop.querySelectorAll('.ticker-item').forEach((el) => {
        el.addEventListener('mousedown', (e) => { e.preventDefault(); pickResult(el.dataset.sym); });
      });
      drop.classList.add('open');
    }

    inp.addEventListener('input', () => {
      const q = lastSegment();
      clearTimeout(timer);
      if (!q || q.length < 1) { drop.classList.remove('open'); return; }
      timer = setTimeout(() => {
        fetch('/api/search?q=' + encodeURIComponent(q))
          .then((r) => r.ok ? r.json() : [])
          .then((list) => showDrop(Array.isArray(list) ? list : []))
          .catch(() => drop.classList.remove('open'));
      }, 220);
    });

    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { drop.classList.remove('open'); }
    });

    document.addEventListener('click', (e) => {
      if (!inp.contains(e.target) && !drop.contains(e.target)) drop.classList.remove('open');
    });
  }());

  function renderReport(d) {
    const r = d.report || {};
    const ov = r.overview || {}, fin = r.financials || {}, sr = r.strengthsRisks || {};
    const val = r.valuation || {}, tec = r.technical || {}, rec = r.recommendation || {};
    const ratios = val.ratios || {};
    const conf = d.confidence != null ? d.confidence : 0;

    $('report').innerHTML = `
      <div class="verdict-banner">
        <div class="badge ${esc(d.verdict)}">${esc(d.verdict)}</div>
        <div>
          <div class="tkr">${esc(d.ticker)}</div>
          <div class="sub">${esc(ov.sector || '')}${ov.mktCap != null ? ' · ' + num(ov.mktCap) : ''}</div>
        </div>
        <div class="conf">
          <div class="row"><span>Confidence</span><span>${conf}%</span></div>
          <div class="meter"><span style="width:${conf}%;background:${confColor(conf)}"></span></div>
        </div>
        <a href="/?ticker=${encodeURIComponent(d.ticker)}&action=paper" class="btn" style="text-decoration:none;white-space:nowrap;padding:9px 16px">Place Paper Trade →</a>
      </div>

      <div class="sections">
        <div class="card"><h3>Company Overview</h3>
          <div>${esc(ov.thesis) || '<span class="pending">pending</span>'}</div>
        </div>

        <div class="card"><h3>Financial Performance</h3>
          <div class="kv">
            <div class="k">Revenue</div><div class="v">${num(fin.revenue)}</div>
            <div class="k">EPS</div><div class="v">${num(fin.eps)}</div>
            <div class="k">Gross margin</div><div class="v">${fin.margins != null ? num(fin.margins, 'pct') : '<span class="pending">pending</span>'}</div>
            <div class="k">Free cash flow</div><div class="v">${num(fin.fcf)}</div>
            <div class="k">Trend</div><div class="v">${esc(fin.trend)}</div>
            <div class="k">Beat / miss</div><div class="v">${esc(fin.beatMiss)}</div>
          </div>
        </div>

        <div class="card"><h3>Strengths &amp; Risks</h3>
          <div class="kv" style="grid-template-columns:1fr">
            <div><b>Strengths</b><ul class="tight">${li(sr.strengths)}</ul></div>
            <div style="margin-top:8px"><b>Risks</b><ul class="tight">${li(sr.risks)}</ul></div>
          </div>
        </div>

        <div class="card"><h3>Valuation</h3>
          <div class="kv">
            <div class="k">Assessment</div><div class="v">${esc(val.assessment)}</div>
            <div class="k">P/E</div><div class="v">${num(ratios.pe)}</div>
            <div class="k">P/S</div><div class="v">${num(ratios.ps)}</div>
            <div class="k">EV/EBITDA</div><div class="v">${num(ratios.evEbitda)}</div>
            <div class="k">PEG</div><div class="v">${num(ratios.peg)}</div>
            <div class="k">vs sector</div><div class="v">${esc(val.vsSector)}</div>
            <div class="k">vs history</div><div class="v">${esc(val.vsHistory)}</div>
          </div>
        </div>

        <div class="card"><h3>Technical Trend ${tec.available ? '' : '<span class="pending">(unavailable)</span>'}</h3>
          <div class="kv">
            <div class="k">Setup</div><div class="v">${esc(tec.setup)}</div>
            ${tec.available ? `
            <div class="k">RSI (14)</div><div class="v">${num(tec.indicators && tec.indicators.rsi && tec.indicators.rsi.value)}</div>
            <div class="k">MACD cross</div><div class="v">${fmtMacd(tec.indicators && tec.indicators.macd && tec.indicators.macd.crossover)}</div>
            <div class="k">50/200 cross</div><div class="v">${fmtCross(tec.indicators && tec.indicators.cross)}</div>
            <div class="k">Support</div><div class="v">${(tec.keyLevels && tec.keyLevels.support || []).map(num).join(', ') || '—'}</div>
            <div class="k">Resistance</div><div class="v">${(tec.keyLevels && tec.keyLevels.resistance || []).map(num).join(', ') || '—'}</div>` : ''}
          </div>
        </div>

        <div class="card"><h3>Recommendation</h3>
          <div class="kv" style="grid-template-columns:1fr">
            <div><b>Primary drivers</b><ul class="tight">${li(rec.primaryDrivers)}</ul></div>
            <div style="margin-top:8px"><b>Invalidation conditions</b><ul class="tight">${li(rec.invalidationConditions)}</ul></div>
            <div style="margin-top:8px" class="sub">${esc(rec.confidenceJustification)}</div>
          </div>
        </div>
      </div>`;
  }

  function renderComparison(results, rankedVerdict) {
    if (!results || !results.length) return;
    if (rankedVerdict && rankedVerdict.ranked && rankedVerdict.ranked.length) {
      $('report').innerHTML = `<div class="verdict-banner">
        <div class="badge BUY" style="font-size:15px">🏆 ${esc(rankedVerdict.ranked[0])}</div>
        <div class="conf"><div class="sub">Ranked: ${rankedVerdict.ranked.map(esc).join(' › ')}</div>
        <div style="margin-top:4px">${esc(rankedVerdict.rationale)}</div></div>
      </div>`;
    }
    const rows = [
      ['Verdict', (d) => `<span class="badge ${esc(d.verdict)}" style="font-size:13px;padding:3px 10px">${esc(d.verdict)}</span>`],
      ['Confidence', (d) => `${d.confidence}%`],
      ['Sector', (d) => esc((d.report.overview || {}).sector)],
      ['Market cap', (d) => num((d.report.overview || {}).mktCap)],
      ['Growth', (d) => esc((d.report.financials || {}).trend)],
      ['Margins', (d) => { const m = (d.report.financials || {}).margins; return m != null ? num(m, 'pct') : '<span class="pending">pending</span>'; }],
      ['P/E', (d) => num(((d.report.valuation || {}).ratios || {}).pe)],
      ['Assessment', (d) => esc((d.report.valuation || {}).assessment)],
      ['Technical', (d) => esc((d.report.technical || {}).setup)],
    ];
    const head = '<th>Metric</th>' + results.map((d) => `<th>${esc(d.ticker)}</th>`).join('');
    const body = rows.map(([label, fn]) =>
      `<tr><td>${label}</td>${results.map((d) => `<td>${fn(d)}</td>`).join('')}</tr>`).join('');
    $('comparison').innerHTML = `<table class="cmp"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }

  async function run() {
    const raw = $('ticker-input').value.trim();
    if (!raw) { showState('Enter a ticker first.', true); return; }
    const tickers = raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    const depth = $('depth-select').value;
    const mode = tickers.length > 1 ? 'comparison' : 'single';

    clearAll();
    showState('<span class="spinner"></span>Analysing ' + esc(tickers.join(', ')) + '…');
    $('run-btn').disabled = true;

    try {
      const body = mode === 'comparison' ? { mode, tickers, depth } : { ticker: tickers[0], mode, depth };
      const res = await fetch('/api/analyst/report', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        const extra = data.retryAfter ? ` (retry in ~${data.retryAfter}s)` : '';
        showState(`<b>${esc(data.error || 'Report unavailable')}</b>${extra}<br><span class="sub">${esc(data.detail || '')}</span>`, true);
        return;
      }
      $('state').style.display = 'none';
      if (mode === 'comparison') renderComparison(data.results, data.rankedVerdict);
      else renderReport(data);
    } catch (e) {
      showState('Network error — please try again.', true);
    } finally {
      $('run-btn').disabled = false;
    }
  }

  $('run-btn').addEventListener('click', run);
  $('ticker-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });

  // ?ticker= prefill + auto-run (used by manager/paper "Analyst Report" links).
  const pre = new URLSearchParams(location.search).get('ticker');
  if (pre) { $('ticker-input').value = pre; run(); }
})();
