import { test, expect } from '@playwright/test';

test('homepage has title', async ({ page }) => {
  await page.goto('/');

  // Expect the page to have a title
  await expect(page).toHaveTitle(/presenton/i);
});

test('homepage loads successfully', async ({ page }) => {
  const response = await page.goto('/');

  // Check that the page loaded successfully
  expect(response?.status()).toBe(200);
});
