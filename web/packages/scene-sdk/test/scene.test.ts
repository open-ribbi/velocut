// Unit tests for the pure parts of scene-sdk: spec validation and the action
// sequencing math (deterministic pose resolution). The GL compiler is covered
// by the Playwright E2E path (real browser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSceneSpec, type SceneSpec } from '../src/types.ts';
import { resolveActions, type ClipMeta } from '../src/actions.ts';
import { expandShots, CUT_EASE } from '../src/shots.ts';

// ---------------------------------------------------------------- validation

const base = { version: 1 as const, durationUs: 3_000_000 };

test('validateSceneSpec: accepts a minimal spec and a full spec', () => {
  assert.equal(validateSceneSpec(base), null);
  assert.equal(
    validateSceneSpec({
      ...base,
      environment: 'env/stage',
      lighting: 'night',
      characters: [
        {
          id: 'figure',
          model: 'char/mannequin',
          pose: { preset: 'bow', joints: { torso: [[{ t: 0, v: 0 }, { t: 1, v: 45 }], 0, 0] } },
          color: '#4f8ef7',
        },
        {
          id: 'hero',
          model: 'char/robot',
          position: { x: [{ t: 0, v: -3 }, { t: 3, v: 0 }], z: 0 },
          rotationY: 90,
          actions: [
            { clip: 'Walking', start: 0 },
            { clip: 'Wave', start: 2, fade: 0.4 },
          ],
        },
      ],
      props: [
        { model: 'prop/cube', position: { x: 2 }, color: '#ff0000' },
        { model: 'prop/pillar', position: { x: 1 }, scale: { x: 0.2, y: 3, z: 0.2 } },
        { model: 'prop/sphere', scale: 1.5 },
        { model: 'prop/lathe', points: [[0.12, 0], [0.2, 0.1], [0.08, 0.5], [0.14, 0.7]] },
        { model: 'prop/extrude', points: [[0, 0.4], [0.3, 0], [0.1, 0], [0.1, -0.4], [-0.1, -0.4], [-0.1, 0], [-0.3, 0]], depth: 0.08 },
      ],
      camera: { fov: 35, position: { x: 5, y: 2, z: 7 }, lookAt: { character: 'hero' } },
    }),
    null,
  );
});

