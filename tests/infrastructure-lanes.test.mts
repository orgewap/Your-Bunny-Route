import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RoadFeature, RoadVertex } from '../src/types/road.ts'
import type { InfrastructureFeature } from '../src/lib/infrastructure.ts'
import {
  allowedInfrastructureLanes, effectiveInfrastructureLanes, stopLineLaneSegments,
  contiguousLanes, infrastructureIconLocation, infrastructureMarkings,
  infrastructureRoadPlacement, nearbyInfrastructureRoads, featureTags,
} from '../src/lib/infrastructure.ts'

function point(id: string, x: number, y: number): RoadVertex {
  return { id, lng: x / 111_320, lat: y / 111_320 }
}
function road(id: string, y = 0, lanes = 5, oneway = true): RoadFeature {
  return { id, osmId: id, name: id, highway: 'primary', lanes, oneway, bridge: false, level: 0,
    vertices: [point(`${id}-a`, -70, y), point(`${id}-b`, 70, y)], tags: {} }
}
function signal(overrides: Partial<InfrastructureFeature> = {}): InfrastructureFeature {
  return { id: 'signal', osmId: '99', element: 'node', kind: 'traffic_signal',
    vertices: [point('control', 0, 0)], tags: { highway: 'traffic_signals' },
    direction: 'forward', ...overrides }
}

test('five one-way lanes can be selected independently, including just second and third', () => {
  const r = road('main')
  assert.deepEqual(allowedInfrastructureLanes(r, 'forward'), [0, 1, 2, 3, 4])
  assert.deepEqual(effectiveInfrastructureLanes(signal({ laneIndices: [1, 2] }), r), [1, 2])
  assert.deepEqual(allowedInfrastructureLanes(r, 'backward'), [])
})

test('two-way traffic separates incoming and opposing lane groups', () => {
  const r = road('main', 0, 5, false)
  assert.deepEqual(allowedInfrastructureLanes(r, 'backward'), [0, 1])
  assert.deepEqual(allowedInfrastructureLanes(r, 'forward'), [2, 3, 4])
  assert.deepEqual(allowedInfrastructureLanes(r, 'both'), [0, 1, 2, 3, 4])
  assert.deepEqual(effectiveInfrastructureLanes(signal({ direction: 'backward', laneIndices: [1, 2] }), r), [1])
})

test('two selected lanes generate a 6.4-metre transverse stop line, not a 16-metre one', () => {
  const r = road('main')
  const line = stopLineLaneSegments(r, 0, point('center', 0, 0), [1, 2])
  assert.equal(line.length, 1)
  assert.ok(Math.abs(Math.abs((line[0]![0]!.lat - line[0]![1]!.lat) * 111_320) - 6.4) < 0.001)
  assert.ok(Math.abs(line[0]![0]!.lng - line[0]![1]!.lng) < 1e-8)
})

test('a visual sign stop line skips unselected lane gaps instead of painting the gap', () => {
  const r = road('main')
  const line = stopLineLaneSegments(r, 0, point('center', 0, 0), [0, 2, 4])
  assert.equal(line.length, 3)
  for (const pair of line) assert.ok(Math.abs(Math.abs((pair[0]!.lat - pair[1]!.lat) * 111_320) - 3.2) < 0.001)
  assert.equal(contiguousLanes([1, 2]), true)
  assert.equal(contiguousLanes([1, 3]), false)
})

test('icon follows selected lane centre; backwards-lane icon switches to opposite side', () => {
  const r = road('main', 0, 4, false)
  const forward = infrastructureIconLocation(signal({ roadOsmId: r.osmId, laneIndices: [3] }), [r])!
  const backward = infrastructureIconLocation(signal({ roadOsmId: r.osmId, laneIndices: [0], direction: 'backward' }), [r])!
  assert.ok(forward.lat < 0)
  assert.ok(backward.lat > 0)
  assert.ok(Math.abs(forward.lat + backward.lat) < 0.00000001)
})

test('OSM round-trip metadata is preserved by feature tag updates', () => {
  const tags = featureTags('traffic_signal', 'backward', { 'road_editor:road': '123', 'road_editor:lanes': '2,3', 'source:survey': 'yes' })
  assert.equal(tags['road_editor:road'], '123')
  assert.equal(tags['road_editor:lanes'], '2,3')
  assert.equal(tags['traffic_signals:direction'], 'backward')
  assert.equal(tags['source:survey'], 'yes')
})

test('new stop line is physically placed only on selected lane bands', () => {
  const r = road('main')
  const f = signal({ kind: 'stop_line', element: 'way',
    vertices: [point('line-start', 0, 6), point('line-end', 0, -6)],
    laneIndices: [1, 2], roadOsmId: r.osmId, tags: { road_marking: 'stop_line' } })
  const lines = infrastructureMarkings([f], [r], null)
  assert.equal(lines.length, 1)
  assert.equal(lines[0]!.infraId, f.id)
  assert.ok(Math.abs(Math.abs((lines[0]!.coordinates[0]![1] - lines[0]!.coordinates[1]![1]) * 111_320) - 6.4) < 0.001)
})

test('automatic sign stop-line previews respect selected lanes and hide when switched off', () => {
  const r = road('main')
  const f = signal({ laneIndices: [1, 2], roadOsmId: r.osmId })
  const lines = infrastructureMarkings([f], [r], f.id)
  assert.equal(lines.length, 1)
  assert.equal(lines[0]!.selected, true)
  assert.ok(lines[0]!.coordinates[0]![0] < f.vertices[0]!.lng)
  assert.equal(infrastructureMarkings([{ ...f, tags: { ...f.tags, 'road_editor:stop_line': 'no' } }], [r], f.id).length, 0)
})

test('user-selected road identity resolves nearby overlapping roads', () => {
  const a = road('street-a')
  const b = road('street-b', 3)
  const f = signal({ roadOsmId: 'street-b' })
  assert.equal(infrastructureRoadPlacement(f, [a, b])?.road.id, 'street-b')
  assert.equal(nearbyInfrastructureRoads(f, [a, b]).length, 2)
})

test('original imported stop line without editor lane metadata retains exact geometry', () => {
  const r = road('main')
  const f = signal({ kind: 'stop_line', element: 'way',
    vertices: [point('from', -1, 12), point('to', -1, -12)], direction: 'both',
    tags: { road_marking: 'stop_line' } })
  const geometry = infrastructureMarkings([f], [r], null)
  assert.deepEqual(geometry[0]?.coordinates, f.vertices.map(v => [v.lng, v.lat]))
})
