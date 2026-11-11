import assert from 'node:assert/strict'
import { test } from 'node:test'
import { materializeRoadPlan, planRoad, snapToRoad } from '../src/lib/topology.ts'
import type { RoadFeature, RoadVertex } from '../src/types/road.ts'

const point = (id: string, x: number, y = 0): RoadVertex => ({ id, lng: x / 111_320, lat: y / 111_320 })
function way(id: string, start: RoadVertex, finish: RoadVertex, level = 0): RoadFeature {
  return { id, osmId: id === 'upper' ? '200' : '100', name: id, highway: 'residential', lanes: 2,
    oneway: false, bridge: level > 0, level, vertices: [start, finish], tags: {} }
}

test('ordinary OSM ground way snaps to an existing segment interior', () => {
  const ground = way('ground', point('a', -80), point('b', 80))
  const snap = snapToRoad(point('new', 2, 1.5), [ground], 5)
  assert.equal(snap.link?.roadId, ground.id)
  assert.ok(Math.abs(snap.vertex.lat) < 1e-8)
  const plan = planRoad([point('start', 2, -60), point('end', 2, 1.5)], [ground], 5)
  const result = materializeRoadPlan(plan, [ground])
  const inserted = result.modifiedExisting.get('ground')!
  assert.equal(inserted.length, 3)
  assert.equal(result.roads[0]!.vertices.at(-1)!.id, inserted[1]!.id)
})

test('new road attaches to a +1 bridge node; level filter must not suppress bridges', () => {
  const upper = way('upper', point('b0', -100), point('b1', 100), 1)
  const snap = snapToRoad(point('new', 100, 0.4), [upper], 5)
  assert.equal(snap.link?.roadId, 'upper')
  assert.equal(snap.vertex.id, 'b1')
  const plan = planRoad([point('new-start', 100, 0.4), point('end', 130, 40)], [upper], 5)
  const result = materializeRoadPlan(plan, [upper])
  assert.equal(result.roads[0]!.vertices[0]!.id, 'b1')
})

test('two +1 bridge ends connect through a new +1 way with shared nodes', () => {
  const left = way('upper', point('l0', -100), point('l1', -20), 1)
  const right = way('upper2', point('r0', 20), point('r1', 100), 1)
  const plan = planRoad([point('s', -19.9), point('e', 20.1)], [left, right], 3, 1)
  const result = materializeRoadPlan(plan, [left, right])
  assert.equal(result.roads.length, 1)
  assert.equal(result.roads[0]!.bridge, true)
  assert.equal(result.roads[0]!.level, 1)
  assert.equal(result.roads[0]!.vertices[0]!.id, 'l1')
  assert.equal(result.roads[0]!.vertices.at(-1)!.id, 'r0')
})

test('overlapping ground and bridge prefer the selected road level', () => {
  const lower = way('ground', point('g0', -100), point('g1', 100))
  const upper = way('upper', point('u0', -100), point('u1', 100), 1)
  const clicked = point('click', 5, 0.15)
  assert.equal(snapToRoad(clicked, [upper, lower], 4, null, 0).link?.roadId, 'ground')
  assert.equal(snapToRoad(clicked, [lower, upper], 4, null, 1).link?.roadId, 'upper')
})

test('a nearby ground road is chosen if the elevated bridge is outside tolerance', () => {
  const ground = way('ground', point('g0', -100), point('g1', 100))
  const upper = way('upper', point('u0', -100, 12), point('u1', 100, 12), 1)
  assert.equal(snapToRoad(point('click', 0, 1), [upper, ground], 3, null, 1).link?.roadId, 'ground')
})