test('validateSceneSpec: rejection table', () => {
  const bad: Array<[unknown, RegExp]> = [
    [null, /object/],
    [{ version: 2, durationUs: 1 }, /version/],
    [{ ...base, durationUs: 0 }, /durationUs/],
    [{ ...base, characters: [{ model: 'char/robot' }] }, /string id/],
    [{ ...base, characters: [{ id: 'a', model: 'char/x' }, { id: 'a', model: 'char/x' }] }, /duplicate/],
    [{ ...base, characters: [{ id: 'a', model: 5 }] }, /model/],
    [{ ...base, characters: [{ id: 'a', model: 'char/x', actions: [{ clip: 'Walk', start: -1 }] }] }, /start/],
    [{ ...base, characters: [{ id: 'a', model: 'char/x', position: { x: 'left' } }] }, /position/],
    [{ ...base, camera: { lookAt: { charcter: 'typo' } } }, /lookAt/],
    [{ ...base, props: [{ position: {} }] }, /model/],
    [{ ...base, props: [{ model: 'prop/cube', scale: 'big' }] }, /scale/],
    [{ ...base, props: [{ model: 'prop/cube', scale: { x: 1, w: 2 } }] }, /scale/],
    [{ ...base, characters: [{ id: 'a', model: 'char/x', scale: { y: NaN } }] }, /scale/],
    [{ ...base, characters: [{ id: 'a', model: 'char/x', gaze: 'sideways' }] }, /gaze/],
    [{ ...base, props: [{ model: 'prop/cube', attachTo: { bone: 'handR' } }] }, /attachTo/],
    [{ ...base, props: [{ model: 'prop/cube', attachTo: { character: 'ghost' } }] }, /no character with id/],
    [{ ...base, characters: [{ id: 'a', model: 'char/x', morphs: ['Angry'] }] }, /morphs/],
    [{ ...base, characters: [{ id: 'a', model: 'char/x', morphs: { Angry: 'very' } }] }, /morph 'Angry'/],
    [{ ...base, props: [{ model: 'prop/lathe' }] }, /lathe needs points/],
    [{ ...base, props: [{ model: 'prop/lathe', points: [[-0.1, 0], [0.2, 1]] }] }, /radii/],
    [{ ...base, props: [{ model: 'prop/extrude', points: [[0, 0], [1, 0]] }] }, /extrude needs points/],
    [{ ...base, props: [{ model: 'prop/extrude', points: [[0, 0], [1, 0], [0.5, 1]], depth: -1 }] }, /depth/],
    [{ ...base, props: [{ model: 'prop/cube', points: [[0, 0], [1, 0], [0.5, 1]] }] }, /does not take points/],
    [{ ...base, characters: [{ id: 'a', model: 'char/mannequin', pose: 42 }] }, /pose/],
    [{ ...base, characters: [{ id: 'a', model: 'char/mannequin', pose: { joints: { torso: [1, 2] } } }] }, /pose.joints.torso/],
    [{ ...base, durationUs: Infinity }, /durationUs/],
    [{ ...base, fps: 0 }, /fps/],
    [{ ...base, fps: NaN }, /fps/],
    [{ ...base, width: 8 }, /width/],
    [{ ...base, height: 1e9 }, /height/],
    [{ ...base, characters: [{ id: 'a', model: 'char/x', rotationY: NaN }] }, /rotationY/],
    [{ ...base, characters: [{ id: 'a', model: 'char/x', position: { x: [{ t: 0, v: NaN }] } }] }, /position/],
    [{ ...base, characters: [{ id: 'a', model: 'char/x', position: { x: [] } }] }, /position/],
    [{ ...base, characters: [{ id: 'a', model: 'char/x', actions: [{ clip: 'W', start: NaN }] }] }, /start/],
    [{ ...base, characters: [{ id: 'a', model: 'char/x', actions: [{ clip: 'W', start: 0, fade: -1 }] }] }, /fade/],
    [{ ...base, characters: [{ id: 'a', model: 'char/mannequin', pose: 'sitng' }] }, /unknown pose preset/],
    [{ ...base, characters: [{ id: 'a', model: 'char/mannequin', pose: { preset: 'sitng' } }] }, /unknown pose preset/],
    [{ ...base, characters: [{ id: 'a', model: 'char/mannequin', pose: { joints: { torzo: [1, 2, 3] } } }] }, /unknown joint/],
    [{ ...base, characters: [{ id: 'a', model: 'char/mannequin', color: 7 }] }, /color/],
    [{ ...base, camera: { roll: 'tilted' } }, /roll/],
    [{ ...base, camera: { shake: { amplitude: 'lots' } } }, /shake/],
    [{ ...base, shots: [] }, /shots/],
    [{ ...base, shots: [{ start: 1, camera: {} }] }, /shots\[0\].start must be 0/],
    [{ ...base, shots: [{ start: 0, camera: {} }, { start: 2, camera: {} }, { start: 1, camera: {} }] }, /sorted/],
    [
      { ...base, shots: [{ start: 0, camera: { lookAt: { character: 'a' } } }, { start: 1, camera: { lookAt: { x: 0 } } }] },
      /mix point lookAt and character/,
    ],
    [
      { ...base, shots: [{ start: 0, camera: { lookAt: { character: 'a' } } }, { start: 1, camera: { lookAt: { character: 'b' } } }] },
      /different characters/,
    ],
  ];
  for (const [spec, re] of bad) {
    const err = validateSceneSpec(spec);
    assert.ok(err && re.test(err), `expected ${re} for ${JSON.stringify(spec)}, got: ${err}`);
  }
});

// ------------------------------------------------------------ action math

const CLIPS: Record<string, ClipMeta> = {
  Walking: { duration: 1.0, loop: true },
  Wave: { duration: 2.0, loop: false },
  Idle: { duration: 4.0, loop: true },
};

test('resolveActions: single looping action wraps its local time', () => {
  const seq = [{ clip: 'Walking', start: 0 }];
  const p = resolveActions(seq, 2.25, CLIPS);
  assert.equal(p.length, 1);
  assert.equal(p[0].clip, 'Walking');
  assert.ok(Math.abs(p[0].time - 0.25) < 1e-9);
  assert.equal(p[0].weight, 1);
});

test('resolveActions: non-looping action holds its last pose', () => {
  const seq = [{ clip: 'Wave', start: 1 }];
  const p = resolveActions(seq, 10, CLIPS);
  assert.equal(p[0].clip, 'Wave');
  assert.ok(p[0].time < 2.0 && p[0].time > 1.99);
});

test('resolveActions: cross-fade blends the previous and current action', () => {
  const seq = [
    { clip: 'Walking', start: 0 },
    { clip: 'Wave', start: 2, fade: 0.5 },
  ];
  // Mid-fade at t=2.25 → Walking 0.5, Wave 0.5; Walking keeps advancing.
  const p = resolveActions(seq, 2.25, CLIPS);
  assert.equal(p.length, 2);
  const walk = p.find((x) => x.clip === 'Walking')!;
  const wave = p.find((x) => x.clip === 'Wave')!;
  assert.ok(Math.abs(walk.weight - 0.5) < 1e-9);
  assert.ok(Math.abs(wave.weight - 0.5) < 1e-9);
  assert.ok(Math.abs(walk.time - 0.25) < 1e-9); // 2.25 % 1.0
  assert.ok(Math.abs(wave.time - 0.25) < 1e-9); // 2.25 - 2
  // After the fade → only Wave.
  const after = resolveActions(seq, 2.75, CLIPS);
  assert.equal(after.length, 1);
  assert.equal(after[0].clip, 'Wave');
  assert.equal(after[0].weight, 1);
});

