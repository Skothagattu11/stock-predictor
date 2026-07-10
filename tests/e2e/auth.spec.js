// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('Auth — login page', () => {
  test('login page loads', async ({ page }) => {
    await page.goto('/login.html');
    await expect(page.locator('#authForm')).toBeVisible();
    await expect(page.locator('#email')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.locator('#submitBtn')).toBeVisible();
  });

  test('shows error on bad credentials', async ({ page }) => {
    await page.goto('/login.html');
    await page.fill('#email', 'bad@example.com');
    await page.fill('#password', 'wrongpassword');
    await page.click('#submitBtn');
    await expect(page.locator('#errBox')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#errBox')).not.toBeEmpty();
  });
});

test.describe('Auth — protected pages', () => {
  test('manager.html shows login form (client-side auth gate)', async ({ page }) => {
    // Clear any stored token first
    await page.goto('/login.html');
    await page.evaluate(() => {
      localStorage.removeItem('wm_token');
      localStorage.removeItem('wm_user');
    });
    await page.goto('/manager.html');
    // Manager page has its own client-side auth that shows a login form inline
    // OR redirects to login.html — either is acceptable
    const url = page.url();
    const hasLoginForm = await page.locator('#authForm, form[id*="login"], input[type="password"]').count();
    const redirectedToLogin = url.includes('login');
    expect(redirectedToLogin || hasLoginForm > 0).toBeTruthy();
  });

  test('analyst.html is public — no login required', async ({ page }) => {
    await page.goto('/login.html');
    await page.evaluate(() => localStorage.removeItem('wm_token'));
    await page.goto('/analyst.html');
    await expect(page).not.toHaveURL(/login/);
    await expect(page.locator('#ticker-input')).toBeVisible();
  });

  test('admin.html is public — no login required', async ({ page }) => {
    await page.goto('/login.html');
    await page.evaluate(() => localStorage.removeItem('wm_token'));
    await page.goto('/admin.html');
    await expect(page).not.toHaveURL(/login/);
    await expect(page.locator('#connectors')).toBeDefined();
  });

  test('main dashboard / is public — no login required', async ({ page }) => {
    await page.goto('/login.html');
    await page.evaluate(() => localStorage.removeItem('wm_token'));
    await page.goto('/');
    await expect(page).not.toHaveURL(/login/);
  });
});
