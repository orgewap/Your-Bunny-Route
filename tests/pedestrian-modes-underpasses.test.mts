import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { RoadFeature, RoadVertex } from '../src/types/road.ts'
import { graphVisibility, isBackgroundTransportLine } from '../src/lib/networkLayers.ts'
import { buildPedestrianGraph, isUndergroundPedestrianWay, pedestrianPortalFeatures,
  pedestrianSurfaceFeatures, pedestrianVisualFeatures, pedestrianRoute } from '../src/lib/pedestrian.ts'

const v = (id: string, east: number, north: number): RoadVertex => ({ id, lng: east / 111320, lat: north / 111320 })
const way = (id: string, highway: string, vertices: RoadVertex[], tags: Record<string, string> = {}): RoadFeature => ({
  id, osmId: id, name: '', highway, vertices, tags, lanes: 2, oneway: false, bridge: false, level: 0,
})

test('switching graph modes has exclusive automotive/pedestrian visibility with a combined state', () => {
  assert.deepEqual(graphVisibility('motor'), { motor: true, pedestrian: false })
  assert.deepEqual(graphVisibility('pedestrian'), { motor: false, pedestrian: true })
  assert.deepEqual(graphVisibility('all'), { motor: true, pedestrian: true })
})

test('only original vector transport road lines, not MapLibre editor or building labels, are hidden', () => {
  assert.equal(isBackgroundTransportLine({ id: 'highway-primary', type: 'line', 'source-layer': 'transportation' }), true)
  assert.equal(isBackgroundTransportLine({ id: 'bridge-roads', type: 'line' }), true)
  assert.equal(isBackgroundTransportLine({ id: 'editor-pedestrian-paths', type: 'line', 'source-layer': 'transportation' }), false)
  assert.equal(isBackgroundTransportLine({ id: 'road-labels', type: 'symbol', 'source-layer': 'transportation_name' }), false)
  assert.equal(isBackgroundTransportLine({ id: 'building-outline', type: 'line', 'source-layer': 'building' }), false)
})

test('underpass OSM tags are read for pedestrian ways without turning car tunnels into walkways', () => {
  const a = way('a', 'footway', [v('a', 0, 0), v('b', 20, 0)], { tunnel: 'building_passage' })
  const b = way('b', 'steps', [v('b', 20, 0), v('c', 20, 20)], { layer: '-1' })
  const c = way('c', 'footway', [v('x', 0, 1), v('y', 20, 1)], { location: 'underground' })
  const d = way('d', 'footway', [v('r', 0, 2), v('s', 20, 2)], { level: '-1' })
  const normal = way('normal', 'footway', [v('p', 0, 3), v('q', 20, 3)], { tunnel: 'no' })
  const motor = way('motor', 'primary', [v('u', 0, 4), v('w', 20, 4)], { tunnel: 'yes', layer: '-1' })
  for (const road of [a,b,c,d]) assert.equal(isUndergroundPedestrianWay(road), true)
  assert.equal(isUndergroundPedestrianWay(normal), false)
  assert.equal(isUndergroundPedestrianWay(motor), false)
  assert.equal(pedestrianVisualFeatures([a,normal], null)[0]!.properties.underground, true)
  assert.equal(pedestrianVisualFeatures([normal], null)[0]!.properties.underground, false)
})

test('underpasses remain walkable graph edges but never become fake raised pavement in 3D', () => {
  const surface = way('surface', 'footway', [v('one', 0, 0), v('entry', 12, 0)])
  const tunnel = way('tunnel', 'footway', [v('entry', 12, 0), v('exit', 30, 0)], { tunnel: 'yes', layer: '-1' })
  const next = way('next', 'footway', [v('exit', 30, 0), v('last', 40, 0)])
  const roads = [surface, tunnel, next]
  const route = pedestrianRoute(buildPedestrianGraph(roads), 'one', 'last')
  assert.deepEqual(route?.vertices.map(p => p.id), ['one','entry','exit','last'])
  const curbs = pedestrianSurfaceFeatures(roads)
  assert.deepEqual(curbs.map(item => item.properties.roadId).sort(), ['next', 'surface'])
  assert.deepEqual(pedestrianPortalFeatures(roads).map(f => f.properties.nodeId).sort(), ['entry','exit'])
})

test('no fake portal in the middle when the underpass is split into adjacent OSM ways', () => {
  const a = way('a', 'footway', [v('a', 0, 0), v('mid', 10, 0)], { tunnel: 'yes' })
  const b = way('b', 'footway', [v('mid', 10, 0), v('b', 20, 0)], { tunnel: 'yes' })
  const ids = pedestrianPortalFeatures([a,b]).map(f => f.properties.nodeId)
  assert.deepEqual(ids.sort(), ['a','b'])
})
