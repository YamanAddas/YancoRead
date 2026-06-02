// Verifies the PDF reader zooms by resizing the existing DOM in place rather
// than tearing down and rebuilding every page-wrap. We tag the first page node,
// zoom in, and assert the SAME node is still there (the old code did
// scroll.innerHTML = '' on every zoom), that it grew, and that the loaded page
// bitmap was re-fetched at a higher render zoom.
const path = require('path');
const { test, expect } = require('@playwright/test');

const FIX = path.join(__dirname, 'fixtures');

// Roomy viewport so the zoom buttons never fold into the "More ▾" overflow menu.
test.use({ viewport: { width: 1600, height: 900 } });

async function openPdf(page) {
  await page.goto('/');
  await page.waitForFunction(() => !!(window.YR && window.YR.openFile));
  await page.evaluate((p) => window.YR.openFile(p), path.join(FIX, 'sample.pdf'));
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'pdf');
  await expect(page.locator('.page-wrap').first()).toBeVisible();
  // Wait for the first page image to lazy-load and decode.
  await page.waitForFunction(() => {
    const img = document.querySelector('.page-wrap img.page-canvas');
    return img && img.src && img.complete && img.naturalWidth > 0;
  });
}

const zoomOf = (u) => parseFloat(new URL(u).searchParams.get('zoom'));

test('zoom resizes pages in place (no DOM rebuild) and re-fetches sharper', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await openPdf(page);

  const before = await page.evaluate(() => {
    const w = document.querySelector('.page-wrap');
    w.dataset.zoomMarker = 'orig';                 // survives ONLY if the node isn't rebuilt
    const img = w.querySelector('img.page-canvas');
    return { width: w.getBoundingClientRect().width, src: img.src };
  });

  const zoomIn = page.getByRole('button', { name: /Zoom in/ }).first();
  await zoomIn.click();
  await zoomIn.click();

  // The re-fetched bitmap finishes loading.
  await page.waitForFunction((prevSrc) => {
    const img = document.querySelector('.page-wrap img.page-canvas');
    return img && img.src !== prevSrc && img.complete && img.naturalWidth > 0;
  }, before.src);

  const after = await page.evaluate(() => {
    const w = document.querySelector('.page-wrap');
    const img = w.querySelector('img.page-canvas');
    return { marker: w.dataset.zoomMarker, width: w.getBoundingClientRect().width, src: img.src };
  });

  expect(after.marker).toBe('orig');                       // same node → resized in place
  expect(after.width).toBeGreaterThan(before.width + 5);   // it actually grew
  expect(zoomOf(after.src)).toBeGreaterThan(zoomOf(before.src));  // sharper render requested
  expect(errors, errors.join('\n')).toHaveLength(0);
});

test('window resize relayouts in place, debounced (no rebuild)', async ({ page }) => {
  // The resize handler used to call rerender() (full DOM rebuild) on every
  // resize event; now it debounces and resizes in place via applyZoom().
  await openPdf(page);
  await page.evaluate(() => { document.querySelector('.page-wrap').dataset.zoomMarker = 'orig'; });

  await page.setViewportSize({ width: 1100, height: 800 });
  await page.waitForTimeout(400);   // let the 150ms resize debounce settle

  const marker = await page.evaluate(() => document.querySelector('.page-wrap').dataset.zoomMarker);
  expect(marker).toBe('orig');      // same node preserved → relayout was in place
  await expect(page.locator('.page-wrap').first()).toBeVisible();
  await page.waitForFunction(() => {
    const img = document.querySelector('.page-wrap img.page-canvas');
    return img && img.complete && img.naturalWidth > 0;
  });
});
