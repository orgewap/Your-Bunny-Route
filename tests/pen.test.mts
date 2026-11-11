import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appendFreehandSample, previewPen, samplePenCurve, samplePenEllipse, simplifyFreehandSamples } from '../src/lib/pen.ts'
import { materializeRoadPlan, planRoad } from '../src/lib/topology.ts'
import type { RoadFeature, RoadVertex } from '../src/types/road.ts'

const p = (id: string, x: number, y: number): RoadVertex => ({
  id, lng: x / 111_320, lat: y / 111_320,
})
const way = (id: string, from: RoadVertex, to: RoadVertex): RoadFeature => ({
  id, osmId: '42', name: '', highway: 'residential', lanes: 2,
  oneway: false, bridge: false, level: 0, vertices: [from, to], tags: {},
})
test('drawing pen connects clicked points to the moving cursor', () => {
  const preview = previewPen('draw', [p('a',0,0),p('b',20,0)], p('cursor',30,15))
  assert.equal(preview.length, 3)
  assert.equal(preview.at(-1)!.id, 'cursor')
})

test('freehand preview follows every recorded mouse sample without a held button', () => {
  const recorded = [p('a',0,0), p('b',8,4), p('c',14,9)]
  const preview = previewPen('freehand', recorded, p('cursor', 19, 12))
  assert.deepEqual(preview.slice(0, 3).map(vertex => vertex.id), ['a', 'b', 'c'])
  assert.equal(preview.at(-1)!.id, 'cursor')
})

test('freehand samples mouse motion every few screen pixels and preserves exact final snap ID', () => {
  let samples = appendFreehandSample([], p('a',0,0), {x:10,y:10})
  samples = appendFreehandSample(samples, p('skipped',1,1), {x:11,y:11})
  assert.equal(samples.length, 1)
  samples = appendFreehandSample(samples, p('b',4,0), {x:14,y:10})
  assert.equal(samples.length, 2)
  samples = appendFreehandSample(samples, p('bridge',5,0), {x:15,y:10}, 3, true)
  assert.equal(samples.length, 2)
  assert.equal(samples[0]!.vertex.id, 'a')
  assert.equal(samples[1]!.vertex.id, 'bridge')
})

test('freehand simplification preserves bends and both OSM endpoint identities', () => {
  const entries = [
    ['start',0,0], ['s1',10,0.2], ['s2',20,-0.2],
    ['bend',30,20], ['s3',40,20.1], ['end',50,20],
  ] as const
  const samples = entries.map(([id,x,y]) => ({ vertex:p(id,x,y), screen:{x,y} }))
  const result = simplifyFreehandSamples(samples, 1.5)
  assert.equal(result[0]!.vertex.id, 'start')
  assert.equal(result.at(-1)!.vertex.id, 'end')
  assert.ok(result.some(point => point.vertex.id === 'bend'))
  assert.ok(result.length < samples.length)
})
test('ellipse is physically circular in local metre coordinates and closed OSM loop', () => {
  const ring = samplePenEllipse(p('center',0,0),p('radius',35,0),p('width',0,15),true)
  assert.equal(ring[0]!.id,ring.at(-1)!.id)
  assert.equal(ring[0]!.lng,ring.at(-1)!.lng)
  assert.equal(ring.length,97)
  for (const point of ring.slice(0,-1)) {
    const d=Math.hypot(point.lng*111_320,point.lat*111_320)
    assert.ok(Math.abs(d-35)<0.00001)
  }
})
test('ellipse has independent major and minor axes', () => {
  const ring=samplePenEllipse(p('center',0,0),p('major',40,0),p('minor',0,12),false)
  const xmax=Math.max(...ring.map(v=>v.lng*111_320))
  const ymax=Math.max(...ring.map(v=>v.lat*111_320))
  assert.ok(Math.abs(xmax-40)<0.01)
  assert.ok(Math.abs(ymax-12)<0.01)
  const materialized=materializeRoadPlan(planRoad(ring,[],8,null,[false,false]),[])
  assert.equal(materialized.roads.length,1)
  assert.equal(materialized.roads[0]!.vertices[0]!.id, materialized.roads[0]!.vertices.at(-1)!.id)
})
test('pen endpoint pinned to a raised bridge materialises shared topology', () => {
  const bridge={...way('bridge',p('b1',-100,0),p('b2',100,0)),bridge:true,level:1}
  const path=[p('start',0,-60),p('middle',0,-30),p('end',0,0)]
  const link={roadId:'bridge',segmentIndex:0,t:.5,vertex:p('shared',0,0)}
  const built=materializeRoadPlan(planRoad(path,[bridge],8,null,[false,true],[null,link]),[bridge])
  assert.equal(built.roads.at(-1)!.vertices.at(-1)!.id,'shared')
  assert.equal(built.modifiedExisting.get('bridge')?.[1]?.id,'shared')
})


test('original pen curve passes through every clicked control point (no 3-click limit)', () => {
  const points = [p('start', 0, 0), p('bend1', 12, 20), p('bend2', 30, -10), p('bend3', 47, 16), p('end', 61, 0)]
  const curve = samplePenCurve(points, 8)
  for (const point of points) assert.ok(curve.some(vertex => vertex.id === point.id))
  assert.ok(curve.length > points.length)
  assert.equal(curve[0]?.id, 'start')
  assert.equal(curve.at(-1)?.id, 'end')
  const preview = previewPen('curve', points.slice(0, -1), points.at(-1)!)
  assert.ok(preview.length > points.length)
  assert.equal(preview.at(-1)?.id, 'end')
  const built = materializeRoadPlan(planRoad(curve, [], 8, null, [false, false]), [])
  assert.equal(built.roads[0]!.vertices[0]!.id, 'start')
  assert.equal(built.roads[0]!.vertices.at(-1)!.id, 'end')
})

test('original pen ellipse preview closes itself and Shift makes circle', () => {
  const centre = p('centre',0,0)
  const radius = p('radius', 28,0)
  const width = p('width',0,14)
  const preview = previewPen('ellipse', [centre, radius], width, false)
  assert.equal(preview[0]!.id, preview.at(-1)!.id)
  const circle = previewPen('ellipse', [centre, radius], width, true)
  assert.equal(circle[0]!.id, circle.at(-1)!.id)
  assert.ok(Math.abs(Math.max(...preview.map(v => v.lat)) * 111_320 - 14) < .01)
  assert.ok(Math.abs(Math.max(...circle.map(v => v.lat)) * 111_320 - 28) < .01)
})
