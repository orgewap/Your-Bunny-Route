import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isolatedMoveVertices, shiftVertices, cursorOffsetMetres } from '../src/lib/translate.ts'
import { samplePenEllipse, samplePenCurve } from '../src/lib/pen.ts'
import type { RoadFeature, RoadVertex } from '../src/types/road.ts'

const pt = (id: string, east = 0, north = 0): RoadVertex => ({
  id, lng: 104 + east / (111_320 * Math.cos(52 * Math.PI / 180)), lat: 52 + north / 111_320,
})
const way = (id: string, vertices: RoadVertex[], level = 0): RoadFeature => ({
  id, osmId: id === 'ring' ? '-12' : '42', name: '', highway: 'residential',
  lanes: 2, oneway: false, bridge: level > 0, level, vertices, tags: {},
})
const metres = (a: RoadVertex, b: RoadVertex) => cursorOffsetMetres(a, b)

test('a closed pen circle moves exactly 3 metres east and keeps every vertex and the closure', () => {
  const ring = way('ring', samplePenEllipse(pt('c'), pt('major', 22, 0), pt('minor', 0, 10), true))
  const prepared = isolatedMoveVertices([ring], 'ring')!
  const moved = shiftVertices(prepared, 3, 0)
  assert.equal(moved.length, ring.vertices.length)
  assert.equal(moved[0]!.id, moved.at(-1)!.id)
  assert.equal(moved[0]!.lng, moved.at(-1)!.lng)
  assert.equal(moved[0]!.lat, moved.at(-1)!.lat)
  for (let i = 0; i < moved.length; i++) {
    const delta = metres(ring.vertices[i]!, moved[i]!)
    assert.ok(Math.abs(delta.east - 3) < 0.0000001)
    assert.ok(Math.abs(delta.north) < 0.0000001)
  }
  assert.deepEqual(ring.vertices, ring.vertices) // no source data mutation
})

test('ellipse axes and curve shape remain unchanged after translating as one piece', () => {
  const ellipse = samplePenEllipse(pt('c'), pt('major', 35, 0), pt('minor', 0, 13), false)
  const curved = samplePenCurve([pt('a', 0, 0), pt('b', 7, 9), pt('c', 18, 4), pt('d', 27, 18)])
  for (const vertices of [ellipse, curved]) {
    const shifted = shiftVertices(vertices, -7, 3)
    assert.equal(shifted.length, vertices.length)
    const first = metres(vertices[0]!, shifted[0]!)
    assert.ok(Math.abs(first.east + 7) < 1e-7)
    assert.ok(Math.abs(first.north - 3) < 1e-7)
    for (let i = 1; i < vertices.length; i++) {
      const before = metres(vertices[0]!, vertices[i]!)
      const after = metres(shifted[0]!, shifted[i]!)
      assert.ok(Math.abs(before.east - after.east) < 0.0005)
      assert.ok(Math.abs(before.north - after.north) < 0.0000001)
    }
  }
})

test('moving selected way releases shared junction and bridge nodes without moving neighbours', () => {
  const shared = pt('shared', 0, 0)
  const approach = way('approach', [pt('left', -20, 0), shared])
  const bridge = way('bridge', [shared, pt('right', 20, 0)], 1)
  const start = JSON.stringify(bridge)
  const prepared = isolatedMoveVertices([approach, bridge], 'approach', () => 'new-unique-node')!
  assert.equal(prepared[0]!.id, 'left')
  assert.equal(prepared[1]!.id, 'new-unique-node')
  const translated = shiftVertices(prepared, 0, 3)
  assert.equal(metres(shared, translated[1]!).north.toFixed(3), '3.000')
  assert.equal(JSON.stringify(bridge), start)
  assert.notEqual(translated[1]!.id, bridge.vertices[0]!.id)
})

test('source OSM node IDs are cloned even when other visible roads do not reference them', () => {
  const road = way('source', [pt('osm-node-123'), pt('osm-node-456'), pt('osm-node-123')])
  let next = 0
  const moved = isolatedMoveVertices([road], 'source', () => `new-${++next}`)!
  assert.deepEqual(moved.map(v => v.id), ['new-1', 'new-2', 'new-1'])
  assert.deepEqual(road.vertices.map(v => v.id), ['osm-node-123', 'osm-node-456', 'osm-node-123'])
})

test('drag uses absolute cursor displacement: east and north can be reconstructed without drift', () => {
  const base = [pt('a', 0, 0), pt('b', 30, 0)]
  const at3 = shiftVertices(base, 3, 0)
  const at5 = shiftVertices(base, 5, 0)
  assert.ok(Math.abs(metres(base[0]!, at5[0]!).east - 5) < 1e-7)
  assert.ok(Math.abs(metres(at3[0]!, at5[0]!).east - 2) < 1e-7)
  assert.equal(base[0]!.id, at5[0]!.id)
})

test('reject invalid distance instead of corrupting OSM coordinates', () => {
  assert.throws(() => shiftVertices([pt('a')], Number.NaN, 0), /корректное/)
  assert.throws(() => shiftVertices([pt('a')], 20_000, 0), /10 км/)
})
