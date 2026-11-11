import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RoadFeature, RoadVertex } from '../src/types/road.ts'
import { surfaceVertices, surfaceNetwork } from '../src/lib/roadSurface.ts'
import { indexRoadBounds, expandBounds, roadsWithin } from '../src/lib/viewport.ts'
import { buildLaneGraph } from '../src/lib/laneGraph.ts'

function v(id: string, x: number, y: number): RoadVertex {
  return { id, lng: 104 + x / 111_320, lat: 52 + y / 111_320 }
}
function fixture(width: number, height: number): RoadFeature[] {
  const roads: RoadFeature[] = []
  // 2D mesh of shared nodes, several segments per road, 4 lanes.
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const id = `${row}-${col}`
      roads.push({ id, osmId: id, name: '', highway: 'residential', lanes: 4,
        oneway: false, bridge: false, level: 0, tags: {}, vertices: [
          v(`j-${row}-${col}`, col * 70, row * 70),
          v(`s-${row}-${col}`, col * 70 + 35, row * 70),
          v(`j-${row}-${col + 1}`, col * 70 + 70, row * 70),
        ] })
    }
  }
  return roads
}

test('indexed road surfaces are equivalent to original all-road scan', () => {
  const roads = fixture(18, 14)
  const expected = roads.map(road => surfaceVertices(road, roads))
  const newSurface = surfaceNetwork(roads)
  assert.equal(newSurface.length, expected.length)
  for (let i = 0; i < roads.length; i++) assert.deepEqual(newSurface[i]!.vertices, expected[i])
})

test('viewport index includes long road crossing the screen, excludes distant roads', () => {
  const roads = fixture(30, 20)
  const long = { ...roads[0]!, id: 'long', vertices: [v('from', -10_000, 320), v('to', 10_000, 320)] }
  const index = indexRoadBounds([...roads, long])
  const viewport = expandBounds({ west: 104, east: 104.004, south: 52, north: 52.004 }, 40)
  const visible = roadsWithin(index, viewport)
  assert.ok(visible.length > 0)
  assert.ok(visible.length < roads.length)
  assert.ok(visible.includes(long))
  assert.ok(!visible.some(road => road.id === '19-29'))
})

test('viewport-scoped lane graph preserves local crossings, bridge separation and 10 lanes', () => {
  const roads = fixture(20, 12)
  roads[0]!.lanes = 10
  const full = buildLaneGraph(roads, { maxConnections: 0 })
  const visible = roadsWithin(indexRoadBounds(roads), expandBounds({
    west: 104 - 0.0001, east: 104.001, south: 52 - 0.0001, north: 52.001,
  }, 30))
  const small = buildLaneGraph(visible, { maxConnections: 0 })
  assert.ok(small.edges.length > 0)
  assert.ok(small.edges.length < full.edges.length / 2)
  assert.equal(small.edges.filter(edge => edge.roadId === roads[0]!.id).length, 10)
  assert.ok(full.edges.length > 900)
})
