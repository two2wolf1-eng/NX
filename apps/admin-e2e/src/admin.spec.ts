import { expect, test } from '@playwright/test';

test('admin homepage loads', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/admin/i);
});
