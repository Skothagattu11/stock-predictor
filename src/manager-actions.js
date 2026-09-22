'use strict';

// Every write operation on the Wealth Manager data model, in one place.
//
// Each function takes the authenticated managerId and does its OWN ownership
// check — callers cannot forget it. Two callers exist: the HTTP routes in
// manager-routes.js, and the agent executor in agent-service.js.
//
// Expected failures return { ok: false, error, code }; they never throw.

function fail(code, error) { return { ok: false, error, code }; }
function done(data) { return { ok: true, data }; }

function createManagerActions({ sb }) {
  // ── ownership helpers ───────────────────────────────────────────────────
  async function ownedClient(managerId, clientId) {
    const { data } = await sb.from('manager_clients')
      .select('id').eq('id', clientId).eq('manager_id', managerId).single();
    return data || null;
  }

  async function ownedPortfolio(managerId, portfolioId) {
    const { data } = await sb.from('client_portfolios')
      .select('id, client_id, manager_clients!inner(manager_id)')
      .eq('id', portfolioId).eq('manager_clients.manager_id', managerId).single();
    return data || null;
  }

  async function ownedPosition(managerId, positionId) {
    const { data } = await sb.from('portfolio_positions')
      .select('id, portfolio_id, symbol, entry_price, shares, client_portfolios!inner(manager_clients!inner(manager_id))')
      .eq('id', positionId)
      .eq('client_portfolios.manager_clients.manager_id', managerId).single();
    return data || null;
  }

  async function history(row) {
    await sb.from('position_history').insert({
      source: row.source || 'manual',
      proposal_id: row.proposalId || null,
      position_id: row.position_id,
      portfolio_id: row.portfolio_id,
      symbol: row.symbol,
      event_type: row.event_type,
      price: row.price,
      shares: row.shares == null ? null : row.shares,
      total_value: row.shares != null && row.price != null ? row.shares * row.price : null,
      gain_pct: row.gain_pct == null ? null : row.gain_pct,
      note: row.note || null,
    });
  }

  const num = (v) => (v === '' || v == null ? null : Number(v));

  // ── clients ─────────────────────────────────────────────────────────────
  async function createClient(managerId, input = {}) {
    if (!input.full_name) return fail(400, 'full_name required');
    const { data, error } = await sb.from('manager_clients').insert({
      manager_id: managerId,                       // from the session, never the input
      full_name: input.full_name,
      email: input.email || null,
      phone: input.phone || null,
      risk_profile: input.risk_profile || 'moderate',
      investment_goal: input.investment_goal || null,
      notes: input.notes || null,
    }).select().single();
    if (error) return fail(500, error.message);
    return done(data);
  }

  async function updateClient(managerId, input = {}) {
    if (!input.clientId) return fail(400, 'clientId required');
    if (!(await ownedClient(managerId, input.clientId))) return fail(404, 'Client not found');

    const allowed = ['full_name', 'email', 'phone', 'risk_profile', 'investment_goal', 'notes', 'is_active'];
    const updates = {};
    for (const k of allowed) if (input[k] !== undefined) updates[k] = input[k];
    if (!Object.keys(updates).length) return fail(400, 'no fields to update');

    const { data, error } = await sb.from('manager_clients')
      .update(updates).eq('id', input.clientId).select().single();
    if (error) return fail(500, error.message);
    return done(data);
  }

  async function deleteClient(managerId, input = {}) {
    if (!input.clientId) return fail(400, 'clientId required');
    if (!(await ownedClient(managerId, input.clientId))) return fail(404, 'Client not found');

    const { error } = await sb.from('manager_clients').delete().eq('id', input.clientId);
    if (error) return fail(500, error.message);
    return done({ ok: true });
  }

  // ── portfolios ──────────────────────────────────────────────────────────
  async function createPortfolio(managerId, input = {}) {
    if (!input.clientId) return fail(400, 'clientId required');
    if (!input.name) return fail(400, 'name required');
    if (!(await ownedClient(managerId, input.clientId))) return fail(404, 'Client not found');

    const { data, error } = await sb.from('client_portfolios').insert({
      client_id: input.clientId,
      name: input.name,
      color: input.color || '#5b8cff',
      strategy: input.strategy || null,
    }).select().single();
    if (error) return fail(500, error.message);
    return done(data);
  }

  // ── positions ───────────────────────────────────────────────────────────
  async function addPosition(managerId, input = {}) {
    if (!input.portfolioId) return fail(400, 'portfolioId required');
    if (!input.symbol) return fail(400, 'symbol required');
    const entry = num(input.entry_price);
    if (!entry || !(entry > 0)) return fail(400, 'entry_price required');
    if (!(await ownedPortfolio(managerId, input.portfolioId))) return fail(404, 'Portfolio not found');

    const symbol = String(input.symbol).toUpperCase();
    const shares = num(input.shares);

    const { data: pos, error } = await sb.from('portfolio_positions').insert({
      portfolio_id: input.portfolioId,
      symbol,
      shares,
      avg_cost: num(input.avg_cost),
      entry_price: entry,
      target_sell_price: num(input.target_sell_price),
      stop_loss_price: num(input.stop_loss_price),
      note: input.note || null,
    }).select().single();
    if (error) return fail(500, error.message);

    await history({
      position_id: pos.id, portfolio_id: input.portfolioId, symbol,
      event_type: 'BUY', price: entry, shares, note: input.note,
      source: input.source, proposalId: input.proposalId,
    });
    return done(pos);
  }

  async function updatePosition(managerId, input = {}) {
    if (!input.positionId) return fail(400, 'positionId required');
    const pos = await ownedPosition(managerId, input.positionId);
    if (!pos) return fail(404, 'Position not found');

    const allowed = ['entry_price', 'shares', 'avg_cost', 'target_sell_price', 'stop_loss_price', 'note'];
    const updates = { updated_at: new Date().toISOString() };
    for (const k of allowed) if (input[k] !== undefined) updates[k] = input[k];

    const { data, error } = await sb.from('portfolio_positions')
      .update(updates).eq('id', input.positionId).select().single();
    if (error) return fail(500, error.message);

    const price = input.entry_price != null ? num(input.entry_price) : pos.entry_price;
    const shares = input.shares != null ? num(input.shares) : pos.shares;
    await history({
      position_id: pos.id, portfolio_id: pos.portfolio_id, symbol: pos.symbol,
      event_type: 'REBALANCE', price, shares, note: input.note || 'Position updated',
      source: input.source, proposalId: input.proposalId,
    });
    return done(data);
  }

  async function sellPosition(managerId, input = {}) {
    if (!input.positionId) return fail(400, 'positionId required');
    const pos = await ownedPosition(managerId, input.positionId);
    if (!pos) return fail(404, 'Position not found');

    const sell = num(input.sell_price) || pos.entry_price;
    if (!(sell > 0)) return fail(400, 'sell_price must be positive');
    const gain_pct = pos.entry_price ? ((sell - pos.entry_price) / pos.entry_price) * 100 : 0;

    await history({
      position_id: pos.id, portfolio_id: pos.portfolio_id, symbol: pos.symbol,
      event_type: 'SELL', price: sell, shares: pos.shares, gain_pct, note: input.note,
      source: input.source, proposalId: input.proposalId,
    });

    const { error } = await sb.from('portfolio_positions').delete().eq('id', input.positionId);
    if (error) return fail(500, error.message);
    return done({ ok: true, gain_pct, symbol: pos.symbol });
  }

  async function deletePosition(managerId, input = {}) {
    if (!input.positionId) return fail(400, 'positionId required');
    if (!(await ownedPosition(managerId, input.positionId))) return fail(404, 'Position not found');
    const { error } = await sb.from('portfolio_positions').delete().eq('id', input.positionId);
    if (error) return fail(500, error.message);
    return done({ ok: true });
  }

  return {
    createClient, updateClient, deleteClient,
    createPortfolio,
    addPosition, updatePosition, sellPosition, deletePosition,
  };
}

module.exports = { createManagerActions };
