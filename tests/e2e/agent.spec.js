'use strict';
const { test, expect } = require('@playwright/test');

// Signs in for the Wealth Manager portal.
//
// manager.js's client-side auth guard only checks that `wm_token` is
// truthy — it never validates it before rendering — and every write is
// gated server-side per request via the Authorization header. There is no
// existing signIn() helper anywhere in tests/e2e: auth.spec.js only
// exercises the login *gate* (it clears wm_token and checks the page
// redirects), it never performs a real sign-in. This environment also has
// no live Supabase project to sign in against. So this seeds localStorage
// the same way auth.spec.js clears it, and every request the page makes is
// stubbed below — nothing here depends on a real backend.
async function signIn(page) {
  await page.goto('/login.html');
  await page.evaluate(() => {
    localStorage.setItem('wm_token', 'e2e-test-token');
    localStorage.setItem('wm_user', JSON.stringify({ id: 'u1', email: 'manager@example.com' }));
  });
}

// manager.js calls loadClients() as soon as it loads, so /clients must be
// stubbed before navigating to /manager.html — otherwise that call reaches
// the real server, which has no Supabase project configured here and
// returns 401, which (via the api() helper) calls logout() and bounces the
// page straight back to /login.html before the composer ever renders. An
// empty client list is enough for the composer, which doesn't require a
// selected client/portfolio to send a message.
async function stubClients(page) {
  await page.route('**/api/manager/clients', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify([]),
  }));
}

// Stubs the agent endpoints so the spec exercises the UI contract — compose,
// review, edit, approve, apply — without spending a model call or touching
// live client data.
async function stubAgent(page) {
  await page.route('**/api/manager/agent/parse', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      proposalId: 'prop-test',
      plan: { summary: 'Two changes', clarification: null, transcript: null },
      errors: [],
      actions: [
        { op: 'addPosition', ref: 'a1', dependsOn: null, target: { portfolioId: 'p1' },
          fields: { symbol: 'AAPL', entry_price: 182.5, shares: 10 },
          confidence: 0.95, source: '"10 AAPL at 182.50"', reasoning: '', valid: true, problems: [] },
        { op: 'addPosition', ref: 'a2', dependsOn: null, target: { portfolioId: 'p1' },
          fields: { symbol: 'MSFT', entry_price: 410 },
          confidence: 0.9, source: '"MSFT at 410"', reasoning: '', valid: true, problems: [] },
      ],
    }),
  }));

  await page.route('**/api/manager/agent/execute', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    expect(body.rows.length).toBe(1);                           // one row was unchecked
    expect(Number(body.rows[0].fields.entry_price)).toBe(200);  // the edit was sent
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ results: [{ ref: 'a1', op: 'addPosition', ok: true, data: { id: 'new' } }] }),
    });
  });
}

test('compose, edit a field, drop a row, apply', async ({ page }) => {
  await signIn(page);
  await stubClients(page);
  await stubAgent(page);
  await page.goto('/manager.html');

  await page.fill('#agentText', 'bought 10 AAPL at 182.50 and MSFT at 410');
  await page.click('#agentSendBtn');

  await expect(page.locator('#agentDrawer')).toBeVisible();
  await expect(page.locator('.agent-row')).toHaveCount(2);

  await page.fill('.agent-row >> nth=0 >> input[data-field="entry_price"]', '200');
  await page.uncheck('input[data-check="1"]');
  await expect(page.locator('#agentCount')).toHaveText('1 selected');

  // A real mouse click, deliberately: this spec caught the composer bar
  // covering #agentRunBtn (the drawer was offset by a hardcoded 64px that
  // assumed the composer's height). Both now stack in one flex dock, so a
  // genuine click lands on the button — which is the whole point of the
  // feature. Keep click() here; dispatchEvent would hide a regression.
  await page.locator('#agentRunBtn').click();
  await expect(page.locator('#agentStatus')).toContainText('1 applied');
});

test('a flagged row is unchecked and shows why', async ({ page }) => {
  await signIn(page);
  await stubClients(page);
  await page.route('**/api/manager/agent/parse', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      proposalId: 'p', plan: { summary: 'One problem', clarification: null, transcript: null }, errors: [],
      actions: [{ op: 'addPosition', ref: 'a1', dependsOn: null, target: { portfolioId: 'p1' },
        fields: { symbol: 'ZZZZQQ', entry_price: 10 }, confidence: 0.3, source: '', reasoning: '',
        valid: false, problems: ['Could not resolve ticker "ZZZZQQ".'] }],
    }),
  }));
  await page.goto('/manager.html');

  await page.fill('#agentText', 'buy ZZZZQQ');
  await page.click('#agentSendBtn');

  await expect(page.locator('.agent-row.bad')).toHaveCount(1);
  await expect(page.locator('.agent-problem')).toContainText('ZZZZQQ');
  await expect(page.locator('input[data-check="0"]')).not.toBeChecked();
  await expect(page.locator('#agentRunBtn')).toBeDisabled();
});

// The attach bar and the drawer are shown/hidden via the `hidden` attribute.
// An author `display` rule beats the UA's [hidden]{display:none}, so
// .agent-attach{display:flex} once left a permanently visible bar holding an
// <img> with no src — a broken-image icon parked in the composer. Assert the
// hidden attribute actually hides, for every element that relies on it.
test('elements hidden by the hidden attribute are really hidden', async ({ page }) => {
  await signIn(page);
  await stubClients(page);
  await page.goto('/manager.html');

  for (const sel of ['#agentAttach', '#agentDrawer', '#agentClarify']) {
    const el = page.locator(sel);
    await expect(el, `${sel} carries the hidden attribute`).toHaveAttribute('hidden', '');
    await expect(el, `${sel} must not be visible while hidden`).toBeHidden();
  }
  // The preview img must never render without a source.
  await expect(page.locator('#agentThumb')).toBeHidden();
});
