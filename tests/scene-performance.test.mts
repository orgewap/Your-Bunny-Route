import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appendSceneInfrastructure } from '../src/lib/scene3d.ts'
import { createSceneRoadIndex, sceneSegmentHit } from '../src/lib/sceneIndex.ts'
import type { RoadFeature } from '../src/types/road.ts'
import type { InfrastructureFeature } from '../src/lib/infrastructure.ts'

function road(i: number, options: { sidewalk?: boolean; bridge?: boolean } = {}): RoadFeature {
  const lat = 52.28 + Math.floor(i / 80) * 0.00045
  const lng = 104.28 + (i % 80) * 0.00045
  return {
    id: `r${i}`, osmId: String(i), name: '', highway: 'residential', lanes: 2,
    oneway: false, bridge: !!options.bridge, level: options.bridge ? 1 : 0,
    tags: options.sidewalk ? { sidewalk: 'both' } : {},
    vertices: [{ id: `a${i}`, lng, lat }, { id: `b${i}`, lng: lng + 0.0003, lat }],
  }
}

test('metre grid searches local road geometry without scanning the whole imported map', () => {
  const roads = Array.from({ length: 2400 }, (_, i) => road(i))
  const index = createSceneRoadIndex(roads)
  const point = roads[822]!.vertices[0]!
  const candidates = index.nearby(point.lng, point.lat)
  assert.ok(index.segmentCount === 2400)
  assert.ok(candidates.some(segment => segment.road.id === roads[822]!.id))
  assert.ok(candidates.length < 60, `Expected local search, got ${candidates.length} candidates`)
  const p = index.project(point.lng, point.lat)
  assert.ok(candidates.some(segment => sceneSegmentHit(segment, p.x, p.y).distance < 0.01))
})

test('3D infrastructure uses deterministic LOD: roads-only at city zoom; props at street zoom', () => {
  const streets = Array.from({ length: 600 }, (_, i) => road(i, { sidewalk: true, bridge: i % 16 === 0 }))
  const signals: InfrastructureFeature[] = Array.from({ length: 35 }, (_, i) => ({
    id: `signal${i}`, osmId: `-${i + 1}`, element: 'node', kind: 'traffic_signal',
    direction: 'forward', tags: {}, vertices: [streets[i * 3]!.vertices[0]!],
  }))
  const count = (detail: 0 | 1 | 2) => {
    let emitted = 0
    appendSceneInfrastructure(() => { emitted++ }, streets, signals, [], [], [], detail)
    return emitted
  }
  const overview = count(0), intermediate = count(1), closeup = count(2)
  assert.equal(overview, 0)
  assert.ok(intermediate > 0)
  assert.ok(closeup > intermediate, `Expected ${closeup} > ${intermediate}`)
  assert.ok(closeup <= 65_000, `3D geometry budget exceeded: ${closeup}`)
})

test('nearby supports still avoid pillars above another ground road', () => {
  const bridge = road(1000, { bridge: true })
  bridge.tags['road_editor:support_spacing'] = '8'
  const street = road(1000)
  const withCrossing: RoadFeature = { ...street, id: 'crossing-under',
    vertices: [{id:'u1',lng:street.vertices[0]!.lng+0.00015,lat:street.vertices[0]!.lat-0.0002},
      {id:'u2',lng:street.vertices[0]!.lng+0.00015,lat:street.vertices[0]!.lat+0.0002}], }
  let alone = 0, blocked = 0
  appendSceneInfrastructure(() => alone++, [bridge], [], [], [], [], 2)
  appendSceneInfrastructure(() => blocked++, [bridge, withCrossing], [], [], [], [], 2)
  assert.ok(alone > blocked, 'Pier at ground-road crossing must be suppressed')
})
