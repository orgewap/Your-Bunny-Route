import type { RoadFeature } from '../types/road'
import { roadLengthMeters } from './geometry.ts'
import { distanceMetres, isTrafficRoad } from './topology.ts'

export type RoadIssueSeverity = 'critical' | 'warning' | 'info'
export type RoadIssueKind = 'isolated-road' | 'isolated-roundabout' | 'isolated-loop' | 'disconnected-component' | 'near-miss-connection'

export interface RoadNetworkIssue {
  id: string
  kind: RoadIssueKind
  severity: RoadIssueSeverity
  title: string
  description: string
  roadIds: string[]
  roadCount: number
  openEnds: number
  lengthMetres: number
}

export interface RoadNetworkMarker {
  id: string
  severity: RoadIssueSeverity
  role: 'open-end' | 'near-target'
  coordinates: [number, number]
}

export interface RoadNetworkGap {
  id: string
  severity: RoadIssueSeverity
  coordinates: [[number, number], [number, number]]
}

export interface RoadNetworkAnalysis {
  roadCount: number
  componentCount: number
  mainComponentRoadCount: number
  affectedRoadCount: number
  counts: Record<RoadIssueSeverity, number>
  severityByRoadId: Record<string, RoadIssueSeverity>
  issues: RoadNetworkIssue[]
  markers: RoadNetworkMarker[]
  gaps: RoadNetworkGap[]
}

const severityRank: Record<RoadIssueSeverity, number> = { critical: 3, warning: 2, info: 1 }
const nodeKey = (level: number, nodeId: string) => `${level}\u0000${nodeId}`
const NEAR_CONNECTION_METRES = 4
// Large, pre-existing connected OSM areas are often separate map extracts or
// districts. They are not road defects merely because another area is larger.
const ESTABLISHED_COMPONENT_MIN_ROADS = 20
const ESTABLISHED_COMPONENT_MIN_LENGTH_METRES = 1_000
const SEGMENT_GRID_CELL_METRES = 50
const METRES_PER_DEGREE = 111_320

function isClosedWay(road: RoadFeature): boolean {
  if (road.vertices.length < 4) return false
  const first = road.vertices[0]!
  const last = road.vertices[road.vertices.length - 1]!
  return first.id === last.id || distanceMetres(first, last) <= 0.75
}

function isRoundabout(road: RoadFeature): boolean {
  return road.tags.junction === 'roundabout' || road.tags.junction === 'circular'
}

function isIntentionalAccess(road: RoadFeature): boolean {
  return road.tags.noexit === 'yes' || road.tags.service === 'driveway' || road.tags.access === 'private'
}

function sameRoadTopology(a: RoadFeature, b: RoadFeature): boolean {
  if (a.level !== b.level || a.vertices.length !== b.vertices.length) return false
  return a.vertices.every((vertex, index) => {
    const baseline = b.vertices[index]!
    return vertex.id === baseline.id && vertex.lng === baseline.lng && vertex.lat === baseline.lat
  })
}

interface IndexedSegment {
  roadId: string
  level: number
  a: RoadFeature['vertices'][number]
  b: RoadFeature['vertices'][number]
}

function metricPoint(point: RoadFeature['vertices'][number], referenceLat: number): [number, number] {
  return [point.lng * METRES_PER_DEGREE * Math.cos(referenceLat * Math.PI / 180), point.lat * METRES_PER_DEGREE]
}

function projectPointToSegment(point: RoadFeature['vertices'][number], segment: IndexedSegment, referenceLat: number): {
  distance: number
  coordinates: [number, number]
} {
  const [px, py] = metricPoint(point, referenceLat)
  const [ax, ay] = metricPoint(segment.a, referenceLat)
  const [bx, by] = metricPoint(segment.b, referenceLat)
  const dx = bx - ax, dy = by - ay
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)))
  return {
    distance: Math.hypot(px - (ax + dx * t), py - (ay + dy * t)),
    coordinates: [
      segment.a.lng + (segment.b.lng - segment.a.lng) * t,
      segment.a.lat + (segment.b.lat - segment.a.lat) * t,
    ],
  }
}