test('resolveActions: before the first action → its first frame', () => {
  const seq = [{ clip: 'Wave', start: 5 }];
  const p = resolveActions(seq, 1, CLIPS);
  assert.equal(p[0].clip, 'Wave');
  assert.equal(p[0].time, 0);
});

test('resolveActions: unknown clips are skipped, same-clip fade collapses', () => {
  assert.equal(resolveActions([{ clip: 'Nope', start: 0 }], 1, CLIPS).length, 0);
  const seq = [
    { clip: 'Walking', start: 0 },
    { clip: 'Walking', start: 2, fade: 1 },
  ];
  const p = resolveActions(seq, 2.5, CLIPS);
  assert.equal(p.length, 1);
  assert.equal(p[0].weight, 1);
});

// ------------------------------------------------------------ shot expansion

test('expandShots: cuts hold the previous value then jump at the boundary', () => {
  const spec: SceneSpec = {
    version: 1,
    durationUs: 6_000_000,
    shots: [
      { start: 0, camera: { position: { x: 6, y: 2, z: 8 }, fov: 40 } },
      { start: 2.5, camera: { position: { x: [{ t: 0, v: -2 }, { t: 1.5, v: -1 }], y: 1.4, z: 3 }, fov: 30 } },
    ],
  };
  const out = expandShots(spec);
  assert.equal(out.shots, undefined);
  const cam = out.camera!;
  const px = cam.position!.x as Array<{ t: number; v: number; ease?: string }>;
  // Shot 1 constant → one key at 0; shot 2's first key arrives as a cut at 2.5.
  assert.deepEqual(px[0], { t: 0, v: 6, ease: undefined });
  assert.equal(px[1].t, 2.5);
  assert.equal(px[1].v, -2);
  assert.equal(px[1].ease, CUT_EASE);
  // In-shot keyframes shift to scene time and keep their own ease.
  assert.equal(px[2].t, 4);
  assert.equal(px[2].v, -1);
  const fov = cam.fov as Array<{ t: number; v: number; ease?: string }>;
  assert.deepEqual(fov.map((k) => [k.t, k.v, k.ease]), [[0, 40, undefined], [2.5, 30, CUT_EASE]]);
});

test('expandShots: character tracking survives expansion; no shots = passthrough', () => {
  const spec: SceneSpec = {
    version: 1,
    durationUs: 4_000_000,
    shots: [
      { start: 0, camera: { position: { x: 5 }, lookAt: { character: 'hero' } } },
      { start: 2, camera: { position: { x: -5 }, lookAt: { character: 'hero' } } },
    ],
  };
  const out = expandShots(spec);
  assert.deepEqual(out.camera!.lookAt, { character: 'hero' });
  const plain: SceneSpec = { version: 1, durationUs: 1_000_000, camera: { position: { x: 1 } } };
  assert.equal(expandShots(plain), plain);
});

test('resolveActions: determinism — same inputs, same output', () => {
  const seq = [
    { clip: 'Idle', start: 0 },
    { clip: 'Walking', start: 1.5, fade: 0.3 },
    { clip: 'Wave', start: 4, fade: 0.3 },
  ];
  for (const t of [0, 0.7, 1.6, 1.79, 3.2, 4.1, 4.29, 9]) {
    assert.deepEqual(resolveActions(seq, t, CLIPS), resolveActions(seq, t, CLIPS));
  }
});

// ------------------------------------------------------------------ physics

