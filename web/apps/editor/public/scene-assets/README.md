# Scene assets — how to extend the library

Everything the Scene Director can stage is listed in `manifest.json`. Adding a
character is data-only: **drop a GLB here, add a manifest entry** — no code
changes, and the agent's vocabulary (`velocut.sceneAssets()`) updates
automatically.

## Requirements for a character GLB

- **Separate, named animation clips** baked into the GLB (e.g. `Idle`,
  `Walking`, `Wave`). One long merged timeline does not work — the action
  system sequences and cross-fades clips by name.
- A license that permits redistribution if you intend to commit it (CC0 or
  CC-BY with attribution recorded in `LICENSES.md`). For private/local use,
  anything you own works.

## Manifest entry

```jsonc
"char/mychar": {
  "file": "characters/mychar.glb",
  "label": "My Character",
  "license": "CC0-1.0 (author)",       // record it in LICENSES.md too
  "heightM": 1.7,                       // real-world height in meters
  "baseScale": 1,                       // native-units → meters (0.01 for cm rigs)
  "bones": {                            // semantic attach slots → rig bone names
    "handR": "RightHand", "handL": "LeftHand", "head": "Head"
  },
  "morphs": ["Smile", "JawOpen"],       // exposed morph targets (optional)
  "clips": {
    "Idle":    { "loop": true },
    "Walking": { "loop": true, "speedMps": 1.4 },  // gait speed: lets authors
    "Wave":    { "loop": false }                    // pace position keyframes
  }
}
```

To discover a GLB's clip names, bone names and morph targets, load it once and
inspect (DevTools):

```js
const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
const gltf = await new GLTFLoader().loadAsync('/scene-assets/characters/mychar.glb');
gltf.animations.map(a => a.name);                        // clips
gltf.scene.traverse(o => o.isBone && console.log(o.name)); // bones
```

## Where to find good sources

- [Quaternius](https://quaternius.com) — large CC0 packs incl. the Universal
  Animation Library (hundreds of humanoid clips) and animated characters.
  Downloads are manual (no stable direct links), which is why they aren't
  vendored here — but they slot straight in.
- [Kenney](https://kenney.nl) — CC0; some packs need FBX→GLB conversion
  (Blender exports GLB with named actions).
- three.js examples & Khronos glTF samples — individually licensed; check and
  record each.
- **Not acceptable for vendoring**: Mixamo (no redistribution). Fine for your
  own local use.
