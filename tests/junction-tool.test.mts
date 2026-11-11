import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planJunction } from '../src/lib/junction.ts'
import type { RoadFeature, RoadVertex } from '../src/types/road.ts'

const origin = { lng: 104.3, lat: 52.28 }
const point = (id: string, east: number, north: number): RoadVertex => ({
  id, lng: origin.lng + east / (111_320 * Math.cos(origin.lat * Math.PI / 180)),
  lat: origin.lat + north / 111_320,
})
const make = (id: string, vertices: RoadVertex[], level = 0, tags: Record<string,string> = {}): RoadFeature => ({
  id, osmId: id, vertices, name: id, highway: 'residential', lanes: 2,
  oneway: false, bridge: level > 0, level, tags,
})
const center = () => point('clicked', 0, 0)
const horizontal = () => make('horizontal', [point('west', -40, 0), point('east', 40, 0)])
const vertical = () => make('vertical', [point('south', 0, -40), point('north', 0, 40)])

test('X crossing creates 4 arms with exactly one shared OSM node and preserves way IDs', () => {
  const roads = [horizontal(), vertical()]
  const before = JSON.stringify(roads)
  const plan = planJunction(center(), roads)
  assert.equal(plan.armCount, 4)
  assert.equal(plan.roadIds.length, 2)
  assert.equal(plan.roads.length, 2)
  assert.equal(plan.roads[0]!.vertices.length, 3)
  assert.equal(plan.roads[1]!.vertices.length, 3)
  assert.equal(plan.roads[0]!.vertices[1]!.id, plan.roads[1]!.vertices[1]!.id)
  assert.equal(JSON.stringify(roads), before, 'preview must not mutate the OSM network')
})

test('T crossing snaps terminal OSM node to an interior node of another way', () => {
  const horizontalRoad = horizontal()
  const spur = make('spur', [point('bottom', 0, -50), point('end', 0.7, -0.6)])
  const plan = planJunction(center(), [horizontalRoad, spur])
  assert.equal(plan.armCount, 3)
  const target = plan.roads.find(r => r.roadId === 'horizontal')!
  const branch = plan.roads.find(r => r.roadId === 'spur')!
  assert.equal(target.vertices.length, 3)
  assert.equal(branch.vertices.length, 2)
  assert.equal(target.vertices[1]!.id, branch.vertices.at(-1)!.id)
  assert.ok(Math.abs(branch.vertices.at(-1)!.lat - target.vertices[1]!.lat) < 1e-10)
})

test('a crossing that already shares the same OSM node cannot duplicate it', () => {
  const shared = point('123', 0, 0)
  const a = make('a', [point('west', -30, 0), shared, point('east', 30, 0)])
  const b = make('b', [point('bottom', 0, -30), { ...shared }, point('top', 0, 30)])
  assert.throws(() => planJunction(center(), [a, b]), /уже соединены/)
})

test('overpass and ground crossing must not create a ground-to-bridge junction', () => {
  const high = make('bridge', vertical().vertices, 1)
  assert.throws(() => planJunction(center(), [horizontal(), high]), /нет пересечения/)
})

test('parallel roads are not falsely combined, even if they are 1m apart', () => {
  const near = make('parallel', [point('p1', -40, 1), point('p2', 40, 1)])
  assert.throws(() => planJunction(center(), [horizontal(), near]), /нет пересечения/)
  const crossing = vertical()
  const plan = planJunction(center(), [horizontal(), crossing, near])
  assert.deepEqual(new Set(plan.roadIds), new Set(['horizontal','vertical']))
})

test('prevent false junction from footways and roundabouts', () => {
  const footway = vertical();footway.highway='footway'
  assert.throws(() => planJunction(center(), [horizontal(), footway]), /нет пересечения/)
  const ring = vertical();ring.tags.junction='roundabout'
  assert.throws(() => planJunction(center(), [horizontal(), ring]), /нет пересечения/)
})

test('junction is not fabricated when roads approach within 5m but never touch', () => {
  const spur = make('nearby', [point('down', 0, -50), point('end', 0, -5)])
  assert.throws(() => planJunction(center(), [horizontal(), spur]), /нет пересечения/)
})

test('returns deterministic outputs aside from one newly generated node ID', () => {
  const two = [horizontal(), vertical()]
  const first = planJunction(point('click', 0.5, 0.4), two)
  const again = planJunction(point('click', 0.5, 0.4), two)
  assert.deepEqual(first.roadIds, again.roadIds)
  assert.deepEqual(first.armSegments.map(p => p.length), again.armSegments.map(p => p.length))
})

test('prevents moving a shared existing endpoint to reach a nearby separate junction', () => {
  const shared = point('shared', 0.8, -0.8)
  const source = make('spur', [point('bottom', 0.8, -40), shared])
  const arm = make('arm', [shared, point('further', 20, -20)])
  assert.throws(() => planJunction(center(), [horizontal(), source, arm]), /уже связан/)
})

test('creating a junction makes it visible to the existing lane graph', async () => {
  const { buildLaneGraph } = await import('../src/lib/laneGraph.ts')
  const source = [horizontal(), vertical()]
  assert.equal(buildLaneGraph(source).junctionCount, 0)
  const plan = planJunction(center(), source)
  const updated = new Map(plan.roads.map(road => [road.roadId, road.vertices]))
  const connected = source.map(road => ({ ...road, vertices: updated.get(road.id) ?? road.vertices }))
  const graph = buildLaneGraph(connected)
  assert.equal(graph.junctionCount, 1)
  assert.ok(graph.connections.some(connection => connection.fromRoad === 'horizontal' && connection.toRoad === 'vertical'))
})

test('crossing near the endpoint of a very long OSM way is not silently skipped', () => {
  const main = make('long-main', [point('start', -2_000, 0), point('end', 2_000, 0)])
  const branch = make('branch', [point('south', 0, -40), point('north', 0, 40)])
  const plan = planJunction(center(), [main, branch])
  assert.equal(plan.armCount, 4)
  assert.equal(plan.roads.find(r => r.roadId === 'long-main')?.vertices.length, 3)
  assert.ok(plan.armSegments.every(([a, b]) => {
    const lon = (b.lng - a.lng) * 111_320 * Math.cos(a.lat * Math.PI / 180)
    const lat = (b.lat - a.lat) * 111_320
    return Math.hypot(lon, lat) <= 14.01
  }), 'preview arms must not extend across the whole city')
})
