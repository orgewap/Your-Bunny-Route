import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RoadFeature, RoadVertex } from '../src/types/road.ts'
import { surfaceVertices } from '../src/lib/roadSurface.ts'
import { planRoad, materializeRoadPlan } from '../src/lib/topology.ts'
import { reconnectDraggedEndpoint } from '../src/lib/reconnect.ts'
import { snapToLaneAtScreen } from '../src/lib/laneSnap.ts'
import { LANE_WIDTH_METRES } from '../src/lib/lanes.ts'

const point = (id: string, x: number, y: number): RoadVertex => ({ id, lng: x / 111320, lat: y / 111320 })
const road = (id: string, vertices: RoadVertex[], lanes = 2): RoadFeature => ({
  id, osmId: id, highway: 'residential', lanes, oneway: false, bridge: false, level: 0, name: '', tags: {}, vertices,
})
const project = (lng: number, lat: number) => ({ x: 500 + lng * 111320 * 2, y: 300 - lat * 111320 * 2 })

function targetAndLink(atEnd = false) {
  const target = road('target', [point('a', -60, 0), point('b', 60, 0)], 4)
  const zoom = 17.5
  const x = atEnd ? 620 : 380
  const chosen = snapToLaneAtScreen({ x, y: 300 + 2 * LANE_WIDTH_METRES * 2 }, [target], project, zoom, '2d', 14)
  assert.ok(chosen)
  assert.equal(chosen.link.t, atEnd ? 1 : 0)
  return { target, chosen }
}

test('generated lane approach is visibly joined at the START node of the target OSM way', () => {
  const { target, chosen } = targetAndLink(false)
  const plan = planRoad([chosen.visibleVertex, point('out', -60, -45)], [target], 2, null, [true, false], [chosen.link, null])
  const materialized = materializeRoadPlan(plan, [target])
  const created = materialized.roads[0]!
  const editedTarget = materialized.modifiedExisting.get('target')!
  assert.equal(created.vertices[0]!.id, editedTarget[0]!.id)
  assert.equal(created.visualApproach?.start, true)
  assert.equal(surfaceVertices(created, [created, { ...target, vertices: editedTarget }])[0]!.id, created.vertices[1]!.id)
})

test('generated lane approach is visibly joined at the END node of the target OSM way', () => {
  const { target, chosen } = targetAndLink(true)
  const branch = road('branch', [point('bottom', 60, -40), point('free-end', 60, -20)])
  const connected = reconnectDraggedEndpoint([target, branch], 'free-end', chosen.link)
  const updated = connected.find(x => x.id === 'branch')!
  assert.equal(updated.vertices.at(-1)!.id, 'b')
  assert.equal(updated.visualApproach?.end, true)
  assert.equal(surfaceVertices(updated, connected).at(-1)!.id, updated.vertices[1]!.id)
})

test('plain imported OSM way at terminal junction remains visible without an explicit lane approach', () => {
  const { target } = targetAndLink(false)
  const branch = road('branch', [target.vertices[0]!, point('lane-point', -60, -6.4), point('out', -60, -40)])
  assert.equal(surfaceVertices(branch, [target, branch]).length, 3)
})

test('endpoint snap uses on-screen lane instead of a different underlying centreline', () => {
  const near = road('near', [point('near-a', -60, 0), point('near-b', 60, 0)], 4)
  const far = road('far', [point('far-a', -60, -17), point('far-b', 60, -17)], 2)
  const selected = snapToLaneAtScreen(
    { x: 500, y: 300 + 2 * LANE_WIDTH_METRES * 2 },
    [near, far], project, 17.5, '2d', 17,
  )
  assert.ok(selected)
  assert.equal(selected.link.roadId, 'near')
  assert.equal(selected.link.laneAttachment?.offsetMetres, 6.4)
})

test('pointer-up recomputes snap instead of retaining mousemove result', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/components/MapEditor.vue', import.meta.url), 'utf8')
  assert.match(src, /const released = dragged \? releasedMapPointer\(event\) : null/)
  assert.match(src, /dragSnap = released\.originalEvent\.altKey\s*\? null\s*:\s*draggedEndpointSnap\(lastDragRaw, released\)/)
  assert.match(src, /if \(store\.mode === '3d'\) return null/)
})
