(() => {
  'use strict';

  const token = new URLSearchParams(window.location.search).get('token');
  const root = document.getElementById('root');

  function pct(n) {
    if (n == null) return '—';
    const s = n >= 0 ? '+' : '';
    return `${s}${Number(n).toFixed(2)}%`;
  }
  function dollar(n) { return n != null ? `$${Number(n).toFixed(2)}` : '—'; }
  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  function showError(icon, title, msg) {
    root.innerHTML = `
      <div class="err-page">
        <div class="code">${icon}</div>
        <h2>${esc(title)}</h2>
        <p>${esc(msg)}</p>
      </div>`;
  }

  if (!token) { showError('🔗', 'Invalid link', 'No share token provided.'); return; }

  fetch(`/api/manager/share/${encodeURIComponent(token)}/view`)
    .then(async (res) => {
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 410) showError('🚫', 'Link unavailable', data.error || 'This link has been revoked or expired.');
        else if (res.status === 404) showError('🔍', 'Not found', 'This share link doesn\'t exist.');
        else showError('⚠️', 'Error', data.error || 'Something went wrong.');
        return;
      }
      render(data);
    })
    .catch(() => showError('📡', 'Connection error', 'Could not load the portfolio. Please try again.'));

  function render(data) {
    const { portfolio, summary, holdings, view_count } = data;
    const color = portfolio.color || '#5b8cff';
    const upColor = 'var(--green)';
    const dnColor = 'var(--red)';
    const gainers = holdings.filter(h => h.gain_pct > 0).length;
    const losers  = holdings.filter(h => h.gain_pct < 0).length;
    const trendLabel = summary.avg_gain_pct > 1 ? 'Bullish' : summary.avg_gain_pct < -1 ? 'Bearish' : 'Neutral';
    const trendColor = summary.avg_gain_pct > 0 ? upColor : summary.avg_gain_pct < 0 ? dnColor : 'var(--muted)';
    const trendIcon  = summary.avg_gain_pct > 1 ? '↑' : summary.avg_gain_pct < -1 ? '↓' : '→';

    document.title = `${portfolio.name} — Shared Portfolio`;

    root.innerHTML = `
      <style>
        .hdr{background:linear-gradient(135deg,${color}22,transparent);border-bottom:1px solid var(--line);padding:28px 24px 20px}
        .inner{max-width:680px;margin:0 auto}
        .hdr-row{display:flex;align-items:center;gap:14px}
        .port-ic{width:52px;height:52px;border-radius:14px;background:${color};display:flex;align-items:center;justify-content:center;font-size:24px;flex-shrink:0}
        .port-name{font-size:22px;font-weight:800}
        .port-sub{font-size:13px;color:var(--muted);margin-top:3px}
        .kpis{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-top:20px}
        .kpi{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 14px}
        .kpi .lbl{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
        .kpi .val{font-size:22px;font-weight:800;margin-top:5px}
        .body{max-width:680px;margin:0 auto;padding:24px 24px 60px}
        .sec-lbl{font-size:13px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.6px;margin-bottom:14px}

        /* Trend card */
        .trend-card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px 20px;margin-bottom:24px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
        .trend-label{font-size:18px;font-weight:800}
        .trend-sub{font-size:12px;color:var(--muted);margin-top:3px}
        .trend-bars{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
        .trend-pill{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:700;padding:4px 10px;border-radius:999px}
        .trend-pill.up{background:rgba(45,212,167,.12);color:var(--green);border:1px solid rgba(45,212,167,.3)}
        .trend-pill.dn{background:rgba(255,92,122,.12);color:var(--red);border:1px solid rgba(255,92,122,.3)}
        .trend-pill.nt{background:rgba(139,151,181,.1);color:var(--muted);border:1px solid rgba(139,151,181,.2)}
        .trend-track{height:6px;border-radius:4px;background:rgba(255,255,255,.06);overflow:hidden;margin-top:10px;width:100%}
        .trend-fill-up{height:100%;border-radius:4px;background:var(--green);float:left}
        .trend-fill-dn{height:100%;border-radius:4px;background:var(--red);float:right}

        /* Holdings */
        .holdings{display:flex;flex-direction:column;gap:10px}
        .holding{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px;animation:rise .4s ease both}
        .h-row{display:flex;align-items:center;gap:12px}
        .h-ic{width:44px;height:44px;border-radius:12px;background:${color}22;border:1px solid ${color}44;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:11px;color:${color};flex-shrink:0}
        .h-sym{font-weight:700;font-size:15px}
        .h-right{text-align:right;flex-shrink:0;margin-left:auto}
        .h-gain{font-size:18px;font-weight:800}
        .h-day{font-size:11px;font-weight:600;margin-top:2px}
        .h-bottom{margin-top:10px;padding-top:10px;border-top:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
        .alloc-group{display:flex;flex-direction:column;gap:4px;flex:1}
        .alloc-row{display:flex;align-items:center;justify-content:space-between;font-size:12px}
        .alloc-lbl{color:var(--muted)}
        .alloc-val{font-weight:700}
        .bar-wrap{height:5px;border-radius:4px;background:var(--card-2,#1c2440);overflow:hidden}
        .bar-fill{height:100%;border-radius:4px}

        .footer{margin-top:40px;text-align:center;color:var(--muted);font-size:12px}
        @media(max-width:480px){
          .kpis{grid-template-columns:1fr 1fr}
          .hdr{padding:18px 16px 14px}
          .body{padding:16px 16px 48px}
          .port-name{font-size:18px}
          .kpi .val{font-size:18px}
          .h-gain{font-size:16px}
        }
        @media(max-width:380px){
          .kpis{grid-template-columns:1fr}
          .kpi .val{font-size:16px}
        }
      </style>

      <div class="hdr">
        <div class="inner">
          <div class="hdr-row">
            <div class="port-ic">📈</div>
            <div>
              <div class="port-name">${esc(portfolio.name)}</div>
              <div class="port-sub">Shared portfolio · Read-only${portfolio.strategy ? ' · ' + esc(portfolio.strategy) : ''}</div>
            </div>
          </div>
          <div class="kpis">
            ${kpiHtml('Holdings', summary.stock_count, 'var(--accent)')}
            ${kpiHtml('Avg Return', pct(summary.avg_gain_pct), summary.avg_gain_pct >= 0 ? upColor : dnColor)}
            ${kpiHtml('Today', pct(summary.avg_day_change_pct), summary.avg_day_change_pct >= 0 ? upColor : dnColor)}
          </div>
        </div>
      </div>

      <div class="body">
        <!-- Portfolio trend section -->
        <div class="trend-card">
          <div>
            <div class="trend-label" style="color:${trendColor}">${trendIcon} ${trendLabel}</div>
            <div class="trend-sub">${gainers} of ${holdings.length} position${holdings.length !== 1 ? 's' : ''} gaining · ${losers} declining</div>
          </div>
          <div class="trend-bars">
            <span class="trend-pill up">↑ ${gainers} up</span>
            ${losers > 0 ? `<span class="trend-pill dn">↓ ${losers} down</span>` : ''}
            ${holdings.length - gainers - losers > 0 ? `<span class="trend-pill nt">→ ${holdings.length - gainers - losers} flat</span>` : ''}
          </div>
          ${holdings.length > 0 ? `
          <div class="trend-track" style="clear:both">
            <div class="trend-fill-up" style="width:${(gainers/holdings.length*100).toFixed(1)}%"></div>
            <div class="trend-fill-dn" style="width:${(losers/holdings.length*100).toFixed(1)}%"></div>
          </div>` : ''}
        </div>

        <div class="sec-lbl">Holdings (${holdings.length})</div>
        <div class="holdings">
          ${holdings.map((h, i) => holdingHtml(h, i, color, upColor, dnColor)).join('')}
        </div>
        <div class="footer">
          <div>Shared portfolio · Read-only view · Percentages only</div>
          <div style="margin-top:4px;font-size:11px">Viewed ${view_count.toLocaleString()} time${view_count !== 1 ? 's' : ''}</div>
        </div>
      </div>
    `;
  }

  function kpiHtml(label, value, color) {
    return `<div class="kpi"><div class="lbl">${label}</div><div class="val" style="color:${color}">${value}</div></div>`;
  }

  function holdingHtml(h, i, color, upColor, dnColor) {
    const gainColor = h.gain_pct >= 0 ? upColor : dnColor;
    const dayColor  = h.day_change_pct >= 0 ? upColor : dnColor;
    const allocPct  = h.allocation_pct;
    return `
      <div class="holding" style="animation-delay:${i * 0.04}s">
        <div class="h-row">
          <div class="h-ic">${esc(h.symbol)}</div>
          <div style="flex:1;min-width:0">
            <div class="h-sym">${esc(h.symbol)}</div>
          </div>
          <div class="h-right">
            <div class="h-gain" style="color:${gainColor}">${pct(h.gain_pct)}</div>
            <div class="h-day" style="color:${dayColor}">${pct(h.day_change_pct)} today</div>
          </div>
        </div>
        ${allocPct != null ? `
        <div class="h-bottom">
          <div class="alloc-group">
            <div class="alloc-row">
              <span class="alloc-lbl">Portfolio allocation</span>
              <span class="alloc-val">${Number(allocPct).toFixed(1)}%</span>
            </div>
            <div class="bar-wrap">
              <div class="bar-fill" style="width:${Math.min(allocPct, 100)}%;background:${gainColor}"></div>
            </div>
          </div>
        </div>` : ''}
      </div>
    `;
  }
})();
