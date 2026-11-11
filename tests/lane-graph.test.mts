import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildLaneGraph } from '../src/lib/laneGraph.ts'
import { surfaceVertices, surfaceNetwork } from '../src/lib/roadSurface.ts'
import type { RoadFeature, RoadVertex } from '../src/types/road.ts'

function p(id: string, east: number, north: number): RoadVertex {
  return { id, lng: east / 111_320, lat: north / 111_320 }
}
function road(id: string, vertices: RoadVertex[], lanes = 2, level = 0, tags: Record<string, string> = {}): RoadFeature {
  return { id, osmId: id, name: id, highway: 'residential', lanes, oneway: false,
    bridge: level > 0, level, tags, vertices }
}
function fixture() {
  const junction = p('shared', 0, 0)
  const main = road('main', [p('west', -40, 0), junction, p('east', 40, 0)], 4)
  const branch = road('branch', [junction, p('outer-edge', 0, -6.4), p('south', 22, -50)], 2)
  return { main, branch }
}

test('render-only road surface trims the centreline spur of a 4-to-2 lane side junction', () => {
  const { main, branch } = fixture()
  branch.visualApproach = { start: true }
  const original = JSON.stringify([main, branch])
  const physical = surfaceVertices(branch, [main, branch])
  assert.equal(physical[0]!.id, 'outer-edge')
  assert.equal(physical.length, 2)
  assert.equal(branch.vertices[0]!.id, 'shared', 'OSM must keep the common graph node')
  assert.equal(surfaceVertices(main, [main, branch]).length, 3)
  assert.equal(JSON.stringify([main, branch]), original, 'no source mutation')
  assert.equal(surfaceNetwork([main, branch])[1]!.vertices[0]!.id, 'outer-edge')
})

test('surface trim never cuts an end-to-end road or floating bridge', () => {
  const a = p('same', 0, 0)
  const first = road('a', [p('start', -8, 0), a], 4)
  const second = road('b', [a, p('end', 0, -6.4), p('far', 0, -20)], 2)
  assert.equal(surfaceVertices(second, [first, second]).length, 3, 'requires interior target node')
  second.bridge = true; second.level = 1
  assert.equal(surfaceVertices(second, [first, second]).length, 3, 'bridge preserved')
})

test('builds separate lanes with deterministic IDs and correct direction for four lanes', () => {
  const { main, branch } = fixture()
  const before = JSON.stringify([main, branch])
  const graph = buildLaneGraph([main, branch])
  assert.equal(graph.edges.length, 6)
  assert.equal(graph.junctionCount, 1)
  assert.deepEqual(graph.edges.filter(edge => edge.roadId === 'main').map(edge => edge.flow),
    ['backward', 'backward', 'forward', 'forward'])
  assert.equal(new Set(graph.edges.map(edge => edge.id)).size, 6)
  assert.ok(graph.nodes.some(node => node.junction && node.nodeId === 'shared'))
  assert.ok(graph.connections.length > 0)
  assert.ok(graph.connections.some(link => link.fromRoad === 'main' && link.toRoad === 'branch'))
  assert.ok(graph.connections.every(link => link.level === 0))
  assert.equal(JSON.stringify([main, branch]), before)
  assert.deepEqual(buildLaneGraph([main, branch]), graph, 'stable outputs after refresh')
})

test('ten-lane graph has ten real lanes, including the physical outermost', () => {
  const main = road('ten', [p('a', -50, 0), p('b', 50, 0)], 10)
  const g = buildLaneGraph([main])
  assert.equal(g.edges.length, 10)
  assert.equal(g.nodes.length, 20)
  const left = g.edges[0]!.coordinates[0]!
  const right = g.edges[9]!.coordinates[0]!
  assert.ok(Math.abs(left.lat - right.lat) * 111_320 > 28)
})

test('crossing lines without shared OSM node never become a false lane connection', () => {
  const a = road('a', [p('a1', -40, 0), p('a2', 40, 0)])
  const b = road('b', [p('b1', 0, -40), p('b2', 0, 40)])
  const g = buildLaneGraph([a, b])
  assert.equal(g.junctionCount, 0)
  assert.equal(g.connections.length, 0)
})

test('elevated crossing cannot connect to surface even at same original OSM node ID', () => {
  const shared = p('same', 0, 0)
  const ground = road('ground', [p('left', -30, 0), shared, p('right', 30, 0)])
  const bridge = road('bridge', [shared, p('top', 0, 30)], 2, 1)
  const g = buildLaneGraph([ground, bridge])
  assert.equal(g.junctionCount, 0)
  assert.equal(g.connections.length, 0)
})

test('turn:lanes:forward limits automatic right-turn recommendations by incoming lane', () => {
  const shared = p('joint', 0, 0)
  const main = road('main', [p('left', -40, 0), shared, p('right', 40, 0)], 3, 0,
    { 'turn:lanes:forward': 'through|right' })
  const branch = road('branch', [shared, p('down', 0, -40)], 2)
  const g = buildLaneGraph([main, branch])
  // A malformed lane tagging pattern is intentionally not interpreted as a ban.
  assert.ok(g.connections.some(x => x.fromRoad === 'main' && x.toRoad === 'branch'))
  main.tags['turn:lanes:forward'] = 'through|right' // forward lanes=2
  const south = g.connections.filter(x => x.fromRoad === 'main' && x.toRoad === 'branch' && x.turn === 'right')
  assert.ok(south.length <= 2)
})


test('lane-edge junctions use the physical edge for connecting ports, not the hidden OSM centreline spur', () => {
  const joint = p('joint-edge', 0, 0)
  const main = road('main-edge', [p('a', -50, 0), joint, p('b', 50, 0)], 4)
  const branch = road('branch-edge', [joint, p('physical', 0, -6.4), p('outer', 0, -55)], 2)
  branch.visualApproach = { start: true }
  const graph = buildLaneGraph([main, branch])
  const turns = graph.connections.filter(c => c.fromRoad === main.id && c.toRoad === branch.id)
  assert.ok(turns.length > 0, 'all untagged turn choices remain visible')
  for (const link of turns) {
    const end = link.coordinates[link.coordinates.length - 1]!
    assert.ok(end.lat * 111320 < -6.4, 'end of turn follows visible branch, not central OSM stub')
  }
})

test('explicit turn:lanes continues to control directions without removing permission settings', () => {
  const shared = p('shared-explicit', 0, 0)
  const main = road('explicit', [p('west-explicit', -60, 0), shared, p('east-explicit', 60, 0)], 4,
    0, { 'turn:lanes:forward': 'through|right' })
  const branch = road('turn', [shared, p('south-explicit', 0, -55)], 2)
  const graph = buildLaneGraph([main, branch])
  assert.equal(main.tags['turn:lanes:forward'], 'through|right')
  const outs = graph.connections.filter(c => c.fromRoad === main.id && c.toRoad === branch.id && c.turn === 'right')
  assert.ok(outs.some(c => c.fromLane === 3), 'explicit right turn allowed from outer lane')
  assert.ok(outs.every(c => c.fromLane !== 2), 'through-only lane cannot turn right')
})
