import { test, expect, type Page } from '@playwright/test';

async function boot(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.goto('/');
  await page.waitForFunction(() => (window as any).velocut?.sceneEdit);
}
async function fits(page: Page, selector: string) {
  const rect = await page.locator(selector).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      x: r.x,
      y: r.y,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
    };
  });
  const view = page.viewportSize()!;
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.y).toBeGreaterThanOrEqual(0);
  expect(rect.right).toBeLessThanOrEqual(view.width + 1);
  expect(rect.bottom).toBeLessThanOrEqual(view.height + 1);
  expect(rect.width).toBeGreaterThan(0);
  expect(rect.height).toBeGreaterThan(0);
}
async function scene(page: Page) {
  return page.evaluate(async () => {
    const v = (window as any).velocut;
    const r = await v.sceneClip({
      name: 'Form study',
      spec: {
        version: 1,
        durationUs: 5_000_000,
        width: 1280,
        height: 720,
        environment: 'env/grid',
        lighting: 'indoor',
        props: [
          {
            id: 'plinth',
            name: 'Display plinth',
            model: 'prop/cube',
            position: { y: 0.35 },
            scale: { x: 3.5, y: 0.7, z: 3.5 },
            color: '#657276',
          },
          {
            id: 'sculpture',
            name: 'Amber sculpture',
            model: 'prop/torus',
            position: { y: 1.6 },
            rotationX: 20,
            color: '#dcb273',
            material: { metalness: 0.55, roughness: 0.28 },
          },
        ],
      },
    });
    if (!r.ok) throw new Error(r.message);
    v.directorSession({
      assetId: r.assetId,
      open: true,
      objectId: 'sculpture',
      focusId: null,
    });
    return r;
  });
}

for (const size of [
  { width: 360, height: 480 },
  { width: 360, height: 600 },
  { width: 640, height: 760 },
  { width: 960, height: 720 },
]) {
  test(`compact ${size.width}×${size.height}: workspace drawers, settings and dialogs remain usable`, async ({
    page,
  }) => {
    await boot(page, size.width, size.height);
    await expect(page.locator('.app')).toHaveAttribute('data-compact', 'true');
    for (const selector of ['.project-bar', '.edit-bar', '.workspace-nav', '.timeline-shell'])
      await fits(page, selector);
    await expect(page.getByRole('button', { name: 'Media', exact: true })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await page.getByRole('button', { name: 'Media', exact: true }).click();
    await fits(page, '.media-slot');
    await page.getByRole('button', { name: 'Text layer', exact: true }).click();
    await page.getByRole('button', { name: 'Properties', exact: true }).click();
    await fits(page, '.inspector-slot');
    await expect(page.locator('.text-edit')).toBeVisible();
    await page.locator('.text-edit').fill('A new perspective');
    await expect(page.locator('.workspace-empty')).toHaveCount(0);
    await page.getByRole('button', { name: 'Close properties', exact: true }).click();
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await fits(page, 'dialog[open]');
    await expect(page.getByRole('button', { name: 'Export MP4', exact: true })).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeFocused();
    await page.getByRole('button', { name: 'Connect to Codex', exact: true }).click();
    await fits(page, 'dialog[open]');
    await page.getByRole('textbox', { name: 'Codex connection URL' }).fill('test');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Assistant', exact: true }).click();
    await fits(page, '.agent-console');
    await page.getByRole('button', { name: 'Close assistant' }).click();
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await fits(page, '.hist-panel');
    await page.keyboard.press('Escape');
    await expect(page.locator('.hist-panel')).toHaveCount(0);
    await page.locator('.project-current').click();
    await page.getByRole('button', { name: 'Rename Current…' }).click();
    await page
      .getByRole('textbox', { name: 'Project name' })
      .fill('A deliberately long project name for a narrow Codex workspace');
    await page.getByRole('button', { name: 'Save name' }).click();
    await fits(page, '.export-trigger');
    await page.screenshot({
      path: test.info().outputPath(`edit-${size.width}.png`),
    });
  });
}

test('Director adapts across widths and returns to the same live preview canvas', async ({
  page,
}) => {
  await boot(page, 1440, 900);
  const canvas = await page.locator('.preview-canvas').elementHandle();
  await scene(page);
  await expect(page.locator('.director-canvas')).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({
    path: test.info().outputPath('director-desktop.png'),
  });
  for (const width of [640, 360, 960]) {
    await page.setViewportSize({ width, height: 700 });
    await expect(page.locator('.app')).toHaveAttribute('data-compact', 'true');
    await fits(page, '.director-toolbar');
    await fits(page, '.director-footer');
    await page.getByRole('button', { name: 'Objects', exact: true }).click();
    await fits(page, '.director-side');
    await page.getByRole('button', { name: 'Amber sculpture', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Properties', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await fits(page, '.director-side');
    const rotate = page
      .locator('.director-selcard .prop-row')
      .filter({ has: page.locator('.prop-label', { hasText: 'Rotate X' }) })
      .first()
      .locator('input')
      .first();
    await rotate.fill('35');
    await rotate.press('Enter');
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            JSON.parse((window as any).velocut.doc().assets[0].spec).props.find(
              (p: any) => p.id === 'sculpture',
            ).rotationX,
        ),
      )
      .toBe(35);
    await page.getByRole('button', { name: 'Close Director panel', exact: true }).click();
    await page.screenshot({
      path: test.info().outputPath(`director-${width}.png`),
    });
  }
  await page.getByRole('tab', { name: 'Edit', exact: true }).click();
  expect(await canvas!.evaluate((el) => el === document.querySelector('.preview-canvas'))).toBe(
    true,
  );
  await expect(page.locator('.preview-canvas')).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('.app')).toHaveAttribute('data-compact', 'false');
  await page.screenshot({ path: test.info().outputPath('edit-desktop.png') });
  await page.getByRole('tab', { name: 'Director', exact: true }).click();
  await expect(page.locator('.director-canvas')).toBeVisible();
});

