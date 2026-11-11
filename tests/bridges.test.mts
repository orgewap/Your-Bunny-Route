import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bridgeNodeHeights, roadHeightAt, sampleElevatedRoad, splitGroundRoadForBridge } from '../src/lib/bridges.ts'
import { materializeRoadPlan, planRoad } from '../src/lib/topology.ts'
import { roadLengthMeters } from '../src/lib/geometry.ts'
import type { RoadFeature, RoadVertex } from '../src/types/road.ts'

const at = (id: string, x: number, y = 0): RoadVertex => ({ id, lng: x / 111320, lat: y / 111320 })
const road = (id: string, a: RoadVertex, b: RoadVertex, level = 0): RoadFeature => ({
  id, osmId: id === 'ground' ? '100' : '-2', name: 'Тестовая', highway: 'primary',
  lanes: 2, oneway: false, bridge: level > 0, level, vertices: [a, b], tags: {},
})

test('bridge editor splits the ground OSM way into three ways with shared boundary nodes', () => {
  const original = road('ground', at('west', 0), at('east', 150))
  const result = splitGroundRoadForBridge(original, 40, 100, ['100', '-2'])
  const [approach, bridge, exit] = result.roadParts
  assert.deepEqual(result.roadParts.map(item => item.level), [0, 1, 0])
  assert.equal(approach.osmId, '100')
  assert.equal(bridge.osmId, '-3')
  assert.equal(exit.osmId, '-4')
  assert.equal(approach.vertices.at(-1)!.id, bridge.vertices[0]!.id)
  assert.equal(bridge.vertices.at(-1)!.id, exit.vertices[0]!.id)
  assert.ok(Math.abs(roadLengthMeters(bridge.vertices) - 60) < 0.1)
  assert.equal(original.vertices.length, 2, 'original array must be left unchanged')
})

test('approach rises smoothly from 0 to 5 m, bridge is flat and exit descends', () => {
  const split = splitGroundRoadForBridge(road('ground', at('a', 0), at('b', 150)), 40, 100, ['100'])
  const [before, bridge, after] = split.roadParts
  const heights = bridgeNodeHeights(split.roadParts)
  const beforeLength = roadLengthMeters(before.vertices)
  const afterLength = roadLengthMeters(after.vertices)
  assert.equal(roadHeightAt(before, 0, heights), 0)
  assert.ok(Math.abs(roadHeightAt(before, beforeLength, heights) - 5) < 1e-5)
  assert.equal(roadHeightAt(bridge, 1, heights), 5)
  assert.ok(Math.abs(roadHeightAt(after, 0, heights) - 5) < 1e-5)
  assert.equal(roadHeightAt(after, afterLength, heights), 0)
  const ascending = sampleElevatedRoad(before, heights, 0.5)
  const descending = sampleElevatedRoad(after, heights, 0.5)
  for (let i = 1; i < ascending.length; i++) assert.ok(ascending[i]!.height + 1e-6 >= ascending[i - 1]!.height)
  for (let i = 1; i < descending.length; i++) assert.ok(descending[i]!.height - 1e-6 <= descending[i - 1]!.height)
  assert.ok(ascending.length > 50, 'continuous triangle ribbon has sufficient samples')
})

test('short approaches still reach 0 and meet the bridge at full height', () => {
  const parts = splitGroundRoadForBridge(road('ground', at('a', 0), at('b', 30)), 6, 24, ['100']).roadParts
  const heights = bridgeNodeHeights(parts)
  const [before, elevated, after] = parts
  assert.equal(roadHeightAt(before, 0, heights), 0)
  assert.equal(roadHeightAt(before, roadLengthMeters(before.vertices), heights), 5)
  assert.equal(roadHeightAt(elevated, 5, heights), 5)
  assert.equal(roadHeightAt(after, roadLengthMeters(after.vertices), heights), 0)
})

test('an auto bridge has a ground approach sharing its first OSM node', () => {
  const target = road('ground', at('left', -60), at('right', 60))
  const plan = planRoad([at('south', 0, -80), at('north', 0, 80)], [target], 1)
  const materialized = materializeRoadPlan(plan, [target])
  assert.deepEqual(materialized.roads.map(r => r.level), [0, 1, 0])
  const [before, bridge, after] = materialized.roads
  const heights = bridgeNodeHeights(materialized.roads)
  assert.equal(before.vertices.at(-1)!.id, bridge.vertices[0]!.id)
  assert.equal(bridge.vertices.at(-1)!.id, after.vertices[0]!.id)
  assert.equal(roadHeightAt(before, roadLengthMeters(before.vertices), heights), 5)
  assert.equal(roadHeightAt(bridge, 0, heights), 5)
  assert.equal(roadHeightAt(after, 0, heights), 5)
})

test('user can change exact bridge bounds around a crossing', () => {
  const target = road('ground', at('w', -100), at('e', 100))
  const plan = planRoad([at('s', 0, -100), at('n', 0, 100)], [target], 1)
  plan.crossings[0]!.bridgeFrom = 52
  plan.crossings[0]!.bridgeTo = 142
  const parts = materializeRoadPlan(plan, [target]).roads
  assert.ok(Math.abs(roadLengthMeters(parts[1]!.vertices) - 90) < 0.1)
  assert.throws(() => {
    plan.crossings[0]!.bridgeFrom = 102
    materializeRoadPlan(plan, [target])
  }, /начало и конец/)
})

test('cannot split an existing bridge, a roundabout or create zero-length approaches', () => {
  const sample = road('ground', at('w', 0), at('e', 100))
  assert.throws(() => splitGroundRoadForBridge(sample, 0, 50, ['100']), /Начало и конец/)
  assert.throws(() => splitGroundRoadForBridge(sample, 30, 33, ['100']), /Начало и конец/)
  assert.throws(() => splitGroundRoadForBridge({ ...sample, tags: { junction: 'roundabout' } }, 30, 70, ['100']), /наземный/)
})

test('two bridges sharing a node are the same elevation without a collapse', () => {
  const first = road('one', at('a', 0), at('middle', 50), 1)
  const second = road('two', at('middle', 50), at('b', 100), 1)
  const heights = bridgeNodeHeights([first, second])
  assert.equal(roadHeightAt(first, roadLengthMeters(first.vertices), heights), 5)
  assert.equal(roadHeightAt(second, 0, heights), 5)
})

test('existing ground intersections inside an elevated bridge are unlinked by node ID', () => {
  const original = road('ground', at('begin', 0), at('end', 120))
  original.vertices.splice(1, 0, at('shared-crossing', 60))
  const result = splitGroundRoadForBridge(original, 35, 85, ['100'], new Set(['shared-crossing']))
  const elevated = result.roadParts[1]
  const middle = elevated.vertices.find(v => Math.abs(v.lng * 111320 - 60) < 0.01)!
  assert.notEqual(middle.id, 'shared-crossing', 'crossing under bridge cannot share an OSM node')
  assert.equal(original.vertices[1]!.id, 'shared-crossing', 'ground road still uses original node')
  assert.equal(result.roadParts[0].vertices.at(-1)!.id, elevated.vertices[0]!.id)
  assert.equal(elevated.vertices.at(-1)!.id, result.roadParts[2].vertices[0]!.id)
})
