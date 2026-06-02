// Frontend smoke tests — drive the real app (Flask + SPA) in a browser and
// assert each reader actually mounts and renders. Closes the "no frontend
// coverage" gap from the audit. Fixtures: tests/e2e/fixtures (make_fixtures.py).
const path = require('path');
const { test, expect } = require('@playwright/test');

const FIX = path.join(__dirname, 'fixtures');
const fix = (name) => path.join(FIX, name);

// Open a local file the way the app does internally (YR.openFile), so we don't
// need the native file dialog. The path is absolute on the test machine and the
// backend (same host) reads it.
async function openFile(page, name) {
  await page.goto('/');
  await page.waitForFunction(() => !!(window.YR && window.YR.openFile));
  await page.evaluate((p) => window.YR.openFile(p), fix(name));
}

test('shell loads without console errors', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  await expect(page.locator('#rail')).toBeVisible();
  await page.waitForFunction(() => !!window.YR);
  expect(errors, errors.join('\n')).toHaveLength(0);
});

test('opens a PDF and renders pages', async ({ page }) => {
  await openFile(page, 'sample.pdf');
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'pdf');
  await expect(page.locator('#doc-title')).toHaveText(/sample\.pdf/);
  await expect(page.locator('.page-wrap').first()).toBeVisible();
});

test('opens a DOCX in the office flow reader', async ({ page }) => {
  await openFile(page, 'sample.docx');
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'office');
  await expect(page.locator('.doc-page.docx')).toContainText('Smoke Heading');
});

test('opens an XLSX as a sticky grid', async ({ page }) => {
  await openFile(page, 'sample.xlsx');
  await expect(page.locator('.sheet-grid')).toContainText('Region');
});

test('opens a PPTX in the slide viewer', async ({ page }) => {
  await openFile(page, 'sample.pptx');
  await expect(page.locator('.slide-canvas')).toContainText('Smoke Slide');
});

test('opens plain text', async ({ page }) => {
  await openFile(page, 'sample.txt');
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'text');
  await expect(page.locator('#reader-root')).toContainText('Plain text smoke fixture');
});

test('mutating API rejects requests without the session token', async ({ request }) => {
  // The page's fetch attaches the token; a raw request (like another local
  // process) doesn't — so it must be forbidden.
  const r = await request.post('/api/prefs', { data: { kind: 'pdf', prefs: {} } });
  expect(r.status()).toBe(403);
});
