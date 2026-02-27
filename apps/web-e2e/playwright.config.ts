import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './src',
  outputDir: 'test-output/playwright/output',
  reporter: [['html', { outputFolder: 'test-output/playwright/report' }]],
  use: {
    baseURL: 'http://127.0.0.1:4300',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'node ../../node_modules/nx/bin/nx.js run web:dev --port=4300',
    url: 'http://127.0.0.1:4300',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
