import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { RoadFeature, RoadVertex } from '../src/types/road.ts'
import { roadMarkingFeatures } from '../src/lib/roadMarkings.ts'
import { roadMarkingSections } from '../src/lib/junctionMarkings.ts'
import { crosswalkStripeFeatures } from '../src/lib/crosswalks.ts'
import { mercatorPixelsPerMetre, METRIC_RENDER_ZOOM_STOPS } from '../src/lib/mapScale.ts'

const v = (id: string, east: number, north: number): RoadVertex => ({id, lng: east/111320, lat: north/111320})
const road = (id: string, points: RoadVertex[], lanes = 4, level = 0): RoadFeature => ({
  id, osmId:id, name: '', highway: 'primary', lanes, level, bridge: level>0, oneway:false,
  vertices: points, tags: {lanes: String(lanes), divider:'solid'},
})
const atMetres = (lng: number, lat: number): [number, number] => [lng*111320, lat*111320]

test('true OSM junction: painted lane lines stop at the carriageway edge, not across its middle', () => {
  const main=road('main', [v('a',0,0),v('joint',50,0),v('b',100,0)], 6)
  const side=road('side', [v('c',50,-50),v('joint',50,0)], 2)
  const sections=roadMarkingSections([main, side])
  assert.equal(sections.get('main')?.length, 2)
  assert.equal(sections.get('side')?.length, 1)
  const ends=sections.get('main')!.map(section => section.at(-1)!.lng *111320)
  assert.ok(ends[0]!<47 && ends[0]!>44)
  const beginnings=sections.get('main')!.map(section => section[0]!.lng*111320)
  assert.ok(beginnings[1]!>53 && beginnings[1]!<56)
  const approach=sections.get('side')![0]!.at(-1)!
  assert.ok(approach.lat*111320 < -10)
  const painted=roadMarkingFeatures([main,side])
  assert.ok(painted.length>0)
  assert.ok(painted.every(line => line.geometry.coordinates.length>=2))
  // Render clipping must never mutate original OSM topology or move shared nodes.
  assert.equal(main.vertices[1]!.id, side.vertices[1]!.id)
  assert.equal(main.vertices[1]!.lng, 50/111320)
})

test('a plain two-way continuation is not mistaken for an intersection', () => {
  const a=road('a',[v('start',0,0),v('shared',40,0)],2)
  const b=road('b',[v('shared',40,0),v('end',80,0)],2)
  const sections=roadMarkingSections([a,b])
  assert.equal(sections.get('a')![0]!.at(-1)!.id,'shared')
  assert.equal(sections.get('b')![0]![0]!.id,'shared')
})

test('a bridge visually crossing a ground junction is never cut as a ground junction', () => {
  const a=road('ground',[v('a',0,0),v('same',50,0),v('b',100,0)],4)
  const b=road('bridge',[v('c',50,-50),v('same',50,0),v('d',50,50)],4,1)
  const cuts=roadMarkingSections([a,b])
  assert.equal(cuts.get('ground')?.length,1)
  assert.equal(cuts.get('bridge')?.length,1)
})

test('zebra bars follow road direction and span across its width, not 90 degrees rotated', () => {
  const main=road('road',[v('start',-40,0),v('end',40,0)], 4)
  const feature={id:'crossing',osmId:'crossing',element:'node' as const,
    kind:'crossing' as const,vertices:[v('p',0,0)],direction:'both' as const,
    tags:{highway:'crossing',crossing:'zebra'}}
  const markings=crosswalkStripeFeatures([main],[feature])
  assert.equal(markings.length,14)
  const ring=markings[0]!.geometry.coordinates[0]!
  assert.deepEqual(ring[0],ring.at(-1))
  const paintLength=Math.hypot(...atMetres(ring[1]![0]!-ring[0]![0]!,ring[1]![1]!-ring[0]![1]!))
  const paintWidth=Math.hypot(...atMetres(ring[2]![0]!-ring[1]![0]!,ring[2]![1]!-ring[1]![1]!))
  assert.ok(Math.abs(paintLength-3)<0.02)
  assert.ok(Math.abs(paintWidth-0.46)<0.02)
  assert.ok(paintLength>paintWidth*5)
  assert.equal(crosswalkStripeFeatures([main],[{...feature,tags:{highway:'crossing',crossing:'traffic_signals'}}]).length,0)
})

test('metric roadway widths scale 2x per map zoom level even past former zoom 20 limit', () => {
  assert.ok(METRIC_RENDER_ZOOM_STOPS.includes(24))
  const at20=mercatorPixelsPerMetre(20,52)*3.2
  const at21=mercatorPixelsPerMetre(21,52)*3.2
  const at22=mercatorPixelsPerMetre(22,52)*3.2
  assert.ok(Math.abs(at21/at20-2)<1e-12)
  assert.ok(Math.abs(at22/at21-2)<1e-12)
})

test('road provenance outlines are also cut at a real junction instead of crossing its centre', async () => {
  const { roadStatusEdges } = await import('../src/lib/roadStatus.ts')
  const main=road('main',[v('a',0,0),v('junction',50,0),v('b',100,0)],4)
  const side=road('side',[v('c',50,-40),v('junction',50,0)],4)
  const status=new Map<string, 'imported' | 'created'>([['main','imported'],['side','created']])
  const visible=roadMarkingSections([main,side])
  const edges=roadStatusEdges([main,side], status, visible)
  assert.equal(edges.length,6) // two visible main sections and one on the side, two edges each
  assert.ok(edges.every(edge => edge.geometry.coordinates.length>=2))
})

test('pedestrian path width is physical OSM metres and not a fixed pixel stroke', async () => {
  const { pedestrianVisualFeatures } = await import('../src/lib/pedestrian.ts')
  const path={...road('walk',[v('a',0,0),v('b',0,30)],1),highway:'footway',tags:{width:'2.7'}}
  const feature=pedestrianVisualFeatures([path],null)[0]!
  assert.equal(feature.properties.width,2.7)
  assert.ok(feature.properties.latitudeFactor>=1)
})