function gridKey(x: number, y: number): string { return `${x}:${y}` }

/**
 * Index road segments in a coarse metric grid. The proximity pass only checks
 * the 3x3 cells around free endpoints, avoiding an all-roads x all-segments scan.
 */
function buildSegmentGrid(roads: readonly RoadFeature[], referenceLat: number): Map<string, IndexedSegment[]> {
  const grid = new Map<string, IndexedSegment[]>()
  const add = (x: number, y: number, segment: IndexedSegment) => {
    const key = gridKey(x, y)
    let bucket = grid.get(key)
    if (!bucket) grid.set(key, bucket = [])
    bucket.push(segment)
  }
  const cellSize = SEGMENT_GRID_CELL_METRES
  for (const road of roads) {
    for (let i = 1; i < road.vertices.length; i++) {
      const segment: IndexedSegment = { roadId: road.id, level: road.level, a: road.vertices[i - 1]!, b: road.vertices[i]! }
      const [ax, ay] = metricPoint(segment.a, referenceLat)
      const [bx, by] = metricPoint(segment.b, referenceLat)
      const minX = Math.floor(Math.min(ax, bx) / cellSize)
      const maxX = Math.floor(Math.max(ax, bx) / cellSize)
      const minY = Math.floor(Math.min(ay, by) / cellSize)
      const maxY = Math.floor(Math.max(ay, by) / cellSize)
      const cells = (maxX - minX + 1) * (maxY - minY + 1)
      if (cells <= 500) {
        for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) add(x, y, segment)
      } else {
        // Very long OSM segments: sample along their length instead of filling
        // a huge rectangular bounding box.
        const length = Math.hypot(bx - ax, by - ay)
        const steps = Math.max(1, Math.ceil(length / (cellSize * 0.5)))
        for (let step = 0; step <= steps; step++) {
          const t = step / steps
          add(Math.floor((ax + (bx - ax) * t) / cellSize), Math.floor((ay + (by - ay) * t) / cellSize), segment)
        }
      }
    }
  }
  return grid
}

interface NearConnection {
  roadId: string
  nearbyRoadId: string
  endpointIndex: number
  distance: number
  endpoint: [number, number]
  target: [number, number]
}

/** Find free endpoints close to another same-level road but lacking a shared OSM node. */
function findNearConnections(
  roads: readonly RoadFeature[],
  ownersByNode: ReadonlyMap<string, Set<string>>,
): NearConnection[] {
  if (!roads.length) return []
  const latitudes = roads.flatMap(road => road.vertices.map(vertex => vertex.lat))
  const referenceLat = latitudes.reduce((sum, value) => sum + value, 0) / latitudes.length
  const grid = buildSegmentGrid(roads, referenceLat)
  const cellSize = SEGMENT_GRID_CELL_METRES
  const found = new Map<string, NearConnection>()
  for (const road of roads) {
    const endpoints = [road.vertices[0]!, road.vertices[road.vertices.length - 1]!]
    for (let endpointIndex = 0; endpointIndex < endpoints.length; endpointIndex++) {
      const endpoint = endpoints[endpointIndex]!
      const owners = ownersByNode.get(nodeKey(road.level, endpoint.id))
      if (owners && [...owners].some(id => id !== road.id)) continue
      const [x, y] = metricPoint(endpoint, referenceLat)
      const cellX = Math.floor(x / cellSize), cellY = Math.floor(y / cellSize)
      let nearest: NearConnection | null = null
      const candidates = new Set<IndexedSegment>()
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const segment of grid.get(gridKey(cellX + dx, cellY + dy)) ?? []) candidates.add(segment)
      }
      for (const segment of candidates) {
        if (segment.roadId === road.id || segment.level !== road.level) continue
        const projection = projectPointToSegment(endpoint, segment, referenceLat)
        const distance = projection.distance
        if (distance > NEAR_CONNECTION_METRES || (nearest && distance >= nearest.distance)) continue
        nearest = {
          roadId: road.id,
          nearbyRoadId: segment.roadId,
          endpointIndex,
          distance,
          endpoint: [endpoint.lng, endpoint.lat],
          target: projection.coordinates,
        }
      }
      if (!nearest) continue
      const pair = [nearest.roadId, nearest.nearbyRoadId].sort()
      const key = `${pair[0]}\u0000${pair[1]}`
      const previous = found.get(key)
      if (!previous || nearest.distance < previous.distance) found.set(key, nearest)
    }
  }
  return [...found.values()]
}

