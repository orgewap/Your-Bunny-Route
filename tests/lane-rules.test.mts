import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getLaneTurnRules, laneDirectionPosition, withLaneTurnRules } from '../src/lib/laneRules.ts'
import type { RoadFeature } from '../src/types/road.ts'

const r = (lanes: number, oneway = false): RoadFeature => ({
  id: 'road', osmId: '42', name: '', lanes, oneway, highway: 'residential', bridge: false,
  level: 0, vertices: [], tags: {},
})
test('four lanes map to OSM turn:lanes direction and right-hand order', () => {
  const road = r(4)
  assert.deepEqual(laneDirectionPosition(road, 0), { flow: 'backward', tag: 'turn:lanes:backward', index: 1, count: 2 })
  assert.deepEqual(laneDirectionPosition(road, 1), { flow: 'backward', tag: 'turn:lanes:backward', index: 0, count: 2 })
  assert.deepEqual(laneDirectionPosition(road, 2), { flow: 'forward', tag: 'turn:lanes:forward', index: 0, count: 2 })
  assert.deepEqual(laneDirectionPosition(road, 3), { flow: 'forward', tag: 'turn:lanes:forward', index: 1, count: 2 })
})
test('changing only outer forward lane writes legal standard turn:lanes tag', () => {
  const road = r(4)
  const first = withLaneTurnRules(road, 3, ['right'])
  assert.equal(first['turn:lanes:forward'], 'none|right')
  assert.deepEqual(road.tags, {}, 'pure update does not mutate original road')
  road.tags = first
  const second = withLaneTurnRules(road, 2, ['through', 'left'])
  assert.equal(second['turn:lanes:forward'], 'left;through|right')
  road.tags = second
  assert.deepEqual(getLaneTurnRules(road, 3), ['right'])
  assert.deepEqual(getLaneTurnRules(road, 2), ['left', 'through'])
})
test('one-way OSM uses turn:lanes, reverse oneway uses physical reversed order', () => {
  const one = r(3, true)
  const tags = withLaneTurnRules(one, 2, ['right'])
  assert.equal(tags['turn:lanes'], 'none|none|right')
  const reverse = r(3, true)
  reverse.tags.oneway = '-1'
  assert.equal(laneDirectionPosition(reverse, 0)?.index, 2)
  assert.equal(laneDirectionPosition(reverse, 2)?.index, 0)
})
test('invalid direction configurations are rejected before editing source', () => {
  assert.equal(laneDirectionPosition(r(1), 0), null)
  assert.throws(() => withLaneTurnRules(r(1), 0, ['through']), /общей полосы/)
  assert.throws(() => withLaneTurnRules(r(4), 0, []), /хотя бы/)
  assert.equal(laneDirectionPosition(r(4), 10), null)
})
