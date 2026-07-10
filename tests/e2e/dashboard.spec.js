// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('Main signals dashboard', () => {
  test('loads without redirect to login', async ({ page }) => {
    await page.goto('/');
    await expect(page).not.toHaveURL(/login/);
    await expect(page).toHaveTitle(/candle|signal|stock/i);
  });

  test('shows the Analyst pill link in nav', async ({ page }) => {
    await page.goto('/');
    const analystLink = page.locator('a[href="/analyst.html"]');
    await expect(analystLink).toBeVisible();
    await expect(analystLink).toContainText('Analyst');
  });

  test('Analyst pill navigates to analyst page', async ({ page }) => {
    await page.goto('/');
    await page.click('a[href="/analyst.html"]');
    await expect(page).toHaveURL(/analyst\.html/);
  });

  test('Manager Portal link is visible', async ({ page }) => {
    await page.goto('/');
    // Two links to manager.html exist: auth bar + nav pill. First is sufficient.
    const managerLink = page.locator('a[href="/manager.html"]').first();
    await expect(managerLink).toBeVisible();
  });
});
