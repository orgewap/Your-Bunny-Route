import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RoadFeature, RoadVertex } from '../src/types/road.ts'
import { updateSelectedDraggedVertex } from '../src/lib/vertexDrag.ts'
import { reconnectDraggedEndpoint } from '../src/lib/reconnect.ts'
import { planRoad, materializeRoadPlan } from '../src/lib/topology.ts'
import { surfaceVertices, surfaceNetwork } from '../src/lib/roadSurface.ts'
import { shouldCaptureMoveTab } from '../src/lib/moveShortcut.ts'

const pt = (id: string, east: number, north: number): RoadVertex => ({ id, lng: east / 111320, lat: north / 111320 })
const makeRoad = (id: string, points: RoadVertex[], lanes = 2): RoadFeature => ({
  id, osmId: `-${id.length + id.charCodeAt(0)}`, name: id, highway: 'residential',
  lanes, bridge: false, level: 0, oneway: false, vertices: points, tags: {},
})

test('editing one selected endpoint does not drag neighbouring OSM roads sharing its node', () => {
  const shared = pt('common', 0, 0)
  const first = makeRoad('first', [pt('a', -35, 0), shared])
  const second = makeRoad('second', [shared, pt('b', 0, 40)])
  const untouched = JSON.stringify(second)
  const id = updateSelectedDraggedVertex([first, second], first.id, shared.id, 8 / 111320, 0, () => 'detached')
  assert.equal(id, 'detached')
  assert.equal(first.vertices.at(-1)!.id, 'detached')
  assert.ok(Math.abs(first.vertices.at(-1)!.lng * 111320 - 8) < 0.01)
  assert.equal(JSON.stringify(second), untouched)
})

test('imported OSM node is cloned even if its other owners are not roads', () => {
  const original = pt('osm-node-812', 0, 0)
  const way = makeRoad('road', [original, pt('b', 40, 0)])
  const id = updateSelectedDraggedVertex([way], way.id, original.id, 4 / 111320, 0, () => 'new-id')
  assert.equal(id, 'new-id')
  assert.equal(way.vertices[0]!.id, 'new-id')
  assert.equal(original.id, 'osm-node-812')
  assert.equal(original.lng, 0)
})

test('dragged road can reconnect to another OSM way and creates a real shared node', () => {
  const source = makeRoad('branch', [pt('start', -20, -20), pt('finish', 0, -20)])
  const target = makeRoad('target', [pt('top', 10, -50), pt('bottom', 10, 50)], 4)
  const id = updateSelectedDraggedVertex([source, target], source.id, 'finish', 9 / 111320, 0, () => 'new-end')
  const link = { roadId: target.id, segmentIndex: 0, t: 0.5, vertex: pt('junction', 10, 0) }
  const output = reconnectDraggedEndpoint([source, target], id, link)
  const end = output.find(r => r.id === source.id)!.vertices.at(-1)!
  const targetVertices = output.find(r => r.id === target.id)!.vertices
  assert.equal(end.id, 'junction')
  assert.equal(targetVertices[1]!.id, end.id)
  assert.equal(targetVertices.length, 3)
})

test('moving a generated lane attachment removes its stale visual approach', () => {
  const oldJunction = pt('common', 0, 0)
  const branch = makeRoad('branch', [oldJunction, pt('lane-entry', 0, -6.4), pt('tail', 0, -40)])
  branch.visualApproach = { start: true }
  const original = makeRoad('main', [pt('west', -40, 0), oldJunction, pt('east', 40, 0)], 4)
  const id = updateSelectedDraggedVertex([branch, original], 'branch', 'common', 10 / 111320, 0, () => 'detached')
  assert.equal(id, 'detached')
  assert.equal(branch.visualApproach?.start, false)
  assert.equal(branch.vertices.length, 2)
  assert.equal(branch.vertices[0]!.id, 'detached')
  assert.equal(original.vertices[1]!.id, 'common')
})

test('imported OSM T junction is never heuristically clipped; only generated attachments may trim', () => {
  const shared = pt('shared', 0, 0)
  const main = makeRoad('main', [pt('west', -60, 0), shared, pt('east', 60, 0)], 4)
  const branch = makeRoad('branch', [shared, pt('edge', 0, -6.4), pt('south', 0, -55)])
  assert.equal(surfaceVertices(branch, [main, branch]).length, 3)
  branch.visualApproach = { start: true }
  assert.equal(surfaceVertices(branch, [main, branch]).length, 2)
  const snapshot = JSON.stringify([main, branch])
  const visual = surfaceNetwork([main, branch])
  assert.equal(visual[1]!.vertices[0]!.id, 'edge')
  assert.equal(JSON.stringify([main, branch]), snapshot, 'visual trimming never mutates OSM ways')
})

test('physical lane path gets explicit visual flag while keeping actual OSM junction', () => {
  const main = makeRoad('main', [pt('west', -60, 0), pt('east', 60, 0)], 4)
  const link = { roadId: main.id, segmentIndex: 0, t: 0.5,
    vertex: pt('shared', 0, 0),
    laneAttachment: { laneIndex: 3, laneCount: 4, boundary: true, offsetMetres: 6.4,
      visibleVertex: pt('lane', 0, -6.4) },
  }
  const plan = planRoad([link.laneAttachment.visibleVertex, pt('out', 0, -45)], [main], 3,
    null, [true, false], [link, null])
  assert.deepEqual(plan.visualApproach, [true, false])
  const result = materializeRoadPlan(plan, [main])
  const road = result.roads[0]!
  assert.equal(road.visualApproach?.start, true)
  const updatedMain = result.modifiedExisting.get(main.id)!
  assert.equal(road.vertices[0]!.id, updatedMain[1]!.id)
  assert.equal(road.vertices[1]!.id, 'lane')
})

test('Tab can select and move directly inside map, never captures outside map or input fields', () => {
  const context = { selected: false, tool: 'select', pointerInsideMap: true,
    textEntry: false, otherModifier: false }
  assert.equal(shouldCaptureMoveTab('Tab', context), true)
  assert.equal(shouldCaptureMoveTab('Tab', { ...context, pointerInsideMap: false }), false)
  assert.equal(shouldCaptureMoveTab('Tab', { ...context, textEntry: true }), false)
})
