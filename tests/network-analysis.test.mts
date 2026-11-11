import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeRoadNetwork } from '../src/lib/networkAnalysis.ts'
import type { RoadFeature, RoadVertex } from '../src/types/road.ts'

const v = (id: string, x: number, y = 0): RoadVertex => ({
  id, lng: x / 111_320, lat: y / 111_320,
})
function road(id: string, osmId: string, vertices: RoadVertex[], tags: Record<string, string> = {}, level = 0): RoadFeature {
  return { id, osmId, name: '', highway: tags.highway ?? 'residential', lanes: 2,
    oneway: false, bridge: level > 0, level, vertices, tags }
}

const imported = road('imported', '100', [v('a', 0), v('b', 40)])

test('new road with two free ends is critical and appears in the map severity index', () => {
  const isolated = road('new', '-1', [v('c', 100), v('d', 140)])
  const result = analyzeRoadNetwork([imported, isolated], [imported])
  assert.equal(result.counts.critical, 1)
  assert.equal(result.issues[0]?.kind, 'isolated-road')
  assert.equal(result.severityByRoadId.new, 'critical')
  assert.equal(result.issues[0]?.openEnds, 2)
})

test('road connected at both ends to the existing network is not flagged', () => {
  const left = road('left', '101', [v('a', -30), v('b', 0)])
  const right = road('right', '102', [v('c', 40), v('d', 70)])
  const link = road('link', '-1', [v('b', 0), v('c', 40)])
  const result = analyzeRoadNetwork([left, right, link], [left, right])
  assert.equal(result.counts.critical, 0)
  assert.equal(result.counts.warning, 0)
  assert.equal(result.severityByRoadId.link, undefined)
})

test('a road attached to the network at one end is not a problem just because the other end is open', () => {
  const extension = road('extension', '-1', [v('b', 40), v('c', 85)])
  const result = analyzeRoadNetwork([imported, extension], [imported])
  assert.equal(result.counts.critical, 0)
  assert.equal(result.counts.warning, 0)
  assert.equal(result.counts.info, 0)
  assert.equal(result.issues.length, 0)
  assert.equal(result.severityByRoadId.extension, undefined)
  assert.equal(result.markers.length, 0)
})


test('large pre-existing connected OSM area is informational, not a disconnected-network warning', () => {
  const main = Array.from({ length: 30 }, (_, i) =>
    road(`main-${i}`, String(1000 + i), [v(`m${i}`, i * 60), v(`m${i + 1}`, (i + 1) * 60)]))
  const district = Array.from({ length: 25 }, (_, i) =>
    road(`district-${i}`, String(2000 + i), [v(`d${i}`, 10_000 + i * 60), v(`d${i + 1}`, 10_000 + (i + 1) * 60)]))
  const roads = [...main, ...district]
  const result = analyzeRoadNetwork(roads, roads)
  const issue = result.issues.find(item => item.roadIds.includes('district-0'))
  assert.ok(issue)
  assert.equal(issue?.severity, 'info')
  assert.equal(issue?.title, 'Самостоятельная связная сеть')
  assert.equal(result.counts.warning, 0)
  assert.equal(result.counts.critical, 0)
  assert.equal(result.counts.info, 1)
  assert.equal(result.severityByRoadId['district-0'], undefined)
  assert.equal(result.affectedRoadCount, 0)
})

test('a closed roundabout without any external road connection is critical', () => {
  const ring = road('ring', '-4', [v('r1', 0), v('r2', 20, 20), v('r3', 40), v('r4', 20, -20), v('r1', 0)], { junction: 'roundabout' })
  const result = analyzeRoadNetwork([imported, ring], [imported])
  assert.equal(result.issues.some(issue => issue.kind === 'isolated-roundabout' && issue.severity === 'critical'), true)
  assert.equal(result.severityByRoadId.ring, 'critical')
})

test('a connected cluster of newly drawn roads detached from the imported network is one critical issue', () => {
  const first = road('cluster-a', '-1', [v('c', 100), v('d', 140)])
  const second = road('cluster-b', '-2', [v('d', 140), v('e', 180)])
  const result = analyzeRoadNetwork([imported, first, second], [imported])
  const disconnected = result.issues.find(issue => issue.kind === 'disconnected-component')
  assert.ok(disconnected)
  assert.equal(disconnected?.severity, 'critical')
  assert.deepEqual(new Set(disconnected?.roadIds), new Set(['cluster-a', 'cluster-b']))
})

test('a bridge crossing a ground road at the same XY node but on another level is not connected', () => {
  const ground = road('ground', '100', [v('ground-a', 0), v('shared-xy', 40)])
  const bridge = road('bridge', '-1', [v('shared-xy', 40), v('bridge-b', 80)], { bridge: 'yes', layer: '1' }, 1)
  const result = analyzeRoadNetwork([ground, bridge], [ground])
  assert.equal(result.severityByRoadId.bridge, 'critical')
})

