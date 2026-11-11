import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RoadFeature, RoadVertex } from '../src/types/road.ts'
import { findRoadPlacement, stopLineVertices, featureTags, newOsmId } from '../src/lib/infrastructure.ts'

const vertex = (id: string, x: number, y: number): RoadVertex => ({ id, lng: x / 111_320, lat: y / 111_320 })
const road = (id: string, points: RoadVertex[], lanes = 2, level = 0): RoadFeature => ({
  id, osmId: id, name: '', highway: 'residential', lanes, oneway: false,
  bridge: level > 0, level, vertices: points, tags: {},
})

test('snap infrastructure to centerline of road within 10 meters', () => {
  const ground = road('ground', [vertex('a', -50, 0), vertex('b', 50, 0)], 4)
  const at = vertex('cursor', 0, 3)
  const hit = findRoadPlacement(at, [ground], 10)
  assert.ok(hit)
  assert.equal(hit.roadId, 'ground')
  assert.equal(hit.segmentIndex, 0)
  assert.ok(Math.abs(hit.t - 0.5) < 0.001)
  assert.ok(hit.distance > 2.9 && hit.distance < 3.1)
  assert.equal(findRoadPlacement(vertex('no', 0, 17), [ground], 10), null)
})

test('snap never selects a bridge or elevated road instead of ground', () => {
  const ground = road('ground', [vertex('ga', -50, 0), vertex('gb', 50, 0)])
  const bridge = road('bridge', [vertex('ba', -50, 1), vertex('bb', 50, 1)], 2, 1)
  assert.equal(findRoadPlacement(vertex('at', 0, 1), [bridge], 10), null)
  assert.equal(findRoadPlacement(vertex('at', 0, 1), [bridge, ground], 10)?.roadId, 'ground')
})

test('stop line crosses full carriageway at right angle without changing the road', () => {
  const main = road('main', [vertex('a', -50, 0), vertex('b', 50, 0)], 4)
  const before = JSON.stringify(main)
  let serial = 0
  const line = stopLineVertices(main, 0, vertex('point', 0, 0), () => `id${++serial}`)
  assert.equal(line.length, 2)
  assert.ok(Math.abs(line[0]!.lat - line[1]!.lat) * 111_320 > 12.7)
  assert.ok(Math.abs(line[0]!.lng - line[1]!.lng) * 111_320 < 0.1)
  assert.equal(JSON.stringify(main), before)
})

test('node tags have OSM-standard names and directions', () => {
  assert.deepEqual(featureTags('traffic_signal', 'forward'), { highway: 'traffic_signals', 'traffic_signals:direction': 'forward' })
  assert.deepEqual(featureTags('stop', 'backward'), { highway: 'stop', direction: 'backward' })
  assert.deepEqual(featureTags('give_way', 'both'), { highway: 'give_way' })
  assert.deepEqual(featureTags('crossing', 'both'), { highway: 'crossing', 'crossing:markings': 'zebra' })
  assert.deepEqual(featureTags('stop_line', 'forward'), { road_marking: 'stop_line', stroke: 'solid', direction: 'forward' })
})

test('changing direction preserves unrelated tags and removes stale directions', () => {
  const before = { highway: 'stop', direction: 'backward', 'source:survey': '2026' }
  const after = featureTags('traffic_signal', 'both', before)
  assert.equal(after.highway, 'traffic_signals')
  assert.equal(after['source:survey'], '2026')
  assert.equal(after.direction, undefined)
  assert.equal(after['traffic_signals:direction'], undefined)
  assert.deepEqual(before, { highway: 'stop', direction: 'backward', 'source:survey': '2026' })
})

test('new OSM ID is a negative integer, never conflicts with existing set', () => {
  const a = newOsmId(new Set(['-1', '-2']))
  assert.ok(Number.isSafeInteger(Number(a)) && Number(a) < 0)
  const b = newOsmId(new Set(['-1', '-2', a]))
  assert.notEqual(a, b)
})

test('manual placement on a wide ten-lane carriageway accepts the outer lanes', () => {
  const wide = road('wide', [vertex('a', -80, 0), vertex('b', 80, 0)], 10)
  // 17m from the centreline is inside the physical width of a ten-lane road.
  const atOuterLane = vertex('outer-lane', 0, 17)
  assert.equal(findRoadPlacement(atOuterLane, [wide], 12), null)
  const hit = findRoadPlacement(atOuterLane, [wide], 12, { roadWidthAware: true })
  assert.ok(hit)
  assert.equal(hit.roadId, 'wide')
  assert.ok(hit.distance > 16.9 && hit.distance < 17.1)
})

test('manual placement keeps the exact rendered road at overlapping parallel roads', () => {
  const near = road('near', [vertex('n1', -80, 0), vertex('n2', 80, 0)], 4)
  const clicked = road('clicked', [vertex('c1', -80, 5), vertex('c2', 80, 5)], 4)
  const at = vertex('cursor', 0, 4.5)
  const hit = findRoadPlacement(at, [near, clicked], 12, {
    preferredRoadId: 'near', roadWidthAware: true,
  })
  assert.equal(hit?.roadId, 'near')
})

test('screen-resolved placement may target a bridge but ordinary placement cannot', () => {
  const bridge = road('bridge', [vertex('b1', -80, 0), vertex('b2', 80, 0)], 4, 1)
  const at = vertex('cursor', 0, 0)
  assert.equal(findRoadPlacement(at, [bridge], 12, { preferredRoadId: 'bridge' }), null)
  assert.equal(findRoadPlacement(at, [bridge], 12, {
    preferredRoadId: 'bridge', allowElevated: true, roadWidthAware: true,
  })?.roadId, 'bridge')
})
