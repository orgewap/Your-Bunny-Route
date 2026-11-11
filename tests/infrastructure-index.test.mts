import test from 'node:test'
import assert from 'node:assert/strict'
import type { RoadFeature, RoadVertex } from '../src/types/road.ts'
import {
  createInfrastructurePlacementIndex, infrastructureRoadPlacement,
} from '../src/lib/infrastructure.ts'

const v = (id: string, x: number, y: number): RoadVertex => ({
  id, lng: 104 + x / 111_320, lat: 52 + y / 111_320,
})
const road = (i: number): RoadFeature => ({
  id: `road-${i}`, osmId: String(i), name: '', highway: 'residential',
  lanes: 2, oneway: false, bridge: false, level: 0, tags: {},
  vertices: [v(`a-${i}`, i * 80, 0), v(`b-${i}`, i * 80 + 60, 0)],
})
const feature = (id: string, point: RoadVertex, roadOsmId?: string) => ({
  id, osmId: id, element: 'node' as const, kind: 'traffic_signal' as const,
  vertices: [point], direction: 'forward' as const, tags: {},
  ...(roadOsmId ? { roadOsmId } : {}),
})

test('indexed infrastructure lookup matches the original full scan on the owning OSM way', () => {
  const roads = Array.from({ length: 2400 }, (_, i) => road(i))
  const target = roads[1720]!
  const control = feature('signal-1', v('signal-node', 1720 * 80 + 20, 2), target.osmId)
  const index = createInfrastructurePlacementIndex(roads)
  const linear = infrastructureRoadPlacement(control, roads)
  const indexed = infrastructureRoadPlacement(control, roads, index)
  assert.equal(indexed?.road.id, linear?.road.id)
  assert.equal(indexed?.hit.segmentIndex, linear?.hit.segmentIndex)
  assert.ok(Math.abs((indexed?.hit.t ?? 0) - (linear?.hit.t ?? 0)) < 1e-9)
})

test('unlinked imported controls use a local spatial bucket instead of scanning every OSM way', () => {
  const roads = Array.from({ length: 2400 }, (_, i) => road(i))
  const control = feature('signal-2', v('unlinked-node', 1900 * 80 + 30, 4))
  const index = createInfrastructurePlacementIndex(roads)
  const indexed = infrastructureRoadPlacement(control, roads, index)
  assert.equal(indexed?.road.id, 'road-1900')
  assert.ok((indexed?.hit.distance ?? Infinity) < 5)
  assert.equal(index.roadsById.get('road-1900')?.osmId, '1900')
})
