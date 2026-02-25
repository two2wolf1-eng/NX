import { expect, test } from '@playwright/test';

test('web homepage loads', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/web/i);
});