test('compact click insertion, track menu and new-scene controls author undoable content', async ({
  page,
}) => {
  await boot(page, 400, 600);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import Media', exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: 'still.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEklEQVR4nGP8w4AdsOAQH6QSANBkARqrv8JBAAAAAElFTkSuQmCC',
      'base64',
    ),
  });
  await page.getByRole('button', { name: 'Media', exact: true }).click();
  await page.getByRole('button', { name: 'Insert still.png at playhead' }).click();
  await page.getByRole('button', { name: 'Insert still.png at playhead' }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).velocut.doc().tracks.map((t: any) => t.clips.length)),
    )
    .toEqual([1, 1]);
  await page.getByRole('button', { name: 'Close media library' }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).velocut.doc().tracks.length)).toBe(1);
  await page
    .locator('.timeline-panel canvas')
    .click({ button: 'right', position: { x: 40, y: 45 } });
  await fits(page, '.ctx-menu');
  await page.getByRole('button', { name: 'Delete Track', exact: true }).click();
  await fits(page, 'dialog[open]');
  await page.getByRole('button', { name: 'Delete track', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).velocut.doc().tracks.length)).toBe(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).velocut.doc().tracks.length)).toBe(1);
  await page.getByRole('tab', { name: 'Director', exact: true }).click();
  await page.getByRole('button', { name: 'Add cube', exact: true }).click();
  await expect(page.locator('.director-empty')).toHaveCount(0);
  await expect(page.locator('.director-selcard')).toBeVisible();
  await page.getByRole('button', { name: 'Close Director panel' }).click();
  await page.getByRole('button', { name: 'Objects', exact: true }).click();
  await page.getByLabel('Add shape', { exact: true }).selectOption('prop/sphere');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(
            (window as any).velocut.doc().assets.find((a: any) => a.src.startsWith('scene://'))
              .spec,
          ).props.length,
      ),
    )
    .toBe(2);
  await page.keyboard.press('Escape');
  await expect(page.locator('.director-side')).toBeHidden();
});
