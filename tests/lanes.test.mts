import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  clampRoadLanes, importedLaneCount, laneDirections, laneJunctionFeatures, laneVisualFeatures,
} from '../src/lib/lanes.ts'
import type { RoadFeature, RoadVertex } from '../src/types/road.ts'

const v = (id: string, lng: number, lat: number): RoadVertex => ({ id, lng, lat })
const road = (id: string, count: number, vertices: RoadVertex[], oneway = false, tags: Record<string, string> = {}): RoadFeature => ({
  id, osmId: id, name: id, highway: 'residential', lanes: count, oneway, tags,
  bridge: false, level: 0, vertices,
})

test('limits lanes from 1 to 10, preserving imported OSM counts', () => {
  assert.equal(clampRoadLanes(0), 1)
  assert.equal(clampRoadLanes(3.7), 3)
  assert.equal(clampRoadLanes(12), 10)
  assert.equal(importedLaneCount({ lanes: '1' }), 1)
  assert.equal(importedLaneCount({ lanes: '2' }), 2)
  assert.equal(importedLaneCount({ lanes: '4' }), 4)
  assert.equal(importedLaneCount({ lanes: '10' }), 10)
  assert.equal(importedLaneCount({ lanes: '12' }), 10)
  assert.equal(importedLaneCount({ 'lanes:forward': '2', 'lanes:backward': '3' }), 5)
  assert.equal(importedLaneCount({}), 2)
})

test('bidirectional lane layout is balanced, one-way remains one-way', () => {
  assert.deepEqual(laneDirections(road('two', 2, [])), { forward: 1, backward: 1 })
  assert.deepEqual(laneDirections(road('four', 4, [])), { forward: 2, backward: 2 })
  assert.deepEqual(laneDirections(road('ten', 10, [])), { forward: 5, backward: 5 })
  assert.deepEqual(laneDirections(road('three', 3, [])), { forward: 2, backward: 1 })
  assert.deepEqual(laneDirections(road('oneway', 5, [], true)), { forward: 5, backward: 0 })
  assert.deepEqual(laneDirections(road('reverse', 3, [], true, { oneway: '-1' })), { forward: 0, backward: 3 })
  assert.deepEqual(laneDirections(road('custom', 4, [], false, { 'lanes:forward': '3', 'lanes:backward': '1' })), { forward: 3, backward: 1 })
})

test('every lane is a separate 2D stripe around ONE shared centreline', () => {
  const a = v('a', 1, 1), b = v('b', 2, 2)
  for (const count of [1, 2, 3, 4, 5, 10]) {
    const features = laneVisualFeatures([road('r', count, [a, b])], 'r')
    assert.equal(features.length, count)
    assert.equal(features[0]!.properties.laneOffset, 0 - (count - 1) / 2)
    assert.equal(features.at(-1)!.properties.laneOffset, (count - 1) / 2)
    assert.ok(features.every(feature => feature.properties.selected))
    assert.deepEqual(features.map(feature => feature.properties.laneOffset),
      Array.from({ length: count }, (_, i) => i - (count - 1) / 2))
    assert.ok(features.every(feature => feature.geometry.coordinates.length === 2))
  }
})

test('junctions require a common OSM node ID, not just crossing geometry', () => {
  const shared = v('osm-node-7', 4, 4)
  const r1 = road('a', 4, [v('a', 3, 4), shared])
  const r2 = road('b', 2, [shared, v('b', 5, 4)])
  assert.equal(laneJunctionFeatures([r1, r2]).length, 1)
  assert.equal(laneJunctionFeatures([r1, r2])[0]!.properties.lanes, 4)
  // Exactly matching coordinates but different IDs are not graph-connected.
  const r3 = road('c', 2, [v('unrelated', 4, 4), v('c', 4, 6)])
  assert.equal(laneJunctionFeatures([r1, r3]).length, 0)
  assert.equal(laneJunctionFeatures([r1, r2, r3]).length, 1)
})