/**
 * Inspect only real OSM graph connections: roads connect when they share an
 * OSM/editor node ID on the same level. XY crossings and bridge/ground
 * overlaps are deliberately NOT treated as junctions.
 *
 * Detached imported components are reported as warnings, not silently
 * hidden: users need to review all disconnected fragments in the loaded map.
 * A separate endpoint-proximity pass detects likely missed connections to a
 * same-level road without inventing or writing an OSM junction.
 */
export function analyzeRoadNetwork(
  allRoads: readonly RoadFeature[],
  baselineRoads: readonly RoadFeature[] = [],
): RoadNetworkAnalysis {
  const roads = allRoads.filter(road => isTrafficRoad(road) && road.vertices.length >= 2)
  const baselineByOsmId = new Map(baselineRoads.map(road => [road.osmId, road]))
  const topologyEditedById = new Map(roads.map(road => {
    const baseline = baselineByOsmId.get(road.osmId)
    return [road.id, !baseline || !sameRoadTopology(road, baseline)] as const
  }))
  const roadById = new Map(roads.map(road => [road.id, road]))
  const ownersByNode = new Map<string, Set<string>>()
  const neighbours = new Map<string, Set<string>>(roads.map(road => [road.id, new Set<string>()]))

  for (const road of roads) {
    for (const vertex of road.vertices) {
      const key = nodeKey(road.level, vertex.id)
      let owners = ownersByNode.get(key)
      if (!owners) ownersByNode.set(key, owners = new Set())
      owners.add(road.id)
    }
  }
  for (const owners of ownersByNode.values()) {
    if (owners.size < 2) continue
    for (const roadId of owners) {
      const adjacent = neighbours.get(roadId)!
      for (const otherId of owners) if (otherId !== roadId) adjacent.add(otherId)
    }
  }

  const components: string[][] = []
  const visited = new Set<string>()
  for (const road of roads) {
    if (visited.has(road.id)) continue
    const component: string[] = []
    const queue = [road.id]
    visited.add(road.id)
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const current = queue[cursor]!
      component.push(current)
      for (const next of neighbours.get(current) ?? []) {
        if (visited.has(next)) continue
        visited.add(next)
        queue.push(next)
      }
    }
    components.push(component)
  }

  const componentStats = components.map(ids => {
    let totalLength = 0
    let stableLength = 0
    let stableCount = 0
    let editedCount = 0
    for (const id of ids) {
      const road = roadById.get(id)!
      const length = roadLengthMeters(road.vertices)
      totalLength += length
      if (topologyEditedById.get(id)) editedCount++
      else { stableCount++; stableLength += length }
    }
    return { ids, totalLength, stableLength, stableCount, editedCount }
  })

  // Prefer the component containing the most imported network. This prevents
  // a newly drawn, disconnected cluster from becoming the reference network
  // merely because it contains more roads than the original OSM component.
  const hasStableNetwork = componentStats.some(item => item.stableCount > 0)
  const main = [...componentStats].sort((a, b) => hasStableNetwork
    ? b.stableCount - a.stableCount || b.stableLength - a.stableLength || b.totalLength - a.totalLength
    : b.totalLength - a.totalLength)[0]
  const mainIds = new Set(main?.ids ?? [])

  const issues: RoadNetworkIssue[] = []
  const affectedRoadIds = new Set<string>()
  const severityByRoadId: Record<string, RoadIssueSeverity> = {}
  const markers: RoadNetworkMarker[] = []
  const gaps: RoadNetworkGap[] = []
  const addIssue = (issue: RoadNetworkIssue, paintRoads = true) => {
    issues.push(issue)
    for (const roadId of issue.roadIds) {
      if (issue.severity !== 'info') affectedRoadIds.add(roadId)
      if (!paintRoads) continue
      const current = severityByRoadId[roadId]
      if (!current || severityRank[issue.severity] > severityRank[current]) severityByRoadId[roadId] = issue.severity
    }
  }

  const nearConnections = findNearConnections(roads, ownersByNode)

  for (const component of componentStats) {
    const ids = component.ids
    const isMain = ids.every(id => mainIds.has(id))
    if (ids.length === 1) {
      const road = roadById.get(ids[0]!)!
      const topologyEdited = topologyEditedById.get(road.id) ?? false
      const closed = isClosedWay(road)
      if (closed) {
        const roundabout = isRoundabout(road)
        const severity: RoadIssueSeverity = topologyEdited ? 'critical' : 'warning'
        addIssue({
          id: `${roundabout ? 'isolated-roundabout' : 'isolated-loop'}:${road.id}`,
          kind: roundabout ? 'isolated-roundabout' : 'isolated-loop',
          severity,
          title: roundabout ? 'Изолированное кольцо' : 'Изолированная замкнутая дорога',
          description: 'Замкнутый участок не имеет ни одного соединения с другими дорогами. Транспорт не сможет попасть на кольцо из остальной сети.',
          roadIds: [road.id], roadCount: 1, openEnds: 0, lengthMetres: component.totalLength,
        })
      } else if (topologyEdited) {
        const intentional = isIntentionalAccess(road)
        addIssue({
          id: `isolated-road:${road.id}`, kind: 'isolated-road', severity: intentional ? 'info' : 'critical',
          title: intentional ? 'Отдельный подъезд' : 'Изолированная дорога',
          description: intentional
            ? 'Новый участок не подключён к сети, но его теги указывают на частный подъезд или намеренный тупик.'
            : 'Участок не соединён ни с одной другой дорогой: оба конца находятся отдельно от дорожной сети.',
          roadIds: [road.id], roadCount: 1, openEnds: 2, lengthMetres: component.totalLength,
        })
      } else {
        const intentional = isIntentionalAccess(road)
        addIssue({
          id: `isolated-road:${road.id}`, kind: 'isolated-road', severity: intentional ? 'info' : 'warning',
          title: intentional ? 'Отдельный подъезд исходного OSM' : 'Изолированный участок исходного OSM',
          description: intentional
            ? 'Участок не связан с остальной сетью, но его OSM-теги указывают на частный подъезд или намеренный тупик.'
            : 'Импортированный участок не имеет соединений с другими автомобильными дорогами. Проверьте, не потеряно ли соединение при подготовке OSM.',
          roadIds: [road.id], roadCount: 1, openEnds: 2, lengthMetres: component.totalLength,
        })
      }
      continue
    }

    if (!isMain) {
      const intentional = ids.every(id => isIntentionalAccess(roadById.get(id)!))
      const established = component.stableCount >= ESTABLISHED_COMPONENT_MIN_ROADS &&
        component.stableLength >= ESTABLISHED_COMPONENT_MIN_LENGTH_METRES

      if (established) {
        addIssue({
          id: `disconnected-component:${ids.slice().sort().join(',')}`,
          kind: 'disconnected-component', severity: 'info',
          title: 'Самостоятельная связная сеть',
          description: `Этот фрагмент содержит ${ids.length} связанных дорог и уже присутствовал в исходной сети OSM. Он связан внутри себя, но не соединён с крупнейшим компонентом карты. Само по себе это не ошибка отдельной дороги: возможно, это другой район или отдельная область загруженной карты.`,
          roadIds: ids, roadCount: ids.length, openEnds: 0, lengthMetres: component.totalLength,
        }, false)
        continue
      }

      const severity: RoadIssueSeverity = intentional ? 'info' : component.editedCount > 0 ? 'critical' : 'warning'
      addIssue({
        id: `disconnected-component:${ids.slice().sort().join(',')}`,
        kind: 'disconnected-component', severity,
        title: intentional ? 'Отдельный фрагмент подъездов' : 'Отдельный фрагмент дорожной сети',
        description: intentional
          ? 'Фрагмент состоит из дорог с тегами частного или намеренного подъезда и не подключён к основной сети.'
          : component.editedCount > 0
            ? 'Несколько дорог соединены между собой, но весь новый или изменённый фрагмент не имеет связи с основной импортированной сетью.'
            : 'Небольшой импортированный фрагмент отделён от основной автомобильной сети. Проверьте соединения и уровни дорог; это может быть отдельная территория или ошибка топологии.',
        roadIds: ids, roadCount: ids.length, openEnds: 0, lengthMetres: component.totalLength,
      })
      continue
    }
  }

  // A free endpoint alone is not a connectivity defect. Roads connected to the
  // network at one end may legitimately be cul-de-sacs, entrances, map-boundary
  // continuations, or service spurs. Do not flag or tint them merely because the
  // other endpoint has no shared node. A likely missed junction is reported by
  // the proximity pass below when that endpoint is close to another same-level
  // road but lacks the shared OSM node.

  // A free endpoint can be visually next to a road yet still be disconnected
  // because its OSM node ID was never shared. Mark only the endpoint, the
  // nearest point on the target road, and the short gap between them. Never
  // tint either complete road and never auto-snap or rewrite OSM topology.
  for (const near of nearConnections) {
    const road = roadById.get(near.roadId)!
    const nearbyRoad = roadById.get(near.nearbyRoadId)!
    const intentional = isIntentionalAccess(road)
    const issueId = `near-miss:${[near.roadId, near.nearbyRoadId].sort().join(':')}`
    addIssue({
      id: issueId,
      kind: 'near-miss-connection',
      severity: intentional ? 'info' : 'warning',
      title: 'Рядом есть дорога, но нет соединения',
      description: `Свободный конец участка находится примерно в ${near.distance.toFixed(1)} м от «${nearbyRoad.name.trim() || `дороги ${nearbyRoad.osmId}`}» на том же уровне, но общего OSM-узла нет. Возможно, здесь пропущено соединение.`,
      roadIds: [near.roadId, near.nearbyRoadId], roadCount: 2, openEnds: 1,
      lengthMetres: roadLengthMeters(road.vertices),
    }, false)
    markers.push(
      { id: `${issueId}:endpoint`, severity: intentional ? 'info' : 'warning', role: 'open-end', coordinates: near.endpoint },
      { id: `${issueId}:target`, severity: intentional ? 'info' : 'warning', role: 'near-target', coordinates: near.target },
    )
    gaps.push({ id: `${issueId}:gap`, severity: intentional ? 'info' : 'warning', coordinates: [near.endpoint, near.target] })
  }

  const severityOrder: Record<RoadIssueSeverity, number> = { critical: 0, warning: 1, info: 2 }
  issues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] ||
    b.lengthMetres - a.lengthMetres || a.title.localeCompare(b.title, 'ru'))
  const counts: Record<RoadIssueSeverity, number> = { critical: 0, warning: 0, info: 0 }
  for (const issue of issues) counts[issue.severity]++

  return {
    roadCount: roads.length,
    componentCount: components.length,
    mainComponentRoadCount: main?.ids.length ?? 0,
    affectedRoadCount: affectedRoadIds.size,
    counts,
    severityByRoadId,
    issues,
    markers,
    gaps,
  }
}