test('an isolated imported road is still surfaced as a warning', () => {
  const result = analyzeRoadNetwork([imported], [imported])
  assert.equal(result.counts.critical, 0)
  assert.equal(result.counts.warning, 1)
  assert.equal(result.counts.info, 0)
  assert.equal(result.severityByRoadId.imported, 'warning')
})

test('a private driveway attached to the network is not flagged for its normal free end', () => {
  const driveway = road('driveway', '-1', [v('b', 40), v('c', 65)], { service: 'driveway', access: 'private' })
  const result = analyzeRoadNetwork([imported, driveway], [imported])
  assert.equal(result.counts.warning, 0)
  assert.equal(result.counts.info, 0)
  assert.equal(result.issues.length, 0)
})

test('pedestrian-only ways are excluded from the first car-network analysis', () => {
  const footway = road('foot', '-1', [v('x', 0, 50), v('y', 30, 50)], { highway: 'footway' })
  const result = analyzeRoadNetwork([footway], [])
  assert.equal(result.roadCount, 0)
  assert.equal(result.issues.length, 0)
})


test('editing only road tags does not make an unchanged imported isolated segment a critical topology error', () => {
  const retagged = { ...imported, name: 'Updated label', tags: { ...imported.tags, surface: 'asphalt' } }
  const result = analyzeRoadNetwork([retagged], [imported])
  assert.equal(result.counts.critical, 0)
  assert.equal(result.counts.warning, 1)
  assert.equal(result.counts.info, 0)
})


test('disconnected imported components are warnings instead of being hidden as information', () => {
  const main = road('main', '100', [v('a', 0), v('b', 40)])
  const mainB = road('main-b', '101', [v('b', 40), v('c', 80)])
  const mainC = road('main-c', '102', [v('c', 80), v('d', 120)])
  const detachedA = road('detached-a', '200', [v('x', 300), v('y', 340)])
  const detachedB = road('detached-b', '201', [v('y', 340), v('z', 380)])
  const roads = [main, mainB, mainC, detachedA, detachedB]
  const result = analyzeRoadNetwork(roads, roads)
  const issue = result.issues.find(item => item.kind === 'disconnected-component')
  assert.ok(issue)
  assert.equal(issue?.severity, 'warning')
  assert.deepEqual(new Set(issue?.roadIds), new Set(['detached-a', 'detached-b']))
  assert.equal(result.mainComponentRoadCount, 3)
  assert.equal(result.affectedRoadCount, 2)
})

test('free endpoint close to another same-level road marks only the endpoint and target point', () => {
  const main = road('main', '100', [v('a', 0), v('b', 40)])
  const attached = road('attached', '-1', [v('b', 40), v('near-end', 42, 2)])
  const result = analyzeRoadNetwork([main, attached], [main])
  const issue = result.issues.find(item => item.kind === 'near-miss-connection')
  assert.ok(issue)
  assert.equal(issue?.severity, 'warning')
  assert.deepEqual(new Set(issue?.roadIds), new Set(['main', 'attached']))
  assert.equal(result.severityByRoadId.main, undefined)
  assert.equal(result.severityByRoadId.attached, undefined)
  assert.equal(result.markers.some(marker => marker.role === 'open-end' && marker.coordinates[0] === v('near-end', 42, 2).lng), true)
  assert.equal(result.markers.some(marker => marker.role === 'near-target'), true)
  assert.equal(result.gaps.length, 1)
  assert.match(issue?.description ?? '', /2\.8 м/)
})

test('a connected road with a free endpoint far from other roads is not highlighted', () => {
  const extension = road('extension', '-2', [v('b', 40), v('free', 85)])
  const result = analyzeRoadNetwork([imported, extension], [imported])
  assert.equal(result.issues.some(issue => issue.roadIds.includes('extension')), false)
  assert.equal(result.markers.length, 0)
  assert.equal(result.gaps.length, 0)
})

test('nearby road on another level is not reported as a missed connection', () => {
  const ground = road('ground', '100', [v('ground-a', 0), v('ground-b', 40)])
  const bridge = road('bridge', '-1', [v('bridge-a', 42, 2), v('bridge-b', 80, 2)], { bridge: 'yes', layer: '1' }, 1)
  const result = analyzeRoadNetwork([ground, bridge], [ground])
  assert.equal(result.issues.some(item => item.kind === 'near-miss-connection'), false)
})

test('intentional isolated private access remains informational', () => {
  const main = road('main', '100', [v('a', 0), v('b', 40)])
  const driveway = road('driveway', '200', [v('x', 200), v('y', 240)], { service: 'driveway', access: 'private' })
  const result = analyzeRoadNetwork([main, driveway], [main, driveway])
  const issue = result.issues.find(item => item.roadIds.includes('driveway'))
  assert.equal(issue?.severity, 'info')
})


test('new isolated private access is informational instead of critical', () => {
  const driveway = road('new-driveway', '-9', [v('private-a', 200), v('private-b', 240)], { service: 'driveway', access: 'private' })
  const result = analyzeRoadNetwork([imported, driveway], [imported])
  const issue = result.issues.find(item => item.roadIds.includes('new-driveway'))
  assert.equal(issue?.severity, 'info')
})
