// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('Admin / observability page', () => {
  test('loads without auth redirect', async ({ page }) => {
    await page.goto('/admin.html');
    await expect(page).not.toHaveURL(/login/);
    await expect(page).toHaveTitle('Analyst — Observability');
  });

  test('shows connector health cards', async ({ page }) => {
    await page.goto('/admin.html');
    // Cards load from /api/analyst/health on DOMContentLoaded
    await expect(page.locator('#connectors')).not.toBeEmpty({ timeout: 10_000 });
    const cards = page.locator('#connectors .card');
    // Expect 4 cards: Overall, FMP, Yahoo, LLM
    await expect(cards).toHaveCount(4);
  });

  test('overall status is ok or degraded (not down)', async ({ page }) => {
    await page.goto('/admin.html');
    await expect(page.locator('#connectors')).not.toBeEmpty({ timeout: 10_000 });
    const overallCard = page.locator('#connectors .card').first();
    const text = await overallCard.innerText();
    expect(text).toMatch(/ok|degraded/i);
    expect(text).not.toMatch(/down/i);
  });

  test('FMP connector shows ok (key configured)', async ({ page }) => {
    await page.goto('/admin.html');
    await expect(page.locator('#connectors')).not.toBeEmpty({ timeout: 10_000 });
    const cards = page.locator('#connectors .card');
    const fmpCard = cards.nth(1);
    await expect(fmpCard).toContainText('ok');
  });

  test('summary stats panel renders', async ({ page }) => {
    await page.goto('/admin.html');
    await expect(page.locator('#summary')).not.toBeEmpty({ timeout: 10_000 });
  });

  test('requests table is present', async ({ page }) => {
    await page.goto('/admin.html');
    await expect(page.locator('#requests')).toBeVisible();
    // thead exists with expected columns
    await expect(page.locator('#requests thead')).toContainText('ticker');
    await expect(page.locator('#requests thead')).toContainText('verdict');
  });

  test('back link goes to analyst page', async ({ page }) => {
    await page.goto('/admin.html');
    const back = page.locator('a.back[href="/analyst.html"]');
    await expect(back).toBeVisible();
  });
});
