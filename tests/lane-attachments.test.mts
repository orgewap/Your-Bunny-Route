import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LANE_WIDTH_METRES } from '../src/lib/lanes.ts'
import { snapToLaneAtScreen } from '../src/lib/laneSnap.ts'
import { materializeRoadPlan, planRoad, distanceMetres } from '../src/lib/topology.ts'
import { reconnectDraggedEndpoint } from '../src/lib/reconnect.ts'
import type { RoadFeature, RoadVertex } from '../src/types/road.ts'

const v = (id: string, x: number, y: number): RoadVertex => ({ id, lng: x / 111320, lat: y / 111320 })
const road = (id: string, count: number, level = 0): RoadFeature => ({
  id, osmId: id, lanes: count, highway: 'residential', name: '', oneway: false,
  bridge: level > 0, level, tags: {},
  vertices: [v(`${id}-a`, -60, 0), v(`${id}-b`, 60, 0)],
})
// Screen increases downwards; eastward road has positive lane offset to the south.
const project = (lng: number, lat: number, height: number) => ({
  x: 500 + lng * 111320 * 2,
  y: 300 - lat * 111320 * 2 - height * 7,
})
const pick = (lanes: number, offset: number, zoom = 17.5, level = 0) =>
  snapToLaneAtScreen(
    { x: 500, y: 300 + offset * LANE_WIDTH_METRES * 2 },
    [road('target', lanes, level)], project, zoom, '2d', 12,
  )

test('selects outermost LEFT or RIGHT physical edge on 3/4/10 lane road', () => {
  for (const lanes of [3, 4, 10]) {
    for (const sign of [-1, 1]) {
      const offset = sign * lanes / 2
      const result = pick(lanes, offset)!
      assert.ok(result, `lanes ${lanes}, side ${sign}`)
      assert.equal(result.boundary, true)
      assert.equal(result.link.laneAttachment?.offsetMetres, offset * 3.2)
      assert.ok(Math.abs(result.visibleVertex.lat * 111320 + offset * 3.2) < 0.03)
      assert.equal(result.link.vertex.lat, 0)
      assert.equal(result.link.roadId, 'target')
    }
  }
})

test('supports every lane centre and interior dividing line, not just the centre of the way', () => {
  const zoom = 17.5
  for (const offset of [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2]) {
    const hit = pick(4, offset, zoom)!
    assert.ok(hit)
    assert.ok(Math.abs(hit.link.laneAttachment!.offsetMetres - offset * 3.2) < 1e-6, `${offset}`)
  }
})

test('lane-aware build starts at chosen side while target way retains one real OSM graph junction', () => {
  const target = road('target', 4)
  const hit = snapToLaneAtScreen({ x: 500, y: 300 + 2 * LANE_WIDTH_METRES * 2 }, [target], project, 17.5, '2d', 12)!
  const plan = planRoad([hit.visibleVertex, v('end', 0, -55)], [target], 3, null, [true, false], [hit.link, null])
  assert.equal(plan.endpoints.length, 1)
  assert.equal(plan.path.length, 3)
  assert.ok(distanceMetres(plan.path[0]!, plan.path[1]!) > 6.3)
  assert.ok(distanceMetres(plan.path[0]!, plan.path[1]!) < 6.6)
  const result = materializeRoadPlan(plan, [target])
  const updatedTarget = result.modifiedExisting.get(target.id)!
  assert.ok(updatedTarget)
  const created = result.roads[0]!
  assert.equal(created.vertices[0]!.id, updatedTarget[1]!.id)
  assert.ok(Math.abs(created.vertices[0]!.lat) < 1e-8)
  assert.ok(created.vertices[1]!.lat < -0.00005)
  assert.equal(result.bridgeCount, 0)
})

test('can finish at an outside edge as well as start there', () => {
  const target = road('target', 4)
  const hit = snapToLaneAtScreen({ x: 500, y: 300 - 2 * LANE_WIDTH_METRES * 2 }, [target], project, 17.5, '2d', 12)!
  const plan = planRoad([v('start', 0, 50), hit.visibleVertex], [target], 3, null, [false, true], [null, hit.link])
  assert.equal(plan.path.length, 3)
  assert.equal(plan.path.at(-1)!.lat, 0)
  const result = materializeRoadPlan(plan, [target])
  assert.equal(result.roads[0]!.vertices.at(-1)!.id, result.modifiedExisting.get('target')![1]!.id)
})

test('existing endpoint drag can terminate beside outer lane while retaining common node', () => {
  const target = road('target', 4)
  const branch: RoadFeature = { ...road('branch', 2), vertices: [v('branch-start', 0, -60), v('branch-end', 0, -20)] }
  const hit = snapToLaneAtScreen({ x: 500, y: 300 + 2 * LANE_WIDTH_METRES * 2 }, [target], project, 17.5, '2d', 12)!
  const updated = reconnectDraggedEndpoint([target, branch], 'branch-end', hit.link)
  const editedTarget = updated.find(r => r.id === 'target')!
  const editedBranch = updated.find(r => r.id === 'branch')!
  assert.equal(editedBranch.vertices.length, 3)
  assert.equal(editedBranch.vertices.at(-1)!.id, editedTarget.vertices[1]!.id)
  assert.ok(Math.abs(editedBranch.vertices[1]!.lat * 111320 + 6.4) < 0.05)
})

test('prefers elevated way when two ways overlap and Shift-like filtering can force ground', () => {
  const targets = [road('ground', 4, 0), road('bridge', 4, 1)]
  const px = LANE_WIDTH_METRES * 2
  const elevated = snapToLaneAtScreen({ x: 500, y: 300 + 1.5 * px }, targets, project, 17.5, '2d', 12)
  assert.equal(elevated?.link.roadId, 'bridge')
  const forcedGround = snapToLaneAtScreen({ x: 500, y: 300 + 1.5 * px }, targets.filter(r => r.level === 0), project, 17.5, '2d', 12)
  assert.equal(forcedGround?.link.roadId, 'ground')
})

test('does not treat a bare crossing or distant stripe as an intersection', () => {
  assert.equal(snapToLaneAtScreen({ x: 2000, y: 2000 }, [road('target', 10)], project, 17.5, '2d', 12), null)
  assert.equal(pick(4, 1, 13), null)
})
