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
        // "a.b.c" filters (Supabase embedded-resource filters) are treated as
        // satisfied — ownership in the real client is enforced by the join.
        if (col.includes('.')) return true;
        return row[col] === val;
      });
    }

    function resolve() {
      const rows = (tables[state.table] || []).filter(matches);
      if (state.op === 'insert') {
        const created = { id: `new-${state.table}-${calls.length}`, ...state.payload };
        calls.push({ op: 'insert', table: state.table, row: state.payload });
        // Persist it, so a later query in the same test finds it — the executor
        // threads created ids into dependent rows and re-checks ownership.
        if (!tables[state.table]) tables[state.table] = [];
        tables[state.table].push(created);
        return { data: created, rows: [created] };
      }
      if (state.op === 'update') {
        calls.push({ op: 'update', table: state.table, row: state.payload, filters: { ...state.filters } });
        const updated = { ...(rows[0] || {}), ...state.payload };
        return { data: updated, rows: [updated] };
      }
      if (state.op === 'delete') {
        calls.push({ op: 'delete', table: state.table, filters: { ...state.filters } });
        return { data: null, rows: [] };
      }
      return { data: rows[0] || null, rows };
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
        const { data } = resolve();
        if (!data) return { data: null, error: { message: 'not found' } };
        return { data, error: null };
      },
      then(onOk, onErr) {
        const { rows } = resolve();
        return Promise.resolve({ data: rows, error: null }).then(onOk, onErr);
      },
    };
    return api;
  }

  return { from, calls };
}

module.exports = { fakeSupabase };
