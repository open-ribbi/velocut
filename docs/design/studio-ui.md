# Velocut Studio UI

Direction: quiet professional film workspace. Warm graphite surfaces, warm-white
text, amber reserved for selection and primary actions, restrained line icons,
consistent controls and visible keyboard focus. Inspired by Linear's clear
header hierarchy and quieter supporting surfaces:
https://linear.app/now/behind-the-latest-design-refresh

Scope: application shell, every form/button/menu/dialog, library, properties,
preview, timeline canvas, Director/outliner, history, assistant/provider settings,
Codex pairing and empty/error states. Preserve editor APIs and authored content.

Wide layouts keep docked library/properties and a large canvas. At <=960px,
panels become explicit drawers and navigation moves below the work area. The
canvas remains primary; no squeezed three-column mini desktop. Director becomes
a workspace under the project header, with compact tool groups and optional
objects/properties drawers. All controls remain reachable at 360–640px widths.

Validation: desktop and compact screenshots with actual scene content; resize
between modes; no horizontal document overflow; reach every panel, pairing and
export settings; keyboard focus/Escape; real editing and MCP regression tests.

Implemented
-----------
- Shared color/spacing/control tokens and an inline SVG icon vocabulary.
- Separate project header and edit toolbar; Edit/Director workspace switching.
- Searchable media library, click-to-insert at the playhead, and text/scene entry
  points. Occupied or locked tracks are avoided when inserting from the library.
- Aspect-correct monitor that stays mounted when switching to Director, retaining
  its transferred worker canvas. Empty states do not cover text-only projects.
- Timeline fit, zoom and collapse controls; media names lead clip labels.
- Director view/move/rotate/scale controls, explicit undo/redo, searchable object
  hierarchy, primitive/assembly/import controls, axis fields and selection drawer.
- Consistent native dialogs for project management, track deletion, export and
  Codex pairing, with Escape, contained focus, and bounded scrolling.
- Shared navigation for library/objects, properties, history and assistant.
  Floating auxiliary panels remain draggable on desktop and become bounded
  sheets in compact windows; model settings and connection details scroll.
- Compact media insertion requires no dragging. Menus, modal dialogs and focused
  form fields do not accidentally trigger editor shortcuts.

Validation record
-----------------
- Production build and TypeScript checks pass. Existing SDK externalization and
  large-bundle warnings remain; no rendering/engine packages changed.
- 76 engine/SDK tests and 7 packaged MCP tests pass.
- All 28 browser scenarios pass. Coverage includes the existing native authoring, GLB, MCP, export,
  history and persistence journeys plus six Studio UI journeys: 360×480,
  360×600, 640×760 and 960×720 compact forms; desktop↔compact Director editing;
  click insertion, track deletion/undo and primitive creation.
- Screenshots inspected at 1440×900 and compact widths with real 3D content,
  including the restored program monitor, property drawer and provider settings.
- The browser tests produce screenshots under web/test-results. These generated
  artifacts are intentionally not committed. Run `cd web && npm run e2e` to
  reproduce them.

The compact layout is designed for a narrow browser surface opened alongside
Codex. It does not add an embedded custom UI capability to the plugin protocol;
the existing MCP connection and edit API continue to drive the same project.
