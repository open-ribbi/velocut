import { test, expect } from './test-fixtures';

test('distribution measures world bounds under transformed parents and preserves animation', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => (window as any).velocut?.sceneArrange);
  const r = await page.evaluate(async () => {
    const v = (window as any).velocut;
    const made = await v.sceneClip({ spec: { version: 1, durationUs: 2_000_000, width: 320, height: 180,
      groups: [{ id: 'g', rotationY: 35, scale: { x: 2, y: 1.5, z: 1 }, position: { x: 4, y: 2 } }],
      props: [
        { id: 'a', model: 'prop/cube', parentId: 'g', rotationY: 20, position: { x: [{ t: 0, v: 1 }, { t: 1, v: 2 }] } },
        { id: 'b', model: 'prop/cube', scale: { x: 3, y: 1, z: 1 } },
        { id: 'c', model: 'prop/cube', parentId: 'g', scale: 0.5 },
      ] } });
    if (!made.ok) throw new Error(made.message);
    const assetId = made.assetId;
    const before = await v.sceneInspect({ assetId, timeS: 1 });
    const options = { assetId, ids: ['c', 'a', 'b'], mode: 'distribute', axis: 'x', gap: 0.3, start: -4, timeS: 1, expectedRevision: before.revision };
    const preview = await v.sceneArrange({ ...options, dryRun: true });
    const afterPreview = await v.sceneInspect({ assetId, timeS: 1 });
    const placed = await v.sceneArrange(options);
    const after = await v.sceneInspect({ assetId, timeS: 1 });
    const text = () => v.doc().assets.find((a: any) => a.id === assetId).spec;
    const edited = text();
    const conflict = await v.sceneArrange(options);
    const invalid = await v.sceneArrange({ ...options, expectedRevision: after.revision, ids: ['g', 'a'] });
    v.undo(); const undone = text(); v.redo(); const redone = text();
    return { before, preview, afterPreview, placed, after, conflict, invalid, edited, undone, redone };
  });
  expect(r.preview.ok).toBe(true); expect(r.preview.preview).toBe(true);
  expect(r.afterPreview.revision).toBe(r.before.revision); expect(r.afterPreview.spec).toEqual(r.before.spec);
  expect(r.placed.ok, JSON.stringify(r.placed)).toBe(true);
  const ordered = ['c', 'a', 'b'].map(id => r.after.objects.find((o: any) => o.id === id));
  expect(ordered[0].bounds.min[0]).toBeCloseTo(-4, 5);
  for (let i = 1; i < ordered.length; i++) expect(ordered[i].bounds.min[0] - ordered[i - 1].bounds.max[0]).toBeCloseTo(0.3, 5);
  for (const after of ordered) {
    const before = r.before.objects.find((o: any) => o.id === after.id);
    expect(after.position[1]).toBeCloseTo(before.position[1], 5); expect(after.position[2]).toBeCloseTo(before.position[2], 5);
  }
  const keys = r.after.spec.props.find((p: any) => p.id === 'a').position.x;
  expect(keys[1].v - keys[0].v).toBeCloseTo(1);
  expect(r.conflict.ok).toBe(false); expect(r.conflict.message).toMatch(/conflict/);
  expect(r.invalid.ok).toBe(false); expect(r.invalid.message).toMatch(/descendant/);
  expect(JSON.parse(r.undone)).toEqual(r.before.spec); expect(r.redone).toBe(r.edited);
});

test('dry-run compiles resources and rejects invalid models without document changes', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => (window as any).velocut?.sceneEdit);
  const result = await page.evaluate(async () => {
    const v = (window as any).velocut;
    const made = await v.sceneClip({ spec: { version: 1, durationUs: 1_000_000, width: 320, height: 180 } });
    const before = v.store.getState().revision;
    const r = await v.sceneEdit({ assetId: made.assetId, dryRun: true, edits: [{ type: 'add', kind: 'prop', object: { id: 'missing', model: 'prop/not-available' } }] });
    return { r, before, after: v.store.getState().revision, spec: JSON.parse(v.doc().assets.find((a: any) => a.id === made.assetId).spec) };
  });
  expect(result.r.ok).toBe(false); expect(result.r.message).toMatch(/unknown prop/);
  expect(result.after).toBe(result.before); expect(result.spec.props ?? []).toHaveLength(0);
});
