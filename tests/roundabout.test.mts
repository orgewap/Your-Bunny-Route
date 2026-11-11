import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planRoundabout, MIN_ROUNDABOUT_RADIUS, previewCircle } from '../src/lib/roundabout.ts'
import type { RoadFeature, RoadVertex } from '../src/types/road.ts'

function v(id: string, x: number, y: number): RoadVertex { return { id, lng: x / 111_320, lat: y / 111_320 } }
function road(id: string, points: Array<[number, number]>, level = 0): RoadFeature {
  return { id, osmId: String(100 + id.charCodeAt(0)), name: id, highway: 'residential', bridge: level > 0,
    lanes: 2, oneway: false, level, tags: {}, vertices: points.map(([x, y], i) => v(`${id}-${i}`, x, y)) }
}
const origin = v('center', 0, 0)

test('roundabout at four-way crossing creates four graph-shared arms', () => {
  const source = [road('a', [[-90, 0], [90, 0]]), road('b', [[0, -90], [0, 90]])]
  const unchanged = JSON.stringify(source)
  const plan = planRoundabout(origin, 20, source)
  const circle = plan.result.at(-1)!
  assert.equal(circle.tags.junction, 'roundabout')
  assert.equal(circle.oneway, true)
  assert.equal(circle.lanes, 1)
  assert.equal(circle.vertices[0]!.id, circle.vertices.at(-1)!.id)
  assert.equal(plan.connectionCount, 4)
  assert.equal(plan.affectedRoadIds.length, 2)
  assert.equal(plan.result.length, 5, 'four road approaches + closed ring')
  for (const attached of plan.attachmentVertices) {
    assert.ok(circle.vertices.some(point => point.id === attached.id), 'ring contains exact shared node')
    assert.ok(plan.result.slice(0, -1).some(part => part.vertices.some(point => point.id === attached.id)), 'road attaches to ring')
  }
  assert.equal(JSON.stringify(source), unchanged, 'preview must not mutate imported OSM')
})

test('a T-junction yields three attachments and clips the inner stub', () => {
  const source = [road('a', [[-90, 0], [90, 0]]), road('b', [[0, -90], [0, 0]])]
  const plan = planRoundabout(origin, 17, source)
  assert.equal(plan.connectionCount, 3)
  assert.equal(plan.result.length, 4)
  assert.equal(plan.removedRoadIds.length, 0)
})

test('surface OSM roads only: an elevated bridge crossing stays unchanged', () => {
  const bridge = road('a', [[-60, 0], [60, 0]], 1)
  const plan = planRoundabout(origin, 18, [bridge])
  assert.equal(plan.connectionCount, 0)
  assert.equal(plan.result[0], bridge)
  assert.equal(plan.result.length, 2)
})

test('standalone roundabout remains closed and has no attachments', () => {
  const plan = planRoundabout(origin, 12, [])
  assert.equal(plan.connectionCount, 0)
  assert.equal(plan.result.length, 1)
  assert.ok(plan.ring.length > 32)
  assert.equal(plan.ring[0]!.id, plan.ring.at(-1)!.id)
})

test('short interior OSM way removed without dangling ring link', () => {
  const source = [road('a', [[-3, 0], [3, 0]])]
  const plan = planRoundabout(origin, 20, source)
  assert.equal(plan.result.length, 1)
  assert.deepEqual(plan.removedRoadIds, ['a'])
})

test('closed roundabout cannot overwrite existing one', () => {
  const existing = road('a', [[-60, 0], [0, 0], [60, 0]])
  existing.tags.junction = 'roundabout'
  assert.throws(() => planRoundabout(origin, 18, [existing]), /уже существует/)
})

test('radius outside configured range is rejected', () => {
  assert.throws(() => planRoundabout(origin, MIN_ROUNDABOUT_RADIUS - 1, []), /Радиус/)
  assert.throws(() => planRoundabout(origin, 81, []), /Радиус/)
})

test('negative way IDs never overlap reserved source way IDs', () => {
  const source = [road('a', [[-90, 0], [90, 0]])]
  const plan = planRoundabout(origin, 20, source, ['-1', '-30', '-31'])
  const negativeIds = plan.result.map(item => item.osmId).filter(id => Number(id) < 0)
  assert.equal(new Set(negativeIds).size, negativeIds.length)
  assert.ok(negativeIds.every(id => Number(id) < -31))
})

test('moving the radius cursor draws a valid closed circle', () => {
  const preview = previewCircle(origin, 23)
  assert.equal(preview.length, 73)
  assert.equal(preview[0]!.id, preview.at(-1)!.id)
})