test('validateSceneSpec: physics vocabulary', () => {
  const prop = (physics: unknown, extra: object = {}) => ({
    ...base,
    props: [{ model: 'prop/cube', position: { x: 1, y: 2 }, physics, ...extra } as never],
  });
  // Accepted forms.
  assert.equal(validateSceneSpec(prop('dynamic')), null);
  assert.equal(validateSceneSpec(prop('fixed')), null);
  assert.equal(
    validateSceneSpec(prop({ type: 'dynamic', mass: 40, restitution: 0.5, friction: 0.2, velocity: [12, 2, 0], angularVelocity: [0, 90, 0], startAt: 1 })),
    null,
  );
  // Kinematic colliders are the keyframe-driven ones.
  assert.equal(
    validateSceneSpec({ ...base, props: [{ model: 'prop/cube', position: { x: [{ t: 0, v: 0 }, { t: 2, v: 4 }] }, physics: 'kinematic' }] }),
    null,
  );
  assert.equal(validateSceneSpec({ ...base, physics: { gravity: 3.7 } }), null);

  const rejects: Array<[unknown, RegExp]> = [
    [prop('bouncy'), /physics must be/],
    [prop({ type: 'dynamic', restitution: 1.5 }), /restitution/],
    [prop({ type: 'dynamic', mass: 0 }), /mass/],
    [prop({ type: 'dynamic', velocity: [1, 2] }), /velocity/],
    [prop({ type: 'fixed', velocity: [1, 0, 0] }), /only apply to type 'dynamic'/],
    [prop({ type: 'dynamic', bounce: 1 }), /takes only/],
    [{ ...base, props: [{ model: 'prop/cube', position: { y: [{ t: 0, v: 0 }, { t: 1, v: 2 }] }, physics: 'dynamic' }] }, /must be constants/],
    [{ ...base, characters: [{ id: 'a', model: 'char/robot' }], props: [{ model: 'prop/cube', physics: 'dynamic', attachTo: { character: 'a' } }] }, /attachTo cannot combine/],
    [{ ...base, physics: { gravity: -1 } }, /gravity/],
    [{ ...base, physics: { wind: 3 } }, /takes only/],
  ];
  for (const [spec, re] of rejects) {
    const err = validateSceneSpec(spec);
    assert.ok(err && re.test(err), `expected ${re} for ${JSON.stringify(spec)}, got: ${err}`);
  }
});

test('bakePhysics: a dropped ball settles on the ground, deterministically', async () => {
  const three = await import('three');
  const { bakePhysics, samplePhysicsTrack, PHYSICS_HZ } = await import('../src/physics.ts');
  const spec: SceneSpec = {
    version: 1,
    durationUs: 6_000_000,
    props: [
      { model: 'prop/sphere', position: { y: 3 }, physics: 'dynamic' },
      { model: 'prop/cube', position: { x: 3, y: 0.5 }, physics: 'fixed' },
      { model: 'prop/cube', position: { x: -3 } }, // no physics → no track
    ],
  };
  const targets = spec.props!.map((p) => ({
    spec: p,
    mesh: new three.Mesh(p.model === 'prop/sphere' ? new three.SphereGeometry(0.5, 32, 16) : new three.BoxGeometry(1, 1, 1)),
  }));
  const tracks = await bakePhysics(spec, targets);
  assert.equal(tracks.length, 3);
  assert.ok(tracks[0], 'dynamic prop gets a track');
  assert.equal(tracks[1], null, 'fixed props stay spec-driven');
  assert.equal(tracks[2], null);

  const ball = tracks[0]!;
  const out = { position: new three.Vector3(), quaternion: new three.Quaternion() };
  samplePhysicsTrack(ball, 0, out);
  assert.ok(Math.abs(out.position.y - 3) < 1e-6, `starts at y=3, got ${out.position.y}`);
  samplePhysicsTrack(ball, 6, out);
  assert.ok(Math.abs(out.position.y - 0.5) < 0.06, `rests at ~radius (0.5), got ${out.position.y}`);
  // The world goes to sleep → the bake early-outs well before 6s of samples.
  assert.ok(ball.count < 6 * PHYSICS_HZ, `early-out expected, recorded ${ball.count} samples`);

  // Determinism: an identical second bake is byte-identical.
  const again = await bakePhysics(spec, targets);
  assert.deepEqual(Array.from(again[0]!.samples), Array.from(ball.samples));
  assert.equal(again[0]!.count, ball.count);
});

test('bakePhysics: startAt holds a body, then releases it with its velocity', async () => {
  const three = await import('three');
  const { bakePhysics, samplePhysicsTrack } = await import('../src/physics.ts');
  const spec: SceneSpec = {
    version: 1,
    durationUs: 3_000_000,
    props: [{ model: 'prop/sphere', position: { x: 0, y: 1 }, physics: { type: 'dynamic', velocity: [10, 0, 0], startAt: 1 } }],
  };
  const targets = [{ spec: spec.props![0], mesh: new three.Mesh(new three.SphereGeometry(0.5, 32, 16)) }];
  const [track] = await bakePhysics(spec, targets);
  const out = { position: new three.Vector3(), quaternion: new three.Quaternion() };
  samplePhysicsTrack(track!, 0.99, out);
  assert.ok(Math.abs(out.position.x) < 1e-6, `held in place before startAt, got x=${out.position.x}`);
  samplePhysicsTrack(track!, 1.5, out);
  assert.ok(out.position.x > 3, `moving after release, got x=${out.position.x}`);
});
