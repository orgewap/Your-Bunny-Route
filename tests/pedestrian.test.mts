import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { RoadFeature, RoadVertex } from '../src/types/road.ts'
import { buildPedestrianGraph, pedestrianRoute, isPedestrianWay, pedestrianVisualFeatures, attachPedestrianPath, motorRoads } from '../src/lib/pedestrian.ts'
import { roadMarkingFeatures, markingPreference } from '../src/lib/roadMarkings.ts'
import { crosswalkStripeFeatures } from '../src/lib/crosswalks.ts'

const p=(id: string,x:number,y:number):RoadVertex=>({id,lng:x/111320,lat:y/111320})
const way=(id:string,highway:string,points:RoadVertex[],tags:Record<string,string>={},lanes=2):RoadFeature=>({id,osmId:id,highway,name:'',vertices:points,tags,lanes,level:0,bridge:false,oneway:false})
test('pedestrian OSM ways cannot become car lanes',()=>{
  const foot=way('f','footway',[p('1',0,0),p('2',20,0)])
  const road=way('r','residential',[p('3',0,5),p('4',20,5)])
  assert.equal(isPedestrianWay(foot),true)
  assert.deepEqual(motorRoads([foot,road]).map(v=>v.id),['r'])
  assert.equal(roadMarkingFeatures([foot]).length,0)
})
test('graph uses shared OSM node IDs, never crossing geometry',()=>{
  const a=way('a','footway',[p('one',0,0),p('shared',10,0)])
  const b=way('b','steps',[p('shared',10,0),p('end',10,10)])
  const graph=buildPedestrianGraph([a,b])
  const route=pedestrianRoute(graph,'one','end')
  assert.equal(route?.vertices.length,3)
  assert.ok(Math.abs((route?.metres ?? 0)-20)<0.1)
  assert.equal(graph.junctions.has('shared'),true)
  const unrelated=way('c','footway',[p('different',10,0),p('other',10,-10)])
  assert.equal(pedestrianRoute(buildPedestrianGraph([a,unrelated]),'one','other'),null)
})
test('tagged sidewalk is view-only and exported way is unchanged',()=>{
  const road=way('r','residential',[p('a',0,0),p('b',20,0)],{sidewalk:'both'})
  const view=pedestrianVisualFeatures([road],null)
  assert.equal(view.length,2)
  assert.ok(view.every(f=>f.properties.inferred))
  assert.equal(road.vertices.length,2)
  assert.deepEqual(buildPedestrianGraph([road]).edges,[])
})
test('pedestrian pen connects at existing shared vertex or inserts one in a segment',()=>{
  const base=way('p','footway',[p('a',0,0),p('b',30,0)])
  const next=attachPedestrianPath([base],[p('start',15,0.5),p('end',15,12)])
  assert.equal(next.roads[0]!.vertices.length,3)
  assert.equal(next.vertices[0]!.id,next.roads[0]!.vertices[1]!.id)
})
test('solid and double centerlines plus dashed adjacent lane separators',()=>{
  const road=way('r','primary',[p('a',0,0),p('b',30,0)],{divider:'double_solid'},4)
  const marks=roadMarkingFeatures([road])
  assert.equal(markingPreference(road),'double')
  assert.equal(marks.filter(m=>m.properties.kind==='solid').length,2)
  assert.equal(marks.filter(m=>m.properties.kind==='dashed').length,2)
})
test('zebra draws multiple physical stripes; unmarked crossing draws no fake zebra',()=>{
  const road=way('r','residential',[p('a',-50,0),p('b',50,0)],{},4)
  const base={id:'walk',osmId:'22',element:'node' as const,kind:'crossing' as const,vertices:[p('x',0,0)],direction:'both' as const,tags:{highway:'crossing',crossing:'zebra'}}
  assert.equal(crosswalkStripeFeatures([road],[base]).length,14)
  assert.equal(crosswalkStripeFeatures([road],[{...base,tags:{highway:'crossing',crossing:'unmarked'}}]).length,0)
})
test('only actual OSM turn:lanes create direction arrows, one per tagged lane',async()=>{
  const { turnArrowFeatures } = await import('../src/lib/roadMarkings.ts')
  const base = way('r','primary',[p('a',0,0),p('b',0,80)],{},4)
  assert.equal(turnArrowFeatures([base]).length,0)
  const tagged={...base,tags:{'turn:lanes:forward':'through|right','turn:lanes:backward':'left|through'}}
  const arrows=turnArrowFeatures([tagged])
  assert.equal(arrows.length,4)
  assert.deepEqual(arrows.map(a=>a.properties.glyph).sort(),['↑','↑','↰','↱'].sort())
})
test('3D pedestrian curbs are closed polygons and do not change OSM road geometry', async()=>{
  const { pedestrianSurfaceFeatures } = await import('../src/lib/pedestrian.ts')
  const walk=way('f','footway',[p('a',0,0),p('b',40,0)],{width:'2.5'})
  const before=JSON.stringify(walk)
  const surface=pedestrianSurfaceFeatures([walk])[0]!
  const ring=surface.geometry.coordinates[0]!
  assert.deepEqual(ring[0],ring.at(-1))
  assert.equal(surface.properties.width,2.5)
  assert.equal(JSON.stringify(walk),before)
})


test('3D pedestrian mesh emits raised pavement for visible paths and inferred sidewalks', async()=>{
  const { appendScenePedestrianSurfaces } = await import('../src/lib/scene3d.ts')
  const walk=way('walk','footway',[p('a',0,0),p('b',35,0)],{width:'2.4'})
  const inferred=way('road','residential',[p('c',0,8),p('d',35,8)],{sidewalk:'both'})
  let triangles=0
  let minHeight=Infinity
  const emit=(a:[number,number,number],b:[number,number,number],c:[number,number,number])=>{
    triangles++
    minHeight=Math.min(minHeight,a[2],b[2],c[2])
  }
  appendScenePedestrianSurfaces(emit,[walk,inferred],1)
  assert.ok(triangles>0)
  assert.ok(minHeight>=0.18)
})

test('3D pedestrian mesh never turns underground walkways into raised surface slabs', async()=>{
  const { appendScenePedestrianSurfaces } = await import('../src/lib/scene3d.ts')
  const tunnel=way('tunnel','footway',[p('a',0,0),p('b',35,0)],{tunnel:'yes',layer:'-1'})
  let triangles=0
  appendScenePedestrianSurfaces(()=>{triangles++},[tunnel],2)
  assert.equal(triangles,0)
})
