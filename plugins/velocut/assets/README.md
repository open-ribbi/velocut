# Velocut visual assets

`logo.svg` is the editable source. The split golden V represents an editing cut.
The mark uses the Studio accent (`#E6B774`) on an ink-green tile (`#15221F`).
`logo.png` is 512×512; `icon.png` is 64×64 for compact composer/tool surfaces.
Both themes use the same self-contained tile.

From `web/`, run `npm run build:brand` to export PNGs and copy the real Studio
screenshots from `docs/media/`. Commit the exported assets so Git/sparse plugin
installs can display them without a build or network image fetch.

The empty `interface.defaultPrompt` array is intentional. The current desktop
plugin-detail page renders its built-in gradient image whenever starter prompts
are present; that host-owned image is broken in the reported desktop build and
cannot be replaced through plugin screenshot metadata. Examples remain in the
long description. Restore clickable prompts when that host issue is resolved.
