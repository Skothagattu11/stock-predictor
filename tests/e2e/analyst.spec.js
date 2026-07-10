// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('Analyst page — structure', () => {
  test('loads without auth redirect', async ({ page }) => {
    await page.goto('/analyst.html');
    await expect(page).not.toHaveURL(/login/);
    await expect(page).toHaveTitle('AI Equity Analyst');
  });

  test('shows input controls', async ({ page }) => {
    await page.goto('/analyst.html');
    await expect(page.locator('#ticker-input')).toBeVisible();
    await expect(page.locator('#depth-select')).toBeVisible();
    await expect(page.locator('#run-btn')).toBeVisible();
    await expect(page.locator('#run-btn')).toContainText('Analyse');
  });

  test('back link returns to dashboard', async ({ page }) => {
    await page.goto('/analyst.html');
    await expect(page.locator('a.back[href="/"]')).toBeVisible();
  });

  test('shows error when no ticker entered', async ({ page }) => {
    await page.goto('/analyst.html');
    await page.click('#run-btn');
    await expect(page.locator('#state')).toBeVisible();
    await expect(page.locator('#state')).toContainText('Enter a ticker first');
  });
});

test.describe('Analyst page — single ticker report', () => {
  test('generates a BUY/HOLD/SELL report for AAPL', async ({ page }) => {
    await page.goto('/analyst.html');
    await page.fill('#ticker-input', 'AAPL');
    await page.click('#run-btn');

    // Loading state appears
    await expect(page.locator('#state')).toContainText('Analysing');
    await expect(page.locator('#run-btn')).toBeDisabled();

    // Wait for report (LLM can take up to 30s)
    await expect(page.locator('#report .verdict-banner')).toBeVisible({ timeout: 45_000 });

    // Verdict badge is one of the three valid values
    const badge = page.locator('#report .badge').first();
    await expect(badge).toBeVisible();
    const text = await badge.innerText();
    expect(['BUY', 'HOLD', 'SELL']).toContain(text.trim());

    // Confidence meter rendered
    await expect(page.locator('#report .conf')).toContainText('%');

    // All 6 sections present
    const cards = page.locator('#report .card');
    await expect(cards).toHaveCount(6);

    // State (loading) hidden after report
    await expect(page.locator('#state')).toBeHidden();

    // Run button re-enabled
    await expect(page.locator('#run-btn')).toBeEnabled();
  });

  test('prefills ticker from ?ticker= query param and auto-runs', async ({ page }) => {
    await page.goto('/analyst.html?ticker=MSFT');
    // Auto-run fires — loading state should appear immediately
    await expect(page.locator('#state')).toContainText('Analysing', { timeout: 5_000 });
    // Wait for report
    await expect(page.locator('#report .verdict-banner')).toBeVisible({ timeout: 45_000 });
    // Ticker input should be prefilled
    await expect(page.locator('#ticker-input')).toHaveValue('MSFT');
  });

  test('deep mode selector works', async ({ page }) => {
    await page.goto('/analyst.html');
    await page.selectOption('#depth-select', 'deep');
    await expect(page.locator('#depth-select')).toHaveValue('deep');
    await page.fill('#ticker-input', 'NVDA');
    await page.click('#run-btn');
    await expect(page.locator('#report .verdict-banner')).toBeVisible({ timeout: 45_000 });
  });

  test('Enter key triggers analysis', async ({ page }) => {
    await page.goto('/analyst.html');
    await page.fill('#ticker-input', 'GOOGL');
    await page.press('#ticker-input', 'Enter');
    await expect(page.locator('#state')).toContainText('Analysing', { timeout: 5_000 });
    await expect(page.locator('#report .verdict-banner')).toBeVisible({ timeout: 45_000 });
  });
});

test.describe('Analyst page — comparison mode', () => {
  test('two comma-separated tickers run comparison mode', async ({ page }) => {
    await page.goto('/analyst.html');
    await page.fill('#ticker-input', 'AAPL, MSFT');
    await page.click('#run-btn');

    await expect(page.locator('#state')).toContainText('Analysing');

    // Comparison table should appear
    await expect(page.locator('#comparison table.cmp')).toBeVisible({ timeout: 60_000 });

    // Ranking banner shows a winner
    await expect(page.locator('#report .verdict-banner')).toBeVisible();

    // Table has a Verdict row for each ticker
    const headers = page.locator('#comparison table.cmp thead th');
    await expect(headers).toHaveCount(3); // Metric + AAPL + MSFT
  });
});
