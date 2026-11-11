import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { planPenEllipseRoundabout } from '../src/lib/roundabout.ts'
import { samplePenEllipse } from '../src/lib/pen.ts'
import type { RoadFeature, RoadVertex } from '../src/types/road.ts'

const P = (id: string, x: number, y: number): RoadVertex => ({
  id, lng: x / 111_320, lat: y / 111_320,
})
const center = P('centre', 0, 0)
function road(id: string, xy: Array<[number, number]>, level = 0): RoadFeature {
  return {
    id, osmId: String(100 + id.charCodeAt(0)), name: id, highway: 'residential',
    lanes: 2, oneway: false, bridge: level > 0, level,
    vertices: xy.map(([x, y], i) => P(`${id}-${i}`, x, y)), tags: {},
  }
}
function crossing(): RoadFeature[] {
  return [
    road('x', [[-90, 0], [90, 0]]),
    road('y', [[0, -90], [0, 90]]),
  ]
}
function assertRoundaboutConnections(plan: NonNullable<ReturnType<typeof planPenEllipseRoundabout>>) {
  const ring = plan.result.at(-1)!
  assert.equal(ring.tags.junction, 'roundabout')
  assert.equal(ring.oneway, true)
  assert.equal(ring.lanes, 1)
  assert.equal(ring.level, 0)
  assert.equal(ring.vertices.at(-1)!.id, ring.vertices[0]!.id, 'OSM ring closes at shared ID')
  assert.equal(plan.connectionCount, 4)
  assert.equal(plan.result.length, 5, 'four approach arms + new ring')
  for (const linked of plan.attachmentVertices) {
    assert.ok(ring.vertices.some(vertex => vertex.id === linked.id), 'every arm touches the ring by shared node ID')
    assert.ok(plan.result.slice(0, -1).some(road => road.vertices.some(vertex => vertex.id === linked.id)))
  }
  assert.equal(new Set(plan.result.map(road => road.osmId)).size, plan.result.length, 'unique OSM way IDs')
}

test('pen Shift-circle on a crossroads restores an actual topological roundabout', () => {
  const source = crossing()
  const snapshot = JSON.stringify(source)
  const plan = planPenEllipseRoundabout(center, P('axis', 20, 0), P('width', 0, 5), true, source)
  assert.ok(plan)
  assertRoundaboutConnections(plan)
  assert.equal(plan.ellipse, undefined)
  assert.equal(plan.radiusMetres, 20)
  assert.equal(JSON.stringify(source), snapshot, 'plan preview does not mutate original roads')
})

test('pen oval on crossroads becomes an elliptical roundabout with physical width preserved', () => {
  const source = crossing()
  const snapshot = JSON.stringify(source)
  const plan = planPenEllipseRoundabout(center, P('axis', 35, 0), P('width', 0, 13), false, source, ['-1', '-5'])
  assert.ok(plan)
  assertRoundaboutConnections(plan)
  assert.ok(plan.ellipse)
  assert.ok(Math.abs(plan.ellipse.majorMetres - 35) < 0.01)
  assert.ok(Math.abs(plan.ellipse.minorMetres - 13) < 0.01)
  const xs = plan.ring.map(vertex => vertex.lng * 111_320)
  const ys = plan.ring.map(vertex => vertex.lat * 111_320)
  assert.ok(Math.abs(Math.max(...xs) - 35) < 0.5)
  assert.ok(Math.abs(Math.min(...xs) + 35) < 0.5)
  assert.ok(Math.abs(Math.max(...ys) - 13) < 0.5)
  assert.ok(Math.abs(Math.min(...ys) + 13) < 0.5)
  assert.ok(plan.result.every(road => Number(road.osmId) > 0 || Number(road.osmId) < -5))
  assert.equal(JSON.stringify(source), snapshot)
})

