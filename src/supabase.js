'use strict';

const { createClient } = require('@supabase/supabase-js');

let _client = null;

function getSupabase() {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return null;
  if (!_client) {
    _client = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: {
        // Explicitly send the service role key as Bearer so PostgREST
        // assigns the service_role Postgres role (which has BYPASSRLS).
        headers: { Authorization: `Bearer ${key}` },
      },
    });
  }
  return _client;
}

module.exports = { getSupabase };
