// End-to-end test for the image editor (paint/draw mode). Drives the real app:
// opens an image, enters Edit mode, draws a brush stroke on the live <canvas>,
// undoes it, then saves over the file and verifies the bytes changed on disk and
// a .bak of the pristine original was kept.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { test, expect } = require('@playwright/test');

// A roomy viewport so the (single) Edit toolbar button never folds into the
// auto-overflow "More ▾" menu.
test.use({ viewport: { width: 1600, height: 900 } });

const FIX = path.join(__dirname, 'fixtures');

// Work on a throwaway copy in its OWN temp folder, so we never mutate the
// committed fixture and the viewer sees no sibling images (keeps the toolbar
// narrow — no gallery group).
function tempCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yr-edit-'));
  const dst = path.join(dir, 'sample.png');
  fs.copyFileSync(path.join(FIX, 'sample.png'), dst);
  return dst;
}

async function openImage(page, p) {
  await page.goto('/');
  await page.waitForFunction(() => !!(window.YR && window.YR.openFile));
  await page.evaluate((x) => window.YR.openFile(x), p);
  await expect(page.locator('#app')).toHaveAttribute('data-mode', 'image');
  await expect(page.locator('.image-canvas')).toBeVisible();
}

test('edit mode: draw, undo, and save round-trip', async ({ page }) => {
  const file = tempCopy();
  const bak = file + '.bak';
  try {
    await openImage(page, file);

    // Enter Edit mode via the single toolbar button.
    await page.getByRole('button', { name: /Edit/ }).first().click();
    await expect(page.locator('.edit-canvas')).toBeVisible();
    await expect(page.locator('.image-edit-bar')).toBeVisible();

    // Make the brush large so the stroke is unambiguous, keep the default red.
    await page.locator('.eb-size').fill('40');
    await page.locator('.eb-size').dispatchEvent('input');

    // Draw a horizontal stroke across the middle of the canvas.
    const box = await page.locator('.edit-canvas').boundingBox();
    const cy = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * 0.3, cy);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, cy, { steps: 8 });
    await page.mouse.move(box.x + box.width * 0.7, cy, { steps: 8 });
    await page.mouse.up();

    // The centre bitmap pixel should now be reddish (the brush colour).
    const drawn = await page.evaluate(() => {
      const c = document.querySelector('.edit-canvas');
      const d = c.getContext('2d').getImageData(c.width >> 1, c.height >> 1, 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    });
    expect(drawn[0]).toBeGreaterThan(150);     // strong red
    expect(drawn[1]).toBeLessThan(140);
    expect(drawn[2]).toBeLessThan(140);

    // Undo restores the original near-white pixel.
    await page.locator('.eb-undo').click();
    const reverted = await page.evaluate(() => {
      const c = document.querySelector('.edit-canvas');
      const d = c.getContext('2d').getImageData(c.width >> 1, c.height >> 1, 1, 1).data;
      return [d[0], d[1], d[2]];
    });
    expect(reverted[0]).toBeGreaterThan(220);
    expect(reverted[1]).toBeGreaterThan(220);
    expect(reverted[2]).toBeGreaterThan(220);

    // Redraw, then Save (overwrite). The page's fetch carries the session token.
    await page.mouse.move(box.x + box.width * 0.3, cy);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.7, cy, { steps: 12 });
    await page.mouse.up();

    const resp = page.waitForResponse('**/api/image/save');
    await page.locator('.eb-save').click();
    const r = await resp;
    expect(r.ok()).toBeTruthy();

    // Disk: a .bak of the pristine original exists, byte-identical to the source;
    // the saved file itself now differs (the stroke was baked in).
    expect(fs.existsSync(bak)).toBeTruthy();
    const orig = fs.readFileSync(path.join(FIX, 'sample.png'));
    expect(Buffer.compare(fs.readFileSync(bak), orig)).toBe(0);
    expect(Buffer.compare(fs.readFileSync(file), orig)).not.toBe(0);
  } finally {
    for (const f of [file, bak]) { try { fs.unlinkSync(f); } catch (_) {} }
  }
});

test('edit mode: Escape exits back to the viewer', async ({ page }) => {
  const file = tempCopy();
  try {
    await openImage(page, file);
    await page.getByRole('button', { name: /Edit/ }).first().click();
    await expect(page.locator('.edit-canvas')).toBeVisible();
    // No unsaved changes → Escape exits without a confirm dialog.
    await page.keyboard.press('Escape');
    await expect(page.locator('.edit-canvas')).toHaveCount(0);
    await expect(page.locator('.image-canvas')).toBeVisible();
  } finally {
    try { fs.unlinkSync(file); } catch (_) {}
  }
});
