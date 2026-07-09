(() => {
  'use strict';

  // ── Auth guard ─────────────────────────────────────────────────────────────
  const token = localStorage.getItem('wm_token');
  if (!token) { window.location.href = '/login.html'; }
  const userRaw = localStorage.getItem('wm_user');
  const user = userRaw ? JSON.parse(userRaw) : {};
  document.getElementById('userEmail').textContent = user.email || 'Manager';

  function logout() {
    localStorage.removeItem('wm_token');
    localStorage.removeItem('wm_user');
    window.location.href = '/login.html';
  }
  window.logout = logout;

  // ── API helpers ────────────────────────────────────────────────────────────
  async function api(path, opts = {}) {
    const res = await fetch('/api/manager' + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(opts.headers || {}) },
    });
    if (res.status === 401) { logout(); return null; }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  // Fetch real price via Yahoo Finance (/api/price — no Finnhub key needed)
  async function fetchQuote(symbol) {
    try {
      const r = await fetch(`/api/price/${encodeURIComponent(symbol)}`);
      if (!r.ok) return null;
      const q = await r.json();
      if (!q || q.price == null) return null;
      const dayChangePct = q.prevClose ? ((q.price - q.prevClose) / q.prevClose) * 100 : 0;
      return { price: q.price, prevClose: q.prevClose, dayChangePct };
    } catch { return null; }
  }

  async function fetchQuotes(symbols) {
    const map = {};
    await Promise.all([...new Set(symbols)].map(async sym => {
      map[sym] = await fetchQuote(sym);
    }));
    return map;
  }

  // ── Live price polling (refreshes positions table every 30s) ───────────────
  let pricePollingTimer = null;

  function stopPricePolling() {
    if (pricePollingTimer) { clearInterval(pricePollingTimer); pricePollingTimer = null; }
  }

  function startPricePolling(symbols) {
    stopPricePolling();
    if (!symbols.length) return;
    pricePollingTimer = setInterval(async () => {
      const fresh = await fetchQuotes(symbols);
      Object.assign(liveQuotes, fresh);
      refreshPriceDisplay();
    }, 30_000);
  }

  function refreshPriceDisplay() {
    const wrap = document.getElementById('posTableWrap');
    if (!wrap || !selectedPortfolio) return;
    wrap.innerHTML = renderPosTable(selectedPortfolio.portfolio_positions || [], selectedPortfolio.id);
    const ts = document.getElementById('priceTimestamp');
    if (ts) {
      const t = new Date();
      ts.textContent = `Updated ${t.getHours().toString().padStart(2,'0')}:${t.getMinutes().toString().padStart(2,'0')}:${t.getSeconds().toString().padStart(2,'0')}`;
    }
  }

  // Ticker search using existing /api/search endpoint
  let searchDebounce = null;
  async function searchTickers(q, callback) {
    clearTimeout(searchDebounce);
    if (!q || q.length < 1) { callback([]); return; }
    searchDebounce = setTimeout(async () => {
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const data = await r.json();
        callback(Array.isArray(data) ? data.slice(0, 8) : []);
      } catch { callback([]); }
    }, 220);
  }

  // ── Toast ──────────────────────────────────────────────────────────────────
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2800);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  const COLORS = ['#5b8cff','#2fd17c','#ff5c6c','#ffbf47','#a78bfa','#38bdf8'];
  function avatarColor(name) { return COLORS[name.charCodeAt(0) % COLORS.length]; }
  function initials(name) { return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2); }
  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function num(n, d=2) { return n != null ? Number(n).toFixed(d) : '—'; }
  function dollar(n) { return n != null ? '$' + num(n) : '—'; }
  function fmtShares(n) {
    if (n == null) return '—';
    const s = Number(n);
    if (Number.isInteger(s)) return s.toLocaleString();
    return s.toFixed(4).replace(/\.?0+$/, '');
  }
  function pct(n) { if (n == null) return '—'; return (n >= 0 ? '+' : '') + num(n) + '%'; }
  function pctColor(n) { return n >= 0 ? 'var(--green)' : 'var(--red)'; }
  function fmtDate(s) {
    if (!s) return '—';
    const d = new Date(s);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' +
      d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let allClients = [];
  let selectedClient = null;
  let selectedPortfolio = null;
  let sellPositionId = null;
  let liveQuotes = {};           // symbol -> quote
  let posFilterQuery = '';

  // ── Load clients ───────────────────────────────────────────────────────────
  async function loadClients() {
    try {
      allClients = await api('/clients') || [];
      renderClientList(allClients);
      updateKpis();
    } catch (e) {
      document.getElementById('clientList').innerHTML = `<div class="empty-state">${e.message}</div>`;
    }
  }

  function renderClientList(clients) {
    const el = document.getElementById('clientList');
    if (!clients.length) {
      el.innerHTML = '<div class="empty-state">No clients yet. Add your first client →</div>';
      return;
    }
    el.innerHTML = clients.map(c => `
      <div class="client-item ${selectedClient?.id === c.id ? 'active' : ''}" onclick="selectClient('${c.id}')">
        <div class="client-av" style="background:${avatarColor(c.full_name)}22;color:${avatarColor(c.full_name)}">${initials(c.full_name)}</div>
        <div class="client-info">
          <div class="client-name">${esc(c.full_name)}</div>
          <div class="client-meta">
            ${c.email ? esc(c.email) + ' · ' : ''}
            <span class="risk-badge risk-${c.risk_profile}">${c.risk_profile}</span>
          </div>
        </div>
      </div>
    `).join('');
  }

  function filterClients(q) {
    const fl = allClients.filter(c =>
      c.full_name.toLowerCase().includes(q.toLowerCase()) ||
      (c.email || '').toLowerCase().includes(q.toLowerCase())
    );
    renderClientList(fl);
  }
  window.filterClients = filterClients;

  function updateKpis() {
    document.getElementById('kpiClients').textContent = allClients.length;
    const counts = { conservative: 0, moderate: 0, aggressive: 0 };
    allClients.forEach(c => { counts[c.risk_profile] = (counts[c.risk_profile] || 0) + 1; });
    const parts = Object.entries(counts).filter(([,v]) => v > 0).map(([k,v]) => `${v} ${k.slice(0,4)}`);
    document.getElementById('kpiRisk').textContent = parts.join(' / ') || '—';
  }

  // ── Select client ──────────────────────────────────────────────────────────
  async function selectClient(id) {
    stopPricePolling();
    selectedClient = allClients.find(c => c.id === id);
    selectedPortfolio = null;
    liveQuotes = {};
    renderClientList(allClients);
    const detail = document.getElementById('detailArea');
    const backBar = '<div class="mob-back-bar"><button class="btn sm" onclick="closeMobileDetail()">← Clients</button></div>';
    detail.innerHTML = backBar + '<div class="section"><div class="sec-body" style="padding:32px;text-align:center;color:var(--muted)">Loading…</div></div>';
    document.getElementById('mainLayout')?.classList.add('detail-open');
    try {
      const client = await api(`/clients/${id}`);
      selectedClient = client;
      renderClientDetail(client);
    } catch (e) {
      detail.innerHTML = backBar + `<div class="section"><div class="sec-body">${e.message}</div></div>`;
    }
  }
  window.selectClient = selectClient;

  function closeMobileDetail() {
    document.getElementById('mainLayout')?.classList.remove('detail-open');
    selectedClient = null;
    renderClientList(allClients);
  }
  window.closeMobileDetail = closeMobileDetail;

  function renderClientDetail(client) {
    const portfolios = client.client_portfolios || [];
    const totalPositions = portfolios.reduce((s, p) => s + (p.portfolio_positions?.length || 0), 0);
    document.getElementById('kpiPortfolios').textContent = portfolios.length;
    document.getElementById('kpiPositions').textContent = totalPositions;

    document.getElementById('detailArea').innerHTML = `
      <!-- Mobile back navigation -->
      <div class="mob-back-bar">
        <button class="btn sm" onclick="closeMobileDetail()">← Clients</button>
        <span style="font-size:14px;font-weight:700">${esc(client.full_name)}</span>
      </div>

      <!-- Portfolios (shown first so user picks one before seeing profile) -->
      <div class="section">
        <div class="sec-hdr">
          <h3>Portfolios — ${esc(client.full_name)}</h3>
          <button class="btn primary sm" onclick="openPortModal('${client.id}')">+ New portfolio</button>
        </div>
        <div class="sec-body">
          ${portfolios.length === 0
            ? '<div style="color:var(--muted);font-size:13px">No portfolios yet. Create one to start tracking positions.</div>'
            : `<div class="port-grid">${portfolios.map(p => portCard(p)).join('')}</div>`
          }
        </div>
      </div>

      <!-- Portfolio detail (share + positions + history) injected here -->
      <div id="portfolioSection"></div>

      <!-- Client profile (below portfolios) -->
      <div class="section">
        <div class="sec-hdr">
          <h3>Client profile</h3>
          <div style="display:flex;gap:8px">
            <button class="btn sm" onclick="openClientModal('${client.id}')">Edit</button>
            <button class="btn sm danger" onclick="deleteClient('${client.id}')">Delete</button>
          </div>
        </div>
        <div class="sec-body">
          <div class="profile-grid">
            <div class="profile-field"><span>Email</span><b>${client.email ? esc(client.email) : '—'}</b></div>
            <div class="profile-field"><span>Phone</span><b>${client.phone ? esc(client.phone) : '—'}</b></div>
            <div class="profile-field"><span>Risk profile</span><b><span class="risk-badge risk-${client.risk_profile}">${client.risk_profile}</span></b></div>
            <div class="profile-field"><span>Investment goal</span><b>${client.investment_goal ? esc(client.investment_goal) : '—'}</b></div>
            ${client.notes ? `<div class="profile-field" style="grid-column:1/-1"><span>Notes</span><b>${esc(client.notes)}</b></div>` : ''}
          </div>
        </div>
      </div>
    `;
  }

  function portCard(p) {
    const cnt = p.portfolio_positions?.length || 0;
    return `
      <div class="port-card ${selectedPortfolio?.id === p.id ? 'active-port' : ''}" onclick="selectPortfolio('${p.id}')">
        <div class="port-actions">
          <button class="btn sm danger" onclick="event.stopPropagation();deletePortfolio('${p.id}')" title="Delete">✕</button>
        </div>
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
          <div style="width:14px;height:14px;border-radius:4px;background:${esc(p.color)};flex-shrink:0"></div>
          <div class="port-name">${esc(p.name)}</div>
        </div>
        ${p.strategy ? `<div class="port-meta">${esc(p.strategy)}</div>` : ''}
        <div class="port-count">${cnt} position${cnt !== 1 ? 's' : ''}</div>
      </div>`;
  }

  // ── Select portfolio ───────────────────────────────────────────────────────
  async function selectPortfolio(id) {
    stopPricePolling();
    const section = document.getElementById('portfolioSection');
    if (!section) return;
    section.innerHTML = '<div class="section"><div class="sec-body" style="padding:24px;text-align:center;color:var(--muted)">Loading live prices…</div></div>';

    try {
      const [portfolio, history] = await Promise.all([
        api(`/portfolios/${id}`),
        api(`/portfolios/${id}/history`),
      ]);
      selectedPortfolio = portfolio;
      posFilterQuery = '';

      const positions = portfolio.portfolio_positions || [];
      const symbols = [...new Set(positions.map(p => p.symbol))];
      liveQuotes = await fetchQuotes(symbols);

      const shareData = await api(`/portfolios/${id}/share`).catch(() => null);
      renderPortfolioSection(portfolio, history || [], shareData);

      // Refresh prices every 30s while this portfolio is open
      startPricePolling(symbols);
    } catch (e) {
      section.innerHTML = `<div class="section"><div class="sec-body">${e.message}</div></div>`;
    }
  }
  window.selectPortfolio = selectPortfolio;

  function renderPortfolioSection(portfolio, history, shareData) {
    const positions = portfolio.portfolio_positions || [];
    const section = document.getElementById('portfolioSection');
    if (!section) return;

    // Compute portfolio summary from live quotes
    let totalInvested = 0, totalCurrent = 0;
    positions.forEach(p => {
      const q = liveQuotes[p.symbol];
      const curr = q?.price ?? p.entry_price;
      if (p.shares) { totalInvested += p.shares * p.entry_price; totalCurrent += p.shares * curr; }
    });
    const totalGainPct = totalInvested > 0 ? ((totalCurrent - totalInvested) / totalInvested) * 100 : null;

    section.innerHTML = `
      <!-- ① Share link — always at the very top -->
      <div class="section">
        <div class="sec-hdr">
          <h3 style="display:flex;align-items:center;gap:8px">
            <span style="width:10px;height:10px;border-radius:3px;background:${esc(portfolio.color)};display:inline-block"></span>
            ${esc(portfolio.name)} — Share link
          </h3>
          <span style="font-size:12px;font-weight:600;${shareData?.is_active ? 'color:var(--green)' : 'color:var(--muted)'}">
            ${shareData?.is_active ? '● Active' : '○ Inactive'}
          </span>
        </div>
        <div class="sec-body">
          ${shareData ? renderShareBox(portfolio.id, shareData) : '<div style="color:var(--muted);font-size:13px">Generating link…</div>'}
        </div>
      </div>

      <!-- ② Portfolio summary KPIs -->
      <div class="sum-kpis" style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:0">
        ${summaryKpi('Positions', positions.length, 'var(--blue)')}
        ${summaryKpi('Portfolio value', totalCurrent > 0 ? '$' + num(totalCurrent) : '—', 'var(--text)')}
        ${summaryKpi('Total gain', totalGainPct != null ? pct(totalGainPct) : '—', totalGainPct != null ? pctColor(totalGainPct) : 'var(--muted)')}
      </div>

      <!-- ③ Positions with live prices + search -->
      <div class="section">
        <div class="sec-hdr">
          <div style="display:flex;align-items:center;gap:10px">
            <h3>Positions</h3>
            <span id="priceTimestamp" style="font-size:11px;color:var(--green);font-weight:600;background:rgba(47,209,124,.1);border:1px solid rgba(47,209,124,.25);border-radius:6px;padding:2px 8px">Live · Yahoo</span>
          </div>
          <div class="pos-hdr-controls" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <div style="position:relative">
              <input class="pos-search-input" type="text" placeholder="Filter by ticker or name…"
                value="${esc(posFilterQuery)}"
                oninput="filterPositions(this.value,'${portfolio.id}')"
                style="background:#0a1220;border:1px solid var(--line);color:var(--text);border-radius:8px;padding:7px 11px;font-size:13px;width:200px;outline:none" />
            </div>
            <button class="btn primary sm" onclick="openPosModal('${portfolio.id}')">+ Add position</button>
          </div>
        </div>
        <div class="sec-body" style="padding:0" id="posTableWrap">
          ${renderPosTable(positions, portfolio.id)}
        </div>
      </div>

      <!-- ④ Trade history -->
      <div class="section">
        <div class="sec-hdr"><h3>Trade history</h3></div>
        <div class="sec-body">
          ${history.length === 0
            ? '<div style="color:var(--muted);font-size:13px">No trade history yet.</div>'
            : `<div class="timeline">${history.map(h => histItem(h)).join('')}</div>`
          }
        </div>
      </div>
    `;
    // Init Flatpickr after DOM update (innerHTML assignment is synchronous)
    initExpiryPicker();
  }

  function summaryKpi(label, value, color) {
    return `<div style="background:linear-gradient(180deg,rgba(17,27,45,.92),rgba(10,16,27,.92));border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:14px 16px;margin-bottom:16px">
      <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em">${label}</div>
      <div style="font-size:20px;font-weight:800;margin-top:5px;color:${color}">${value}</div>
    </div>`;
  }

  function renderPosTable(allPositions, portfolioId) {
    const filtered = posFilterQuery
      ? allPositions.filter(p => p.symbol.toLowerCase().includes(posFilterQuery.toLowerCase()))
      : allPositions;

    if (allPositions.length === 0) {
      return '<div style="padding:24px;color:var(--muted);font-size:13px">No positions yet. Add your first stock.</div>';
    }
    if (filtered.length === 0) {
      return '<div style="padding:24px;color:var(--muted);font-size:13px">No positions match "' + esc(posFilterQuery) + '".</div>';
    }

    return `<table class="pos-table">
      <thead><tr>
        <th>Symbol</th>
        <th>Avg Cost</th>
        <th>Shares</th>
        <th>Live Price</th>
        <th>P&amp;L</th>
        <th>Day</th>
        <th>Mkt Value / Cost</th>
        <th>Target / Stop</th>
        <th></th>
      </tr></thead>
      <tbody>${filtered.map(p => posRow(p, portfolioId)).join('')}</tbody>
    </table>
    <div class="pos-cards">${filtered.map(p => posCard(p, portfolioId)).join('')}</div>`;
  }

  function posRow(p, portfolioId) {
    const q = liveQuotes[p.symbol];
    const livePrice = q?.price ?? null;
    const dayPct    = q?.dayChangePct ?? null;
    const mktValue  = livePrice != null && p.shares ? p.shares * livePrice : null;
    const costBasis = p.entry_price && p.shares ? p.entry_price * p.shares : null;
    const plDollar  = mktValue != null && costBasis != null ? mktValue - costBasis : null;
    const gainPct   = livePrice != null && p.entry_price
      ? ((livePrice - p.entry_price) / p.entry_price) * 100 : null;

    const livePriceHtml = livePrice != null
      ? `<span style="font-weight:700">${dollar(livePrice)}</span>`
      : '<span style="color:var(--muted)">—</span>';

    // Combined P&L: "$+2,250 / +12.3%" stacked
    const plHtml = gainPct != null
      ? `<div style="color:${pctColor(gainPct)};font-weight:700;white-space:nowrap">
           ${plDollar != null ? (plDollar >= 0 ? '+' : '') + dollar(plDollar) : ''}
         </div>
         <div style="color:${pctColor(gainPct)};font-size:11px">${pct(gainPct)}</div>`
      : '<span style="color:var(--muted)">—</span>';

    const dayHtml = dayPct != null
      ? `<span style="color:${pctColor(dayPct)}">${pct(dayPct)}</span>`
      : '<span style="color:var(--muted)">—</span>';

    // Market value with cost basis below it
    const valueHtml = mktValue != null
      ? `<div style="font-weight:700">${dollar(mktValue)}</div>
         ${costBasis != null ? `<div style="font-size:11px;color:var(--muted)">Cost ${dollar(costBasis)}</div>` : ''}`
      : '<span style="color:var(--muted)">—</span>';

    const targetStop = [
      p.target_sell_price ? `<span class="up" title="Target">▲${dollar(p.target_sell_price)}</span>` : '',
      p.stop_loss_price   ? `<span class="dn" title="Stop">▼${dollar(p.stop_loss_price)}</span>` : '',
    ].filter(Boolean).join(' ') || '—';

    return `<tr>
      <td>
        <div class="pos-sym">${esc(p.symbol)}</div>
        ${p.note ? `<div style="font-size:11px;color:var(--muted)">${esc(p.note)}</div>` : ''}
      </td>
      <td class="pos-price">${dollar(p.entry_price)}</td>
      <td>${fmtShares(p.shares)}</td>
      <td class="pos-price">${livePriceHtml}</td>
      <td>${plHtml}</td>
      <td>${dayHtml}</td>
      <td class="pos-price">${valueHtml}</td>
      <td style="font-size:12px">${targetStop}</td>
      <td class="pos-actions">
        <button class="btn sm" onclick="openSignalDash('${esc(p.symbol)}')" title="View on signal dashboard">📈</button>
        <button class="btn sm" onclick="window.open('/analyst.html?ticker=${encodeURIComponent(p.symbol)}','_blank')" title="AI equity analyst report">Analyst</button>
        <button class="btn sm" onclick="openEditPosModal('${p.id}')" title="Edit position">Edit</button>
        <button class="btn sm danger" onclick="openSellModal('${p.id}','${esc(p.symbol)}',${livePrice ?? p.entry_price})" title="Close position">Sell</button>
        <button class="btn sm danger" onclick="deletePosition('${p.id}','${esc(p.symbol)}')" title="Delete position">✕</button>
      </td>
    </tr>`;
  }

  // Mobile position card (collapsed by default, tap to expand)
  function posCard(p, portfolioId) {
    const q          = liveQuotes[p.symbol];
    const livePrice  = q?.price ?? null;
    const dayPct     = q?.dayChangePct ?? null;
    const mktValue   = livePrice != null && p.shares ? p.shares * livePrice : null;
    const costBasis  = p.entry_price && p.shares ? p.entry_price * p.shares : null;
    const plDollar   = mktValue != null && costBasis != null ? mktValue - costBasis : null;
    const gainPct    = livePrice != null && p.entry_price
      ? ((livePrice - p.entry_price) / p.entry_price) * 100 : null;
    const gainHtml = gainPct != null
      ? `<span style="color:${pctColor(gainPct)};font-weight:700;font-size:13px">${pct(gainPct)}</span>` : '';
    const dayHtml = dayPct != null
      ? `<span style="color:${pctColor(dayPct)};font-size:12px">${pct(dayPct)} today</span>` : '';
    const plDollarHtml = plDollar != null
      ? `<span style="color:${pctColor(plDollar)};font-size:12px">${plDollar >= 0 ? '+' : ''}${dollar(plDollar)}</span>` : '';
    return `
      <div class="pos-card-mob">
        <div class="pos-card-head" onclick="toggleMobPos(this.parentElement)">
          <span class="pos-sym" style="font-size:16px;flex-shrink:0">${esc(p.symbol)}</span>
          <span style="flex:1;display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0">${gainHtml}${plDollarHtml}${dayHtml}</span>
          <span class="pos-chev">▾</span>
        </div>
        <div class="pos-card-body">
          ${livePrice != null ? `<div class="mob-field"><span>Live price</span><b>${dollar(livePrice)}</b></div>` : ''}
          <div class="mob-field"><span>Avg cost / share</span><b>${dollar(p.entry_price)}</b></div>
          ${p.shares != null ? `<div class="mob-field"><span>Shares</span><b>${fmtShares(p.shares)}</b></div>` : ''}
          ${costBasis != null ? `<div class="mob-field"><span>Cost basis</span><b>${dollar(costBasis)}</b></div>` : ''}
          ${mktValue != null ? `<div class="mob-field"><span>Market value</span><b>${dollar(mktValue)}</b></div>` : ''}
          ${p.target_sell_price ? `<div class="mob-field"><span>Target</span><b class="up">${dollar(p.target_sell_price)}</b></div>` : ''}
          ${p.stop_loss_price ? `<div class="mob-field"><span>Stop loss</span><b class="dn">${dollar(p.stop_loss_price)}</b></div>` : ''}
          ${p.note ? `<div class="mob-field"><span>Note</span><b style="font-size:12px;font-weight:400">${esc(p.note)}</b></div>` : ''}
          <div class="mob-actions">
            <button class="btn sm" onclick="openSignalDash('${esc(p.symbol)}')">📈</button>
            <button class="btn sm" onclick="window.open('/analyst.html?ticker=${encodeURIComponent(p.symbol)}','_blank')">Analyst</button>
            <button class="btn sm" onclick="openEditPosModal('${p.id}')">Edit</button>
            <button class="btn sm danger" onclick="openSellModal('${p.id}','${esc(p.symbol)}',${livePrice ?? p.entry_price})">Sell</button>
            <button class="btn sm danger" onclick="deletePosition('${p.id}','${esc(p.symbol)}')">✕</button>
          </div>
        </div>
      </div>`;
  }

  function toggleMobPos(card) {
    const body = card.querySelector('.pos-card-body');
    const chev = card.querySelector('.pos-chev');
    const isOpen = body.style.display === 'block';
    body.style.display = isOpen ? 'none' : 'block';
    if (chev) chev.style.transform = isOpen ? '' : 'rotate(180deg)';
  }
  window.toggleMobPos = toggleMobPos;

  // Open symbol in signal dashboard (new tab)
  function openSignalDash(symbol) {
    window.open('/?sym=' + encodeURIComponent(symbol), '_blank');
  }
  window.openSignalDash = openSignalDash;

  // Filter positions table without re-fetching
  function filterPositions(q, portfolioId) {
    posFilterQuery = q;
    if (!selectedPortfolio) return;
    const wrap = document.getElementById('posTableWrap');
    if (wrap) wrap.innerHTML = renderPosTable(selectedPortfolio.portfolio_positions || [], portfolioId);
  }
  window.filterPositions = filterPositions;

  function histItem(h) {
    const gain = h.gain_pct != null
      ? (h.gain_pct >= 0 ? `<span class="up">+${num(h.gain_pct)}%</span>` : `<span class="dn">${num(h.gain_pct)}%</span>`)
      : '';
    return `
      <div class="hist-item">
        <span class="hist-badge ${h.event_type}">${h.event_type}</span>
        <div class="hist-content">
          <div class="hist-top">
            <span class="hist-sym">${esc(h.symbol)}</span>
            <span class="hist-price">@ ${dollar(h.price)}</span>
            ${h.shares ? `<span style="font-size:12px;color:var(--muted)">${h.shares} sh</span>` : ''}
            ${h.total_value ? `<span style="font-size:12px;color:var(--muted)">${dollar(h.total_value)}</span>` : ''}
            ${gain}
            <span class="hist-ts">${fmtDate(h.created_at)}</span>
          </div>
          ${h.note ? `<div class="hist-note">${esc(h.note)}</div>` : ''}
        </div>
      </div>`;
  }

  // ── Share link rendering ───────────────────────────────────────────────────
  function renderShareBox(portfolioId, share) {
    const url = share.share_url || '';
    return `
      <div class="share-box">
        <div class="share-url">
          <input type="text" value="${esc(url)}" id="shareUrlInput" readonly />
          <button class="btn sm primary" onclick="copyShare()">Copy link</button>
          <a href="${esc(url)}" target="_blank" class="btn sm">Preview</a>
        </div>
        <div class="share-meta">
          <span>👁 ${share.view_count} view${share.view_count !== 1 ? 's' : ''}</span>
          <span>Created ${fmtDate(share.created_at)}</span>
          ${share.expires_at ? `<span style="color:var(--amber)">Expires ${fmtDate(share.expires_at)}</span>` : '<span>No expiry</span>'}
        </div>
        <div class="share-controls">
          ${share.is_active
            ? `<button class="btn sm danger" onclick="revokeShare('${portfolioId}')">Revoke link</button>`
            : `<button class="btn sm primary" onclick="reactivateShare('${portfolioId}')">Reactivate</button>`
          }
          <div class="expiry-row">
            <label style="font-size:12px;color:var(--muted)">Expiry:</label>
            <input type="text" id="expiryInput" class="expiry-pretty-input" placeholder="Pick date &amp; time…" readonly
              data-current-expiry="${share.expires_at || ''}" />
            <button class="btn sm" onclick="setExpiry('${portfolioId}')">Set</button>
            ${share.expires_at ? `<button class="btn sm" onclick="clearExpiry('${portfolioId}')">Clear</button>` : ''}
          </div>
        </div>
        ${!share.is_active ? '<div style="font-size:12px;color:var(--red);margin-top:6px">⚠ This share link is currently revoked.</div>' : ''}
      </div>`;
  }

  // Called after innerHTML is set so the expiry input is in the DOM
  function initExpiryPicker() {
    const el = document.getElementById('expiryInput');
    if (!el || !window.flatpickr) return;
    // Destroy any prior instance on re-renders
    if (el._flatpickr) el._flatpickr.destroy();
    const existing = el.dataset.currentExpiry;
    flatpickr(el, {
      enableTime: true,
      dateFormat: 'Z',          // stores ISO 8601 in hidden input
      altInput: true,
      altFormat: 'M j, Y h:i K', // shows "Jun 30, 2026 12:00 PM"
      altInputClass: 'expiry-pretty-input',
      minDate: 'today',
      defaultDate: existing || null,
      theme: 'dark',
      disableMobile: false,
    });
  }

  function copyShare() {
    const el = document.getElementById('shareUrlInput');
    if (!el) return;
    navigator.clipboard.writeText(el.value).then(() => toast('Share link copied!')).catch(() => {
      el.select(); document.execCommand('copy'); toast('Link copied!');
    });
  }
  window.copyShare = copyShare;

  async function revokeShare(portfolioId) {
    if (!confirm('Revoke this share link?')) return;
    try { await api(`/portfolios/${portfolioId}/share`, { method: 'DELETE' }); toast('Revoked'); selectPortfolio(portfolioId); }
    catch (e) { alert(e.message); }
  }
  window.revokeShare = revokeShare;

  async function reactivateShare(portfolioId) {
    try { await api(`/portfolios/${portfolioId}/share`, { method: 'PUT', body: JSON.stringify({ is_active: true }) }); toast('Reactivated'); selectPortfolio(portfolioId); }
    catch (e) { alert(e.message); }
  }
  window.reactivateShare = reactivateShare;

  async function setExpiry(portfolioId) {
    // flatpickr altInput: the hidden original input holds the ISO value (dateFormat:'Z')
    const el = document.getElementById('expiryInput');
    const fp = el?._flatpickr;
    const selectedDate = fp?.selectedDates?.[0];
    if (!selectedDate) { alert('Pick an expiry date first'); return; }
    try {
      await api(`/portfolios/${portfolioId}/share`, { method: 'PUT', body: JSON.stringify({ expires_at: selectedDate.toISOString() }) });
      toast('Expiry set');
      selectPortfolio(portfolioId);
    } catch (e) { alert(e.message); }
  }
  window.setExpiry = setExpiry;

  async function clearExpiry(portfolioId) {
    try { await api(`/portfolios/${portfolioId}/share`, { method: 'PUT', body: JSON.stringify({ expires_at: null }) }); toast('Expiry cleared'); selectPortfolio(portfolioId); }
    catch (e) { alert(e.message); }
  }
  window.clearExpiry = clearExpiry;

  // ── Client modal ───────────────────────────────────────────────────────────
  let editingClientId = null;

  function openClientModal(id = null) {
    editingClientId = id;
    document.getElementById('clientModalTitle').textContent = id ? 'Edit client' : 'New client';
    document.getElementById('clientErr').style.display = 'none';
    if (id && selectedClient) {
      const c = selectedClient;
      document.getElementById('cName').value = c.full_name || '';
      document.getElementById('cEmail').value = c.email || '';
      document.getElementById('cPhone').value = c.phone || '';
      document.getElementById('cRisk').value = c.risk_profile || 'moderate';
      document.getElementById('cGoal').value = c.investment_goal || '';
      document.getElementById('cNotes').value = c.notes || '';
    } else {
      ['cName','cEmail','cPhone','cGoal','cNotes'].forEach(i => { document.getElementById(i).value = ''; });
      document.getElementById('cRisk').value = 'moderate';
    }
    document.getElementById('clientModal').classList.add('open');
  }
  window.openClientModal = openClientModal;

  function closeClientModal() { document.getElementById('clientModal').classList.remove('open'); }
  window.closeClientModal = closeClientModal;

  async function saveClient() {
    const payload = {
      full_name: document.getElementById('cName').value.trim(),
      email: document.getElementById('cEmail').value.trim(),
      phone: document.getElementById('cPhone').value.trim(),
      risk_profile: document.getElementById('cRisk').value,
      investment_goal: document.getElementById('cGoal').value.trim(),
      notes: document.getElementById('cNotes').value.trim(),
    };
    if (!payload.full_name) {
      document.getElementById('clientErr').textContent = 'Full name is required';
      document.getElementById('clientErr').style.display = 'block';
      return;
    }
    try {
      if (editingClientId) {
        await api(`/clients/${editingClientId}`, { method: 'PUT', body: JSON.stringify(payload) });
        toast('Client updated');
      } else {
        await api('/clients', { method: 'POST', body: JSON.stringify(payload) });
        toast('Client created');
      }
      closeClientModal();
      await loadClients();
      if (editingClientId) selectClient(editingClientId);
    } catch (e) {
      document.getElementById('clientErr').textContent = e.message;
      document.getElementById('clientErr').style.display = 'block';
    }
  }
  window.saveClient = saveClient;

  async function deleteClient(id) {
    if (!confirm('Delete this client and all their portfolios? This cannot be undone.')) return;
    try {
      await api(`/clients/${id}`, { method: 'DELETE' });
      toast('Client deleted');
      selectedClient = null;
      document.getElementById('mainLayout')?.classList.remove('detail-open');
      document.getElementById('detailArea').innerHTML = '<div class="detail-empty"><div class="icon">👥</div><div>Select a client to view their portfolios and positions</div></div>';
      await loadClients();
    } catch (e) { alert(e.message); }
  }
  window.deleteClient = deleteClient;

  // ── Portfolio modal ────────────────────────────────────────────────────────
  let portfolioClientId = null;

  function openPortModal(clientId) {
    portfolioClientId = clientId;
    document.getElementById('pName').value = '';
    document.getElementById('pColor').value = '#5b8cff';
    document.getElementById('pStrategy').value = '';
    document.getElementById('portErr').style.display = 'none';
    document.getElementById('portfolioModal').classList.add('open');
  }
  window.openPortModal = openPortModal;

  function closePortModal() { document.getElementById('portfolioModal').classList.remove('open'); }
  window.closePortModal = closePortModal;

  async function savePortfolio() {
    const payload = {
      name: document.getElementById('pName').value.trim(),
      color: document.getElementById('pColor').value,
      strategy: document.getElementById('pStrategy').value.trim(),
    };
    if (!payload.name) {
      document.getElementById('portErr').textContent = 'Portfolio name required';
      document.getElementById('portErr').style.display = 'block';
      return;
    }
    try {
      await api(`/clients/${portfolioClientId}/portfolios`, { method: 'POST', body: JSON.stringify(payload) });
      toast('Portfolio created');
      closePortModal();
      selectClient(portfolioClientId);
    } catch (e) {
      document.getElementById('portErr').textContent = e.message;
      document.getElementById('portErr').style.display = 'block';
    }
  }
  window.savePortfolio = savePortfolio;

  async function deletePortfolio(id) {
    if (!confirm('Delete this portfolio and all its positions?')) return;
    try {
      await api(`/portfolios/${id}`, { method: 'DELETE' });
      toast('Portfolio deleted');
      if (selectedClient) selectClient(selectedClient.id);
    } catch (e) { alert(e.message); }
  }
  window.deletePortfolio = deletePortfolio;

  // ── Position modal with live ticker search ─────────────────────────────────
  let posPortfolioId = null;
  let editingPositionId = null;   // null = add mode, set = edit mode

  function openPosModal(portfolioId) {
    editingPositionId = null;
    posPortfolioId = portfolioId;
    document.getElementById('posModalTitle').textContent = 'Add position';
    document.getElementById('posSaveBtn').textContent = 'Add position';
    document.getElementById('posSymbolWrap').style.display = '';  // show search
    ['posSymbol','posEntry','posShares','posAmount','posTarget','posStop','posNote'].forEach(i => { document.getElementById(i).value = ''; });
    document.getElementById('posSearchResults').innerHTML = '';
    document.getElementById('posSearchResults').style.display = 'none';
    document.getElementById('posErr').style.display = 'none';
    document.getElementById('positionModal').classList.add('open');
    setTimeout(() => document.getElementById('posSymbol').focus(), 80);
  }
  window.openPosModal = openPosModal;

  function openEditPosModal(posId) {
    // Find the position in current portfolio state
    const pos = (selectedPortfolio?.portfolio_positions || []).find(p => p.id === posId);
    if (!pos) { toast('Position not found — refresh and try again'); return; }

    editingPositionId = posId;
    posPortfolioId = pos.portfolio_id;

    document.getElementById('posModalTitle').textContent = `Edit ${pos.symbol}`;
    document.getElementById('posSaveBtn').textContent = 'Save changes';
    // Hide ticker search in edit mode — symbol is not changeable
    document.getElementById('posSymbolWrap').style.display = 'none';

    // Pre-fill fields
    document.getElementById('posEntry').value  = pos.entry_price ?? '';
    document.getElementById('posShares').value = pos.shares ?? '';
    document.getElementById('posAmount').value = (pos.shares && pos.entry_price)
      ? (pos.shares * pos.entry_price).toFixed(2) : '';
    document.getElementById('posTarget').value = pos.target_sell_price ?? '';
    document.getElementById('posStop').value   = pos.stop_loss_price ?? '';
    document.getElementById('posNote').value   = pos.note ?? '';
    document.getElementById('posErr').style.display = 'none';
    document.getElementById('positionModal').classList.add('open');
    setTimeout(() => document.getElementById('posEntry').focus(), 80);
  }
  window.openEditPosModal = openEditPosModal;

  function closePosModal() {
    editingPositionId = null;
    document.getElementById('positionModal').classList.remove('open');
    document.getElementById('posSearchResults').style.display = 'none';
  }
  window.closePosModal = closePosModal;

  // ── 3-field linked entry: price × shares = order value (fill any two, third auto-fills) ──
  function recalcPosInputs() {
    const pEl = document.getElementById('posEntry');
    const sEl = document.getElementById('posShares');
    const aEl = document.getElementById('posAmount');
    const n = v => { const x = parseFloat(v); return x > 0 ? x : null; };
    const P = n(pEl.value), S = n(sEl.value), A = n(aEl.value);
    const active = document.activeElement;
    // Derive the ONE field the user is NOT currently editing
    if (P && S && active !== aEl) aEl.value = (S * P).toFixed(2);
    else if (P && A && active !== sEl) sEl.value = (A / P).toFixed(4);
    else if (S && A && active !== pEl) pEl.value = (A / S).toFixed(4);
  }

  // Ticker search + recalc wiring (after DOM ready)
  document.addEventListener('DOMContentLoaded', () => {
    const symInput = document.getElementById('posSymbol');
    const results  = document.getElementById('posSearchResults');
    if (!symInput) return;

    symInput.addEventListener('input', () => {
      const q = symInput.value.trim();
      symInput.value = q.toUpperCase();
      if (!q) { results.style.display = 'none'; return; }
      searchTickers(q, (hits) => {
        if (!hits.length) { results.style.display = 'none'; return; }
        results.innerHTML = hits.map(h => `
          <div class="search-hit" onclick="pickTicker('${esc(h.symbol)}','${esc(h.description || '')}')">
            <b>${esc(h.symbol)}</b>
            <span>${esc(h.description || '')}</span>
          </div>`).join('');
        results.style.display = 'block';
      });
    });

    symInput.addEventListener('blur', () => {
      setTimeout(() => { results.style.display = 'none'; }, 200);
    });

    // Wire the 3 linked fields
    ['posEntry', 'posShares', 'posAmount'].forEach(id => {
      document.getElementById(id)?.addEventListener('input', recalcPosInputs);
    });
  });

  async function pickTicker(symbol, desc) {
    document.getElementById('posSymbol').value = symbol;
    document.getElementById('posSearchResults').style.display = 'none';
    toast(`${symbol} selected — fetching live price…`);
    const q = await fetchQuote(symbol);
    if (q?.price) {
      if (!document.getElementById('posEntry').value) {
        document.getElementById('posEntry').value = q.price.toFixed(2);
        recalcPosInputs();
      }
      toast(`${symbol} — $${q.price.toFixed(2)} (Yahoo live price pre-filled)`);
    } else {
      toast(`${symbol} selected — enter price manually`);
    }
  }
  window.pickTicker = pickTicker;

  async function savePosition() {
    const n = id => { const v = parseFloat(document.getElementById(id).value); return v > 0 ? v : null; };

    let P = n('posEntry'), S = n('posShares'), A = n('posAmount');
    // Derive missing field from the other two (order value = price × shares)
    if (!P && S && A) P = A / S;
    else if (!S && P && A) S = A / P;
    else if (!A && P && S) A = S * P;

    if (!P) {
      document.getElementById('posErr').textContent = 'Enter at least a price/share (or any two of price, shares, order value)';
      document.getElementById('posErr').style.display = 'block';
      return;
    }

    // ── EDIT mode ──
    if (editingPositionId) {
      const pos = (selectedPortfolio?.portfolio_positions || []).find(p => p.id === editingPositionId);
      const payload = {
        entry_price: P,
        shares: S || null,
        target_sell_price: n('posTarget'),
        stop_loss_price: n('posStop'),
        note: document.getElementById('posNote').value.trim() || undefined,
      };
      const portfolioId = selectedPortfolio?.id;
      try {
        await api(`/positions/${editingPositionId}`, { method: 'PUT', body: JSON.stringify(payload) });
        toast(`${pos?.symbol ?? 'Position'} updated`);
        closePosModal();
        await selectPortfolio(portfolioId);
      } catch (e) {
        document.getElementById('posErr').textContent = e.message;
        document.getElementById('posErr').style.display = 'block';
      }
      return;
    }

    // ── ADD mode ──
    const symbol = document.getElementById('posSymbol').value.trim().toUpperCase();
    if (!symbol) {
      document.getElementById('posErr').textContent = 'Symbol is required — search or type a ticker';
      document.getElementById('posErr').style.display = 'block';
      return;
    }
    const payload = {
      symbol,
      entry_price: P,
      shares: S || null,
      target_sell_price: n('posTarget'),
      stop_loss_price: n('posStop'),
      note: document.getElementById('posNote').value.trim(),
    };
    try {
      await api(`/portfolios/${posPortfolioId}/positions`, { method: 'POST', body: JSON.stringify(payload) });
      toast(`${symbol} added — ${S ? S.toFixed(4).replace(/\.?0+$/, '') + ' sh @ ' : ''}$${P.toFixed(2)}`);
      closePosModal();
      selectPortfolio(posPortfolioId);
    } catch (e) {
      document.getElementById('posErr').textContent = e.message;
      document.getElementById('posErr').style.display = 'block';
    }
  }
  window.savePosition = savePosition;

  // ── Sell modal ─────────────────────────────────────────────────────────────
  function openSellModal(posId, symbol, livePrice) {
    sellPositionId = posId;
    document.getElementById('sellPrice').value = livePrice ? Number(livePrice).toFixed(2) : '';
    document.getElementById('sellNote').value = '';
    document.getElementById('sellErr').style.display = 'none';
    document.getElementById('sellModal').classList.add('open');
  }
  window.openSellModal = openSellModal;

  function closeSellModal() { document.getElementById('sellModal').classList.remove('open'); }
  window.closeSellModal = closeSellModal;

  async function confirmSell() {
    const sellPrice = parseFloat(document.getElementById('sellPrice').value);
    const note = document.getElementById('sellNote').value.trim();
    if (!sellPrice || sellPrice <= 0) {
      document.getElementById('sellErr').textContent = 'Enter a valid sell price';
      document.getElementById('sellErr').style.display = 'block';
      return;
    }
    try {
      const result = await api(`/positions/${sellPositionId}`, {
        method: 'DELETE',
        body: JSON.stringify({ sell_price: sellPrice, note }),
      });
      const sign = result.gain_pct >= 0 ? '+' : '';
      toast(`Closed ${sign}${num(result.gain_pct)}%`);
      closeSellModal();
      if (selectedPortfolio) selectPortfolio(selectedPortfolio.id);
    } catch (e) {
      document.getElementById('sellErr').textContent = e.message;
      document.getElementById('sellErr').style.display = 'block';
    }
  }
  window.confirmSell = confirmSell;

  async function deletePosition(posId, symbol) {
    if (!confirm(`Remove ${symbol} from this portfolio? This won't record a sell — use Sell if you want to log the trade.`)) return;
    const portfolioId = selectedPortfolio?.id;
    try {
      await api(`/positions/${posId}`, { method: 'DELETE', body: JSON.stringify({ delete_only: true }) });
      toast(`${symbol} removed`);
      await selectPortfolio(portfolioId);
    } catch (e) { alert(e.message); }
  }
  window.deletePosition = deletePosition;

  // Close modals on bg click
  document.querySelectorAll('.modal-bg').forEach(bg => {
    bg.addEventListener('click', e => { if (e.target === bg) bg.classList.remove('open'); });
  });

  // Init
  loadClients();
})();
