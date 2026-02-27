import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './src',
  outputDir: 'test-output/playwright/output',
  reporter: [['html', { outputFolder: 'test-output/playwright/report' }]],
  use: {
    baseURL: 'http://127.0.0.1:4301',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'node ./node_modules/nx/bin/nx.js run admin:dev --port=4301',
    url: 'http://127.0.0.1:4301',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
