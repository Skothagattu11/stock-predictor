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
        .holdings{display:flex;flex-direction:column;gap:10px}
        .holding{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px;animation:rise .4s ease both}
        .h-row{display:flex;align-items:flex-start;gap:12px}
        .h-ic{width:44px;height:44px;border-radius:12px;background:${color}22;border:1px solid ${color}44;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:11px;color:${color};flex-shrink:0}
        .h-info{flex:1;min-width:0}
        .h-sym{font-weight:700;font-size:15px}
        .h-meta{font-size:12px;color:var(--muted);margin-top:2px}
        .h-right{text-align:right;flex-shrink:0}
        .h-gain{font-size:16px;font-weight:800}
        .h-day{font-size:11px;font-weight:600;margin-top:3px}
        .h-stats{margin-top:12px;padding-top:10px;border-top:1px solid var(--line);display:flex;gap:20px;align-items:center}
        .h-stat .lbl{font-size:11px;color:var(--muted)}
        .h-stat .val{font-size:14px;font-weight:700;margin-top:2px}
        .alloc-pct{flex:1;text-align:right}
        .alloc-pct .lbl{font-size:11px;color:var(--muted)}
        .alloc-pct .val{font-size:14px;font-weight:700;margin-top:2px}
        .bar-wrap{margin-top:8px;height:6px;border-radius:4px;background:var(--card-2,#1c2440);overflow:hidden}
        .bar-fill{height:100%;border-radius:4px}
        .footer{margin-top:40px;text-align:center;color:var(--muted);font-size:12px}
        @media(max-width:480px){.kpis{grid-template-columns:1fr 1fr}.h-stats{gap:12px}}
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
            ${kpiHtml('Avg Gain', pct(summary.avg_gain_pct), summary.avg_gain_pct >= 0 ? upColor : dnColor)}
            ${kpiHtml('Today', pct(summary.avg_day_change_pct), summary.avg_day_change_pct >= 0 ? upColor : dnColor)}
          </div>
        </div>
      </div>

      <div class="body">
        <div class="sec-lbl">Holdings (${holdings.length})</div>
        <div class="holdings">
          ${holdings.map((h, i) => holdingHtml(h, i, color, upColor, dnColor)).join('')}
        </div>
        <div class="footer">
          <div>Powered by Portfolio Manager · Read-only shared view</div>
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
    const dayColor = h.day_change_pct >= 0 ? upColor : dnColor;
    const allocPct = h.allocation_pct;
    return `
      <div class="holding" style="animation-delay:${i * 0.04}s">
        <div class="h-row">
          <div class="h-ic">${esc(h.symbol)}</div>
          <div class="h-info">
            <div class="h-sym">${esc(h.symbol)}</div>
          </div>
          <div class="h-right">
            <div class="h-gain" style="color:${gainColor}">${pct(h.gain_pct)}</div>
            <div class="h-day" style="color:${dayColor}">${pct(h.day_change_pct)} today</div>
          </div>
        </div>
        <div class="h-stats">
          <div class="h-stat"><div class="lbl">Entry</div><div class="val">${dollar(h.entry_price)}</div></div>
          <div class="h-stat"><div class="lbl">Now</div><div class="val">${dollar(h.current_price)}</div></div>
          ${h.shares != null ? `<div class="h-stat"><div class="lbl">Shares</div><div class="val">${h.shares}</div></div>` : ''}
          ${h.target_sell_price ? `<div class="h-stat"><div class="lbl">Target</div><div class="val" style="color:${upColor}">${dollar(h.target_sell_price)}</div></div>` : ''}
          ${h.stop_loss_price ? `<div class="h-stat"><div class="lbl">Stop</div><div class="val" style="color:${dnColor}">${dollar(h.stop_loss_price)}</div></div>` : ''}
          ${allocPct != null ? `<div class="alloc-pct"><div class="lbl">Allocation</div><div class="val">${Number(allocPct).toFixed(1)}%</div></div>` : ''}
        </div>
        ${allocPct != null ? `
          <div class="bar-wrap">
            <div class="bar-fill" style="width:${Math.min(allocPct, 100)}%;background:${gainColor}"></div>
          </div>` : ''}
      </div>
    `;
  }
})();
