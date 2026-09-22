'use strict';

// Minimal chainable stand-in for the Supabase JS client, covering exactly the
// surface manager-actions.js uses: from().select().eq().order().single(),
// .insert().select().single(), .update().eq().select().single(), .delete().eq().
//
// `tables` maps table name -> array of row objects. Writes are recorded in
// `calls` so tests can assert what would have been sent.
function fakeSupabase(tables = {}) {
  const calls = [];

  function from(table) {
    const state = { table, filters: {}, op: 'select', payload: null };

    function matches(row) {
      return Object.entries(state.filters).every(([col, val]) => {
        // "a.b.c" filters (Supabase embedded-resource filters) model a real join.
        // A seeded row can declare the joined value directly under the dotted key
        // (e.g. a client_portfolios row carrying 'manager_clients.manager_id') —
        // when it does, match against that like any other column. When it
        // doesn't, fall back to permissive (satisfied), since this stub doesn't
        // implement a general-purpose join engine.
        if (col.includes('.')) {
          if (Object.prototype.hasOwnProperty.call(row, col)) return row[col] === val;
          return true;
        }
        return row[col] === val;
      });
    }

    // A table can be seeded as a plain array of rows (the normal case) or, to
    // simulate a DB-level failure (e.g. a failed position_history insert), as
    // `{ error: { message: '...' } }` — every operation against that table
    // then returns that error instead of succeeding.
    const seeded = tables[state.table];
    const forcedError = seeded && !Array.isArray(seeded) ? seeded.error : null;

    function resolve() {
      if (forcedError) {
        calls.push({ op: state.op, table: state.table, row: state.payload, filters: { ...state.filters } });
        return { data: null, error: forcedError, rows: [] };
      }
      const rows = (Array.isArray(seeded) ? seeded : []).filter(matches);
      if (state.op === 'insert') {
        const created = { id: `new-${state.table}-${calls.length}`, ...state.payload };
        calls.push({ op: 'insert', table: state.table, row: state.payload });
        // Persist it, so a later query in the same test finds it — the executor
        // threads created ids into dependent rows and re-checks ownership.
        if (!Array.isArray(tables[state.table])) tables[state.table] = [];
        tables[state.table].push(created);
        return { data: created, error: null, rows: [created] };
      }
      if (state.op === 'update') {
        calls.push({ op: 'update', table: state.table, row: state.payload, filters: { ...state.filters } });
        if (!rows.length) return { data: null, error: null, rows: [] };
        const updated = { ...rows[0], ...state.payload };
        return { data: updated, error: null, rows: [updated] };
      }
      if (state.op === 'delete') {
        calls.push({ op: 'delete', table: state.table, filters: { ...state.filters } });
        return { data: null, error: null, rows: [] };
      }
      return { data: rows[0] || null, error: null, rows };
    }

    const api = {
      select() { return api; },
      order() { return api; },
      limit() { return api; },
      eq(col, val) { state.filters[col] = val; return api; },
      insert(payload) { state.op = 'insert'; state.payload = payload; return api; },
      update(payload) { state.op = 'update'; state.payload = payload; return api; },
      delete() { state.op = 'delete'; return api; },
      async single() {
        const { data, error } = resolve();
        if (error) return { data: null, error };
        // A zero-match update() resolves to null data with no error — that is
        // what manager-actions.js's `if (!data) return fail(404, ...)` branches
        // are written to expect (see updateClient). A zero-match select still
        // reports "not found" as an error, matching PostgREST's real behaviour
        // for a plain select().single() with no rows.
        if (!data && state.op !== 'update') return { data: null, error: { message: 'not found' } };
        return { data, error: null };
      },
      then(onOk, onErr) {
        const { rows, error } = resolve();
        return Promise.resolve({ data: rows, error: error || null }).then(onOk, onErr);
      },
    };
    return api;
  }

  // `tables` is exposed so a test can swap one table for a forced-error shape
  // after construction (see sb_position_history_fails in manager-actions.test.js).
  // It is read per call inside from(), so a later mutation takes effect.
  return { from, calls, tables };
}

module.exports = { fakeSupabase };