test('rotated oval keeps true attachment coordinates after normalization', () => {
  const s = Math.SQRT1_2
  const along = (a: number, b: number): [number, number] => [(a - b) * s, (a + b) * s]
  const source = [
    road('x', [along(-100,0), along(100,0)]),
    road('y', [along(0,-100), along(0,100)]),
  ]
  const plan = planPenEllipseRoundabout(center, P('axis', 32*s, 32*s), P('width', -14*s, 14*s), false, source)
  assert.ok(plan)
  assertRoundaboutConnections(plan)
  for (const vertex of plan.attachmentVertices) {
    const x = vertex.lng * 111_320, y = vertex.lat * 111_320
    const u = (x + y) * s, v = (y - x) * s
    assert.ok(Math.abs((u/32)**2 + (v/14)**2 - 1) < .002, 'shared node lies on exact oval')
  }
})

test('standalone circles and ovals remain regular closed pen ways, not roundabouts', () => {
  const c = planPenEllipseRoundabout(center, P('axis', 23, 0), P('width', 0, 23), true, [])
  const oval = planPenEllipseRoundabout(center, P('axis', 35, 0), P('width', 0, 13), false, [])
  assert.equal(c, null)
  assert.equal(oval, null)
  const penRing = samplePenEllipse(center, P('axis', 35, 0), P('width', 0, 13), false)
  assert.equal(penRing[0]!.id, penRing.at(-1)!.id)
})

test('raised crossings are never severed or joined to a surface roundabout', () => {
  const bridge = road('bridge', [[-90,0], [90,0]], 1)
  const source = [bridge, road('y', [[0,-90],[0,90]])]
  const plan = planPenEllipseRoundabout(center, P('axis', 22,0), P('width',0,22), true, source)
  assert.equal(plan, null, 'one ground road and one bridge do not form a ground crossroads')
  assert.deepEqual(source[0], bridge)
})

test('a genuine T intersection gets three linked roundabout arms', () => {
  const source = [
    road('x', [[-90,0],[90,0]]),
    road('y', [[0,-90],[0,0]]),
  ]
  const plan = planPenEllipseRoundabout(center, P('axis', 20, 0), P('width', 0, 20), true, source)
  assert.ok(plan)
  assert.equal(plan.connectionCount, 3)
  assert.equal(plan.result.at(-1)!.tags.junction, 'roundabout')
})

test('one street passing through a pen circle stays a normal pen road', () => {
  const source = [road('x', [[-90,0],[90,0]])]
  const plan = planPenEllipseRoundabout(center, P('axis', 20,0), P('width', 0, 20), true, source)
  assert.equal(plan, null)
})

test('oval roundabout works at nonzero geographic latitude', () => {
  const c = P('centre',0,0)
  c.lng = 104.283
  c.lat = 52.253
  const metresLng = 111_320 * Math.cos(c.lat * Math.PI / 180)
  const make = (id: string, east: number, north: number): RoadVertex => ({
    id, lng: c.lng + east/metresLng, lat: c.lat + north/111_320,
  })
  const original: RoadFeature[] = [
    { ...road('x', [[0,0],[1,1]]), vertices: [make('x1',-90,0),make('x2',90,0)] },
    { ...road('y', [[0,0],[1,1]]), vertices: [make('y1',0,-90),make('y2',0,90)] },
  ]
  const plan = planPenEllipseRoundabout(c, make('major',32,0), make('minor',0,13), false, original)
  assert.ok(plan)
  assert.equal(plan.connectionCount,4)
  for (const connection of plan.attachmentVertices) {
    const x=(connection.lng-c.lng)*metresLng, y=(connection.lat-c.lat)*111_320
    assert.ok(Math.abs((x/32)**2+(y/13)**2-1)<.003)
  }
})

test('oversized or too-small rings retain normal pen behaviour', () => {
  const source = crossing()
  assert.equal(planPenEllipseRoundabout(center, P('axis', 95,0), P('width',0,35),false,source), null)
  assert.equal(planPenEllipseRoundabout(center, P('axis', 20,0), P('width',0,5),false,source), null)
})

test('pen UI routes circle creation through the roundabout topology and confirmation', () => {
  const source = readFileSync(new URL('../src/components/MapEditor.vue', import.meta.url), 'utf8')
  assert.match(source, /store\.preparePenRoundabout\(/)
  assert.match(source, /pendingRoundabout\.value = roundabout/)
  assert.match(source, /store\.commitRoundabout\(pendingRoundabout\.value\)/)
})
