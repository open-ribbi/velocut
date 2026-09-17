# Velocut visual assets

The mascot preserves the user-provided lime/ivory character and adds a hand holding
editing scissors. The artwork was created with the built-in imagegen tool.

The full-resolution master, reference and exact generation prompt are in
`docs/brand/` in the repository. `logo-mascot.png` is 512×512 and
`icon-mascot.png` is 64×64. Both themes use the same black-background artwork.

From `web/`, run `npm run build:brand` to export the display sizes and copy the real
Studio screenshots from `docs/media/`. Commit these files so Git/sparse plugin
installs can display them without a build or remote image fetch.

The empty `interface.defaultPrompt` array is intentional. The current desktop
plugin-detail page renders its built-in gradient image whenever starter prompts
are present; that host-owned image is broken in the reported desktop build and
cannot be replaced through plugin screenshot metadata. Examples remain in the
long description. Restore clickable prompts when that host issue is resolved.
