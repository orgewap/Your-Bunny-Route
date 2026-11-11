import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

const mapSource = readFileSync(new URL('../src/components/MapEditor.vue', import.meta.url), 'utf8')
const inspectorSource = readFileSync(new URL('../src/components/PropertyPanel.vue', import.meta.url), 'utf8')
const storeSource = readFileSync(new URL('../src/stores/editor.ts', import.meta.url), 'utf8')

test('renderer invalidates on a small integer revision rather than deeply watching OSM vertices', () => {
  assert.match(mapSource, /watch\(\(\) => store\.geometryRevision, scheduleRedraw\)/)
  assert.doesNotMatch(mapSource, /watch\(\(\) => store\.roads,.*deep: true/)
  assert.match(storeSource, /geometryRevision\.value\+\+/)
})

test('3D road, road-furniture and traffic-control buffers invalidate independently', () => {
  assert.match(mapSource, /if \(is3d && \(meshRoadKey !== lastMeshRoadKey/)
  assert.match(mapSource, /roadMesh\.setRoads\(motorVisible \? visibleSurfaces : \[\], null, visibleAllRoads\)/)
  assert.match(mapSource, /roadMesh\.setRoadInfrastructure\(/)
  assert.match(mapSource, /roadMesh\.setInfrastructure\(/)
  assert.match(mapSource, /roadMesh\.setPedestrianSurfaces\(/)
  assert.match(mapSource, /roadMesh\.setEnabled\(meshEnabled\)/)
})


test('first infrastructure node updates the status strip without rebuilding the asphalt buffer', () => {
  assert.match(mapSource, /const meshStatusKey = `\$\{roadRevision\}:\$\{statusRevision\}/)
  assert.match(mapSource, /roadMesh\.setRoadStatusSurface\(motorVisible \? visibleSurfaces : \[\]\)/)
  assert.match(mapSource, /const meshRoadKey = `\$\{roadRevision\}:\$\{viewportKey\}/)
  assert.doesNotMatch(mapSource, /const meshRoadKey = `\$\{roadRevision\}:\$\{statusRevision\}/)
})

test('map cursor and 2D graph calculations are coalesced and limited to nearby roads', () => {
  assert.match(mapSource, /previewFrame = requestAnimationFrame/)
  assert.match(mapSource, /drawFrame = requestAnimationFrame/)
  assert.match(mapSource, /laneGraph = map\.getZoom\(\) >= 14 \? buildLaneGraph\(visibleRoads/)
  assert.match(mapSource, /snapToLaneAtScreen\(/)
})

test('inspector never rebuilds a full-network graph for one selected lane', () => {
  assert.match(inspectorSource, /const localRoads = store\.roads\.filter/)
  assert.match(inspectorSource, /buildLaneGraph\(localRoads, \{ connectionRoadId:/)
  assert.doesNotMatch(inspectorSource, /buildLaneGraph\(store\.roads/)
})

test('Undo stores raw snapshots without recursive Vue proxies', () => {
  assert.match(storeSource, /const history = shallowRef/)
  assert.match(storeSource, /const future = shallowRef/)
})

test('all graph connections remain visible even without a selected lane', () => {
  assert.match(mapSource, /function allGraphConnectionsCollection\(\)/)
  assert.match(mapSource, /updateSource\('editor-graph-connections', allGraphConnectionsCollection\(\)\)/)
})

test('road and lane GeoJSON are clipped to buffered view instead of full city on each selection', () => {
  assert.match(mapSource, /visibleSurfaces\.filter\(road => road\.vertices\.length >= 2\)/)
  assert.match(mapSource, /laneVisualFeatures\(visibleSurfaces, store\.selectedId\)/)
  assert.match(mapSource, /laneVisualFeatures\(visibleBorderSurfaces, store\.selectedId\)/)
  assert.match(mapSource, /cachedViewport = expandBounds\(boundsNow, padMetres\)/)
  assert.match(mapSource, /if \(selectionChanged \|\| viewChanged \|\| statusChanged\)/)
})

test('3D detail is reduced at overview zoom; imported OSM and server logic are untouched', () => {
  assert.match(mapSource, /const sceneDetail = zoom >= 18 \? 2 : zoom >= 16 \? 1 : 0/)
  assert.match(mapSource, /roadMesh\.setRoads\(motorVisible \? visibleSurfaces : \[\], null, visibleAllRoads\)/)
  assert.match(mapSource, /roadMesh\.setRoadInfrastructure\(motorVisible \? visibleSurfaces : \[\], barriers, lanePaint/)
  assert.match(mapSource, /const pedestrianDetail = zoom >= 18 \? 2 : zoom >= 15 \? 1 : 0/)
})


test('placing infrastructure does not deep-copy the complete road graph or parse OSM XML per click', () => {
  const placement = storeSource.slice(storeSource.indexOf('function placeInfrastructure('),
    storeSource.indexOf('function changeInfrastructureDirection('))
  assert.match(placement, /checkpointInfrastructure\(/)
  assert.match(placement, /allocateOsmId\(\)/)
  assert.doesNotMatch(placement, /new DOMParser\(/)
  assert.doesNotMatch(placement, /copyRoads\(roads\.value\)/)
})

test('pedestrian geometry is viewport-scoped and has a dedicated 3D mesh', () => {
  assert.match(mapSource, /pedestrianVisualFeatures\(visibleAllRoads/)
  assert.match(mapSource, /pedestrianSurfaceFeatures\(visibleAllRoads/)
  assert.match(mapSource, /indexedAllRoads = indexRoadBounds\(store\.roads\)/)
  assert.match(mapSource, /roadMesh\.setPedestrianSurfaces\(pedestrianVisible \? visibleAllRoads : \[\]/)
})
