import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planRoad, materializeRoadPlan, snapToRoad } from '../src/lib/topology.ts'
import type { RoadFeature, RoadVertex } from '../src/types/road.ts'

const mk = (id: string, x: number, y: number): RoadVertex => ({ id, lng: x / 111320, lat: y / 111320 })
function line(id: string, start: RoadVertex, end: RoadVertex, level = 0): RoadFeature {
  return { id, osmId: id === 'a' ? '100' : '101', name: id, highway: 'primary', lanes: 2, oneway: false, bridge: level > 0, level, vertices: [start, end], tags: {} }
}

test('crossing at interior defaults to a bridge with 0/+1/0 ways; target is untouched', () => {
  const target = line('a', mk('n1', -100, 0), mk('n2', 100, 0))
  const plan = planRoad([mk('start', 0, -100), mk('finish', 0, 100)], [target], 2)
  assert.equal(plan.crossings.length, 1)
  assert.equal(plan.crossings[0]!.kind, 'bridge')
  const result = materializeRoadPlan(plan, [target])
  assert.deepEqual(result.roads.map(road => road.level), [0, 1, 0])
  assert.equal(result.modifiedExisting.size, 0)
  assert.equal(result.roads[1]!.bridge, true)
  assert.ok(!result.roads[1]!.vertices.some(vertex => target.vertices.some(existing => vertex.id === existing.id)))
})

test('changing crossing to junction yields one shared OSM graph node', () => {
  const target = line('a', mk('n1', -100, 0), mk('n2', 100, 0))
  const plan = planRoad([mk('s', 0, -100), mk('f', 0, 100)], [target], 2)
  plan.crossings[0]!.kind = 'junction'
  const result = materializeRoadPlan(plan, [target])
  assert.equal(result.roads.length, 1)
  assert.equal(result.roads[0]!.bridge, false)
  const edited = result.modifiedExisting.get('a')!
  assert.equal(edited.length, 3)
  assert.ok(result.roads[0]!.vertices.some(vertex => vertex.id === edited[1]!.id))
  assert.equal(target.vertices.length, 2, 'planning must not mutate source')
})

test('snaps a new road endpoint to the middle of an original OSM way', () => {
  const target = line('a', mk('n1', -100, 0), mk('n2', 100, 0))
  const snapped = snapToRoad(mk('snap-me', 2, 1), [target], 5)
  assert.ok(snapped.link)
  assert.ok(Math.abs(snapped.vertex.lat) < 0.00001)
  const plan = planRoad([mk('s', 0, -100), mk('f', 2, 1)], [target], 5)
  assert.equal(plan.endpoints.length, 1)
  const result = materializeRoadPlan(plan, [target])
  const edited = result.modifiedExisting.get('a')!
  assert.equal(edited.length, 3)
  assert.equal(result.roads[0]!.vertices.at(-1)!.id, edited[1]!.id)
})

test('bridge above an existing +1 road becomes +2, not a shared intersection', () => {
  const target = line('a', mk('n1', -100, 0), mk('n2', 100, 0), 1)
  const plan = planRoad([mk('s', 0, -100), mk('f', 0, 100)], [target], 2)
  const result = materializeRoadPlan(plan, [target])
  assert.deepEqual(result.roads.map(road => road.level), [0, 2, 0])
  assert.equal(result.modifiedExisting.size, 0)
})

test('multiple intersections are independent choices and can form joined bridge span', () => {
  const roads = [
    line('a', mk('a1', -100, -10), mk('a2', 100, -10)),
    line('b', mk('b1', -100, 10), mk('b2', 100, 10)),
  ]
  const plan = planRoad([mk('s', 0, -100), mk('f', 0, 100)], roads, 2)
  assert.equal(plan.crossings.length, 2)
  const result = materializeRoadPlan(plan, roads)
  assert.equal(result.bridgeCount, 1)
  assert.deepEqual(result.roads.map(r => r.level), [0, 1, 0])
})

test('junction on elevated road is rejected, not silently connected', () => {
  const road = line('a', mk('n1', -100, 0), mk('n2', 100, 0), 1)
  const plan = planRoad([mk('s', 0, -100), mk('f', 0, 100)], [road], 2)
  plan.crossings[0]!.kind = 'junction'
  assert.throws(() => materializeRoadPlan(plan, [road]), /наземный перекрёсток/)
})

test('reserved negative IDs from source XML cannot be reused for new OSM ways', () => {
  const target = line('a', mk('n1', -100, 0), mk('n2', 100, 0))
  const plan = planRoad([mk('s', 0, -100), mk('f', 0, 100)], [target], 2)
  const result = materializeRoadPlan(plan, [target], ['-1', '-2', '-30'])
  assert.deepEqual(result.roads.map(r => r.osmId), ['-31', '-32', '-33'])
})

test('new road connects two existing OSM ways using original endpoint IDs', () => {
  const roads = [
    line('a', mk('a1', -50, -100), mk('a2', 50, -100)),
    line('b', mk('b1', -50, 100), mk('b2', 50, 100)),
  ]
  const plan = planRoad([mk('s', 0, -99), mk('f', 0, 99)], roads, 4)
  const result = materializeRoadPlan(plan, roads)
  assert.equal(plan.endpoints.length, 2)
  assert.equal(result.roads.length, 1)
  for (const edited of result.modifiedExisting.values()) {
    assert.ok(edited.some(node => result.roads[0]!.vertices.some(v => v.id === node.id)))
  }
})
