import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyRoads, roadStatusEdges, sameRoadData } from '../src/lib/roadStatus.ts'
import type { RoadFeature } from '../src/types/road.ts'

const sample = (osmId: string, id = `way-${osmId}`): RoadFeature => ({
  id, osmId, name: 'Ленина', highway: 'residential', lanes: 2, oneway: false,
  bridge: false, level: 0, tags: { highway: 'residential', lanes: '2' },
  vertices: [
    { id: 'osm-node-1', lng: 104, lat: 52 },
    { id: 'osm-node-2', lng: 104.001, lat: 52.001 },
  ],
})
const clone = (road: RoadFeature): RoadFeature => ({ ...road, tags: { ...road.tags }, vertices: road.vertices.map(v => ({ ...v })) })

test('imported, created and changed roads have independent deterministic statuses', () => {
  const initial = sample('120')
  const changed = clone(initial)
  changed.lanes = 4
  const created = sample('-1', 'new-way')
  const result = classifyRoads([changed, created, sample('121')], [initial, sample('121')], ['120', '121'])
  assert.equal(result.byId.get(changed.id), 'modified')
  assert.equal(result.byId.get(created.id), 'created')
  assert.equal(result.byId.get('way-121'), 'imported')
  assert.deepEqual(result.counts, { imported: 1, created: 1, modified: 1 })
})

test('undo restoring original tags and coordinates restores imported status', () => {
  const original = sample('1')
  const edited = clone(original)
  edited.vertices[1]!.lng += 0.0002
  edited.tags.maxspeed = '40'
  assert.equal(classifyRoads([edited], [original], ['1']).byId.get(original.id), 'modified')
  assert.equal(classifyRoads([clone(original)], [original], ['1']).byId.get(original.id), 'imported')
  assert.equal(sameRoadData(clone(original), original), true)
})

test('adding an OSM junction node changes imported road without changing its lanes', () => {
  const original = sample('2')
  const changed = clone(original)
  changed.vertices.splice(1, 0, { id: 'osm-node-3', lng: 104.0005, lat: 52.0005 })
  assert.equal(classifyRoads([changed], [original], ['2']).byId.get(changed.id), 'modified')
})

test('changing OSM tags key order does not incorrectly mark a road modified', () => {
  const original = sample('3')
  const same = clone(original)
  same.tags = { lanes: '2', highway: 'residential' }
  assert.equal(classifyRoads([same], [original], ['3']).byId.get(same.id), 'imported')
})

test('source IDs distinguish imported negative IDs from newly created IDs', () => {
  const original = sample('-100', 'import-negative')
  const added = sample('-101', 'new-negative')
  const statuses = classifyRoads([original, added], [original], ['-100'])
  assert.equal(statuses.byId.get(original.id), 'imported')
  assert.equal(statuses.byId.get(added.id), 'created')
})

test('2D contours follow both outside edges and do not duplicate OSM geometry', () => {
  const road = sample('9')
  road.lanes = 5
  const edges = roadStatusEdges([road], new Map([[road.id, 'modified']]))
  assert.equal(edges.length, 2)
  assert.deepEqual(edges.map(e => e.properties.side), [-1, 1])
  assert.ok(edges.every(e => e.properties.status === 'modified' && e.properties.lanes === 5))
  assert.deepEqual(edges[0]!.geometry.coordinates, road.vertices.map(v => [v.lng, v.lat]))
})

test('empty project starts without statuses or phantom imported roads', () => {
  const statuses = classifyRoads([], [], [])
  assert.equal(statuses.byId.size, 0)
  assert.deepEqual(statuses.counts, { imported: 0, created: 0, modified: 0 })
})
