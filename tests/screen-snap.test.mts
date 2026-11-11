import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planRoad, materializeRoadPlan, snapToRoad } from '../src/lib/topology.ts'
import { snapElevatedAtScreen } from '../src/lib/screenSnap.ts'
import { bridgeNodeHeights, roadHeightAt } from '../src/lib/bridges.ts'
import { roadLengthMeters } from '../src/lib/geometry.ts'
import type { RoadFeature, RoadVertex } from '../src/types/road.ts'
const v=(id:string, x:number, y:number):RoadVertex=>({id,lng:x/111320,lat:y/111320})
const line=(id:string,y:number,level:number):RoadFeature=>({id,osmId:id,highway:'residential',name:id,lanes:2,oneway:false,bridge:level>0,level,vertices:[v(id+'start',-50,y),v(id+'end',50,y)],tags:{}})

test('overlapping bridge/ground default to elevated, Shift-style forced ground still possible',()=>{
  const roads=[line('ground',0,0),line('bridge',0,1)]
  assert.equal(snapToRoad(v('p',0,0),roads,3,null,null).link?.roadId,'bridge')
  assert.equal(snapToRoad(v('p',0,0),roads,3,null,0).link?.roadId,'ground')
})
test('3D hit test sees raised bridge while cursor ground coordinate is offset',()=>{
 const roads=[line('ground',0,0),line('bridge',0,1)]
 // Simplified pitched camera: upper deck projects 35 px above ground.
 const project=(lng:number,lat:number,z:number)=>({x:400+lng*111320*2,y:300+lat*111320*2-z*7})
 const snapped=snapElevatedAtScreen({x:400,y:265},roads,project,16)
 assert.equal(snapped?.roadId,'bridge')
 assert.ok(Math.abs(snapped?.t??-1) <1e-6 || Math.abs(snapped!.t-.5)<0.001)
 // The world position under the cursor would be 17.5 metres away in ground XY.
 assert.equal(snapToRoad(v('p',0,-17.5),roads,3,null,null).link,null)
})
test('pin exact on-screen elevated road through planning/materialisation, creating common node and ramp',()=>{
 const bridge=line('bridge',0,1)
 const ground=line('ground',0,0)
 const project=(lng:number,lat:number,z:number)=>({x:400+lng*111320*2,y:300+lat*111320*2-z*7})
 const link=snapElevatedAtScreen({x:400,y:265},[ground,bridge],project,16)!
 const path=[v('free',0,-60),link.vertex]
 const plan=planRoad(path,[ground,bridge],3,null,[false,true],[null,link])
 assert.equal(plan.endpoints.length,1)
 assert.equal(plan.endpoints[0]?.roadId,'bridge')
 const result=materializeRoadPlan(plan,[ground,bridge])
 const editedBridge={...bridge,vertices:result.modifiedExisting.get('bridge')!}
 const ramp=result.roads[0]!
 const shared=ramp.vertices.at(-1)!.id
 assert.ok(editedBridge.vertices.some(node=>node.id===shared))
 const heights=bridgeNodeHeights([ground,editedBridge,...result.roads])
 assert.equal(heights.get(shared),5)
 assert.equal(roadHeightAt(ramp,roadLengthMeters(ramp.vertices),heights),5)
})
