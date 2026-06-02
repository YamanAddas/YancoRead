// Playwright config for the YancoRead frontend smoke tests.
// Launches the real Flask backend (which serves the single-page app) and drives
// it in a headless browser — the same wiring the desktop pywebview window uses,
// minus the native shell. Run `python tests/e2e/make_fixtures.py` first.
const { defineConfig } = require('@playwright/test');

const PY = process.env.YR_PYTHON || 'python';

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  expect: { timeout: 10000 },
  fullyParallel: false,        // one shared backend + file cache
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'list' : 'line',
  use: {
    baseURL: 'http://127.0.0.1:8746',
    headless: true,
  },
  webServer: {
    command: `${PY} app.py`,
    url: 'http://127.0.0.1:8746/health',
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
});
