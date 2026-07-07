// End-to-end smoke: boot → import → edit → persist → multi-project. One
// journey per test so IndexedDB/OPFS state stays inside one browser context.
import { test, expect, type Page } from '@playwright/test';

// An 8x8 red PNG (ffmpeg-generated; decodes everywhere).
const RED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEklEQVR4nGP8w4AdsOAQH6QSANBkARqrv8JBAAAAAElFTkSuQmCC',
  'base64',
);

/** The programmatic surface (window.velocut) doubles as the test probe. */
const doc = (page: Page) => page.evaluate(() => (window as any).velocut?.doc());

test('boots with an engine, imports media, edits, and survives a reload', async ({ page }) => {
  await page.goto('/');

  // Boot: an engine is active (Rust/WASM locally, TS fallback elsewhere).
  await expect(page.locator('.engine-badge, [class*=engine]').first()).toContainText(/engine:/i);
  await expect(page.getByRole('button', { name: 'Import Media' })).toBeVisible();

  // Import an image through the real file input.
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import Media' }).click();
  await (await chooser).setFiles({ name: 'red.png', mimeType: 'image/png', buffer: RED_PNG });
  await expect(page.locator('.asset-item')).toHaveCount(1);

  // Click-to-add creates the track and lays the clip down (3s image default).
  await page.locator('.asset-item').click();
  await expect.poll(async () => (await doc(page))?.tracks[0]?.clips.length).toBe(1);

  // Split at the playhead (1.5s) through the toolbar.
  await page.evaluate(() => (window as any).velocut.seek(1_500_000));
  await page.getByRole('button', { name: /Split/ }).click();
  await expect.poll(async () => (await doc(page))?.tracks[0].clips.length).toBe(2);

  // Undo restores the single clip.
  await page.getByRole('button', { name: /Undo/ }).click();
  await expect.poll(async () => (await doc(page))?.tracks[0].clips.length).toBe(1);

  // Local-first: the document AND the media come back after a reload. Persist
  // is debounced (300ms); the pagehide flush is best-effort only (an async IDB
  // write during teardown isn't guaranteed), so let the debounce land first.
  await page.waitForTimeout(600);
  await page.reload();
  await expect.poll(async () => (await doc(page))?.tracks[0]?.clips.length).toBe(1);
  await expect(page.locator('.asset-item')).toHaveCount(1);
  // The OPFS-backed image re-attaches (no unloaded-asset warning).
  await expect(page.locator('.asset-warn')).toHaveCount(0);
});

test('projects are isolated: create, switch, delete via the switcher UI', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.project-current')).toBeVisible();

  // Leave a fingerprint in the default project.
  await page.evaluate(() => (window as any).velocut.apply({ type: 'addTrack', kind: 'video', name: 'Fingerprint' }));

  // Create a second project (prompt dialog) — the app reloads into it blank.
  page.once('dialog', (d) => void d.accept('E2E Project'));
  await page.locator('.project-current').click();
  await page.getByRole('button', { name: '+ New Project' }).click();
  await expect(page.locator('.project-current')).toContainText('E2E Project');
  await expect.poll(async () => (await doc(page))?.tracks.length).toBe(0);

  // Its edits stay its own.
  await page.evaluate(() => (window as any).velocut.apply({ type: 'addTrack', kind: 'text', name: 'B-only' }));

  // Switch back: fingerprint intact, no leakage.
  await page.locator('.project-current').click();
  await page.getByRole('button', { name: /My Project/ }).click();
  await expect(page.locator('.project-current')).toContainText('My Project');
  await expect
    .poll(async () => (await doc(page))?.tracks.map((t: { name: string }) => t.name))
    .toEqual(['Fingerprint']);

  // Delete the second project (confirm dialog); it disappears from the list.
  await page.locator('.project-current').click();
  page.once('dialog', (d) => void d.accept());
  await page
    .locator('.project-row', { hasText: 'E2E Project' })
    .locator('.project-delete')
    .click();
  await expect(page.locator('.project-row')).toHaveCount(1);
});
