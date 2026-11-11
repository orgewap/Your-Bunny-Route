import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendSceneInfrastructure, appendSceneCrosswalks, emitSceneBox } from '../src/lib/scene3d.ts'
import type { ScenePoint, SceneColor } from '../src/lib/scene3d.ts'
import type { RoadFeature } from '../src/types/road.ts'

const road = (tags: Record<string,string>, bridge=false): RoadFeature => ({
  id:'test-road', osmId:'-1', name:'', highway:'residential', lanes:2,
  oneway: false, bridge, level: bridge ? 1 : 0, tags,
  vertices: [{id:'a',lng:104.28,lat:52.28},{id:'b',lng:104.281,lat:52.28}],
})
const triangles = (roads: RoadFeature[]): Array<[ScenePoint, ScenePoint, ScenePoint, SceneColor]> => {
  const out: Array<[ScenePoint, ScenePoint, ScenePoint, SceneColor]> = []
  appendSceneInfrastructure((a,b,c,color)=>out.push([a,b,c,color]),roads)
  return out
}
test('no extra 3D infrastructure on plain roads',()=> assert.equal(triangles([road({})]).length,0))
test('sidewalk-tag kerbs create raised 3D triangles',()=> {
  const out=triangles([road({sidewalk:'both'})])
  assert.ok(out.length>10)
  assert.ok(out.some(tri=>tri.some(p=>p[2]>0.18)))
})
test('3D guardrails are generated from standard editor tags',()=> {
  const out=triangles([road({'road_editor:guard_rail':'right'})])
  assert.ok(out.some(t=>t.some(p=>p[2]>1)))
})
test('bridge pier spacing is configurable, none disables it',()=> {
  const on=triangles([road({'road_editor:support_spacing':'10'},true)])
  const off=triangles([road({'road_editor:bridge_support':'none'},true)])
  assert.ok(on.length>off.length)
  assert.ok(on.some(t=>t.some(p=>p[2]===0)))
})
test('3D box emits finite triangles for curved city coordinates',()=>{
  const out: ScenePoint[]=[]
  emitSceneBox((a,b,c)=>out.push(a,b,c),[104.281,52.28,0],0.8,0.6,4,0.2,0,1,[1,1,1])
  assert.ok(out.length>=30)
  assert.ok(out.every(pt=>pt.every(Number.isFinite)))
})
test('traffic signal has 3D pole and housing, without changing the road',()=> {
  const input = road({})
  const before = JSON.stringify(input)
  const out: ScenePoint[] = []
  appendSceneInfrastructure((a,b,c)=>out.push(a,b,c),[input],[{
    id:'signal',osmId:'-15',element:'node',kind:'traffic_signal',
    direction:'forward',tags:{highway:'traffic_signals'},
    vertices:[{id:'signal',lng:104.2805,lat:52.28}],
  }])
  assert.ok(out.some(v=>v[2]>=3.15))
  assert.equal(JSON.stringify(input), before)
})
test('only marked crosswalk polygons create 3D paint triangles',()=>{
  const out: ScenePoint[]=[]
  appendSceneCrosswalks((a,b,c)=>out.push(a,b,c),[{
    type:'Feature',properties:{sourceId:'x',marked:true,inferred:false},
    geometry:{type:'Polygon',coordinates:[[[104.2802,52.28],[104.28022,52.28],[104.28022,52.28002],[104.2802,52.28002],[104.2802,52.28]]]},
  }])
  assert.equal(out.length,6)
  assert.ok(out.every(v=>v[2]===0.23))
})
