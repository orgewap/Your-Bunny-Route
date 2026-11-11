ROAD EDITOR — INFRASTRUCTURE PLACEMENT FIX

This update fixes placement of traffic signals, STOP signs, Give Way signs,
pedestrian crossings and stop lines in the existing infrastructure tool.

WHAT CHANGED
- Placement clicks are no longer intercepted by the hit area of an existing
  sign or stop line. Use Select to edit an existing item; placement mode now
  always places a new item.
- The placement tool remains active after placing an item, so several objects
  can be added in one pass. Press Esc to leave placement mode.
- Placement uses the rendered lane under the pointer, not only the road
  centreline. This supports wide roads (up to 10 lanes) and avoids snapping to
  a nearby parallel road when MapLibre identifies the clicked road.
- Infrastructure can be placed in 3D using screen-space lane snapping. A
  raised bridge deck is accepted only when it was explicitly hit on screen;
  ordinary 2D placement continues to prefer the ground level.
- Existing OSM node/way IDs, lane selection, direction settings, stop-line
  geometry, Undo/Redo and export tags remain unchanged.

FILES
- src/components/MapEditor.vue
- src/stores/editor.ts
- src/lib/infrastructure.ts
- tests/infrastructure.test.mts

INSTALL
1. Stop Vite.
2. Back up the project folder.
3. Extract this ZIP into the project root, allowing overwrite.
4. Run:
   npm run typecheck
   npm run test:topology
   npm run dev

No backend restart, database migration or backend/data replacement is needed.

NOTE
The TypeScript check and 191 topology/unit tests passed in the build workspace.
A full Vite bundle could not be run in the Linux workspace because the optional
@rollup/rollup-linux-x64-gnu package is absent. Run npm run build on Windows if
you want the final production-bundle check.
