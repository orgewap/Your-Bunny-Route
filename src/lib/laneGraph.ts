import type { RoadFeature, RoadVertex } from '../types/road'
import { clampRoadLanes, LANE_WIDTH_METRES, laneDirections } from './lanes.ts'
import { offsetRoadPolyline, surfaceNetwork } from './roadSurface.ts'
import { distanceMetres, isTrafficRoad } from './topology.ts'

export type LaneFlow = 'forward' | 'backward' | 'shared'
export type LaneTurn = 'straight' | 'left' | 'right'
export interface LaneGraphEdge {
  id: string
  roadId: string
  laneIndex: number
  count: number
  level: number
  flow: LaneFlow
  coordinates: RoadVertex[]
}
export interface LaneGraphNode {
  id: string
  nodeId: string
  roadId: string
  laneIndex: number
  point: RoadVertex
  junction: boolean
  level: number
}
export interface LaneGraphConnection {
  id: string
  junctionId: string
  fromRoad: string
  fromLane: number
  toRoad: string
  toLane: number
  level: number
  turn: LaneTurn
  coordinates: RoadVertex[]
}
export interface LaneGraph {
  edges: LaneGraphEdge[]
  nodes: LaneGraphNode[]
  connections: LaneGraphConnection[]
  junctionCount: number
}

function key(nodeId: string, level: number): string { return `${nodeId}@${level}` }
function flowOf(road: RoadFeature, index: number): LaneFlow {
  const { backward } = laneDirections(road)
  if (!road.oneway && clampRoadLanes(road.lanes) === 1) return 'shared'
  // In right-hand traffic forward lanes occupy the right-hand side of a way.
  return index < backward ? 'backward' : 'forward'
}
function metresBetween(a: RoadVertex, b: RoadVertex): [number, number] {
  const lat = (a.lat + b.lat) / 2 * Math.PI / 180
  return [(b.lng - a.lng) * 111_320 * Math.cos(lat), (b.lat - a.lat) * 111_320]
}
function portPoint(node: RoadVertex, neighbour: RoadVertex, wayTangent: [number, number], laneOffset: number): RoadVertex {
  const [dx, dy] = metresBetween(node, neighbour)
  const length = Math.hypot(dx, dy) || 1
  const tangentLength = Math.hypot(...wayTangent) || 1
  const inwardDistance = Math.min(8, length * 0.35)
  const sideX = wayTangent[1] / tangentLength * laneOffset
  const sideY = -wayTangent[0] / tangentLength * laneOffset
  const east = dx / length * inwardDistance + sideX
  const north = dy / length * inwardDistance + sideY
  const lngScale = 111_320 * Math.max(0.01, Math.cos(node.lat * Math.PI / 180))
  return { id: node.id, lng: node.lng + east / lngScale, lat: node.lat + north / 111_320 }
}
interface Port {
  id: string
  nodeId: string
  roadId: string
  laneIndex: number
  arm: string
  point: RoadVertex
  dx: number
  dy: number
  kind: 'in' | 'out'
  level: number
  tags: Record<string, string>
  flow: LaneFlow
  directionalIndex: number
  directionalCount: number
}
function allowedByLaneTag(port: Port, turn: LaneTurn): boolean {
  let value = port.flow === 'forward'
    ? port.tags['turn:lanes:forward'] ?? port.tags['turn:lanes']
    : port.tags['turn:lanes:backward'] ?? (port.flow === 'shared' ? port.tags['turn:lanes'] : undefined)
  if (!value) return true
  const tokens = value.split('|')
  if (tokens.length !== port.directionalCount) return true // malformed source: never infer a ban
  const text = (tokens[port.directionalIndex] ?? '').toLowerCase()
  if (!text || text.includes('none')) return true
  const turns = text.split(';').map(s => s.trim())
  if (turn === 'straight') return turns.some(s => s === 'through')
  if (turn === 'left') return turns.some(s => s.includes('left') || s === 'merge_to_left')
  return turns.some(s => s.includes('right') || s === 'merge_to_right')
}
function turnDirection(incoming: Port, outgoing: Port): LaneTurn | null {
  const a = [-incoming.dx, -incoming.dy]
  const b = [outgoing.dx, outgoing.dy]
  const angle = Math.atan2(a[0]! * b[1]! - a[1]! * b[0]!, a[0]! * b[0]! + a[1]! * b[1]!)
  // Strong U turns are excluded from automatic suggestions.
  if (Math.abs(angle) > Math.PI * 0.82) return null
  if (Math.abs(angle) < Math.PI * 0.23) return 'straight'
  return angle > 0 ? 'left' : 'right'
}
function curve(from: RoadVertex, control: RoadVertex, to: RoadVertex): RoadVertex[] {
  const result: RoadVertex[] = []
  for (let i = 0; i <= 10; i++) {
    const t = i / 10, s = 1 - t
    result.push({ id: `curve-${i}`, lng: s*s*from.lng + 2*s*t*control.lng + t*t*to.lng,
      lat: s*s*from.lat + 2*s*t*control.lat + t*t*to.lat })
  }
  return result
}

export interface LaneGraphOptions {
  viewport?: { west: number; east: number; south: number; north: number }
  connectionRoadId?: string
  maxConnections?: number
}

/**
 * A derived, non-destructive lane graph. Shared OSM node IDs are its junctions;
 * overlapping coordinates without an OSM node, or different bridge levels,
 * NEVER introduce connections. No separate OSM way is created per lane.
 */
export function buildLaneGraph(roads: readonly RoadFeature[], options: LaneGraphOptions = {}): LaneGraph {
  const eligible = roads.filter(road => isTrafficRoad(road) && road.vertices.length >= 2)
  const surfaces = new Map(surfaceNetwork(eligible).map(road => [road.id, road.vertices]))
  const owners = new Map<string, Set<string>>()
  for (const road of eligible) for (const v of road.vertices) {
    const k = key(v.id, road.level)
    if (!owners.has(k)) owners.set(k, new Set())
    owners.get(k)!.add(road.id)
  }
  const edges: LaneGraphEdge[] = []
  const nodes: LaneGraphNode[] = []
  const ports = new Map<string, Port[]>()
  for (const road of eligible) {
    const count = clampRoadLanes(road.lanes)
    const surface = surfaces.get(road.id)!
    for (let laneIndex = 0; laneIndex < count; laneIndex++) {
      const flow = flowOf(road, laneIndex)
      const offset = (laneIndex - (count - 1) / 2) * LANE_WIDTH_METRES
      const fullOffset = offsetRoadPolyline(road.vertices, offset)
      const surfaceOffset = offsetRoadPolyline(surface, offset)
      edges.push({ id: `${road.id}:lane:${laneIndex}`, roadId: road.id, laneIndex,
        count, level: road.level, flow, coordinates: surfaceOffset })
      for (let i = 0; i < road.vertices.length; i++) {
        const vertex = road.vertices[i]!
        const nodeKey = key(vertex.id, road.level)
        const shared = (owners.get(nodeKey)?.size ?? 0) > 1
        if (!shared && i !== 0 && i !== road.vertices.length - 1) continue
        const coord = i === 0 && surface[0]?.id !== vertex.id
          ? surfaceOffset[0]!
          : i === road.vertices.length - 1 && surface[surface.length - 1]?.id !== vertex.id
            ? surfaceOffset[surfaceOffset.length - 1]!
            : fullOffset[i]!
        nodes.push({ id: `${road.id}:${i}:${laneIndex}`, nodeId: vertex.id, roadId: road.id,
          laneIndex, point: coord, junction: shared, level: road.level })
        if (!shared) continue
        if (options.viewport) {
          const { west, east, south, north } = options.viewport
          if (vertex.lng < west || vertex.lng > east || vertex.lat < south || vertex.lat > north) continue
        }
        if (options.maxConnections === 0) continue
        for (const side of [-1, 1] as const) {
          const otherIndex = i + side
          if (otherIndex < 0 || otherIndex >= road.vertices.length) continue
          const hiddenApproach =
            (i === 0 && side === 1 && road.visualApproach?.start) ||
            (i === road.vertices.length - 1 && side === -1 && road.visualApproach?.end)
          // The first short OSM segment connects the shared OSM node with the
          // physical edge of a receiving carriageway. It is not a traffic lane.
          const roadOrigin = hiddenApproach ? road.vertices[otherIndex]! : vertex
          const physicalNeighbourIndex = hiddenApproach ? otherIndex + side : otherIndex
          const adjacent = road.vertices[physicalNeighbourIndex]
          if (!adjacent || distanceMetres(roadOrigin, adjacent) < 0.2) continue
          const wayStart = side === 1 ? roadOrigin : adjacent
          const wayEnd = side === 1 ? adjacent : roadOrigin
          const tangent = metresBetween(wayStart, wayEnd)
          const outward = metresBetween(roadOrigin, adjacent)
          const magnitude = Math.hypot(...outward) || 1
          const direction = side === 1 ? 'forward' : 'backward'
          const allowedFlow = flow === 'shared' ? [direction, direction === 'forward' ? 'backward' : 'forward'] : [flow]
          const directional = laneDirections(road)
          for (const oneFlow of allowedFlow) {
            const kind: 'in' | 'out' = oneFlow === direction ? 'out' : 'in'
            const laneIndicesInDirection = oneFlow === 'forward'
              ? Array.from({ length: directional.forward }, (_, k) => k + directional.backward)
              : Array.from({ length: directional.backward }, (_, k) => directional.backward - 1 - k)
            const directionalIndex = Math.max(0, laneIndicesInDirection.indexOf(laneIndex))
            const list = ports.get(nodeKey) ?? []
            list.push({ id: `${road.id}:${i}:${laneIndex}:${side}:${kind}`, nodeId: vertex.id,
              roadId: road.id, laneIndex, arm: `${road.id}:${i}:${side}`, level: road.level,
              point: portPoint(roadOrigin, adjacent, tangent, offset),
              dx: outward[0] / magnitude, dy: outward[1] / magnitude,
              kind, tags: road.tags, flow: oneFlow as LaneFlow,
              directionalIndex, directionalCount: Math.max(1, oneFlow === 'forward' ? directional.forward : directional.backward) })
            ports.set(nodeKey, list)
          }
        }
      }
    }
  }
  const connections: LaneGraphConnection[] = []
  for (const [junctionId, all] of ports) {
    const byRoad = new Set(all.map(p => p.roadId))
    if (byRoad.size < 2) continue
    const incoming = all.filter(p => p.kind === 'in')
    const outgoing = all.filter(p => p.kind === 'out')
    // For each inbound lane, suggest ONE nearest-lane connection for each
    // outgoing arm, instead of producing a dense all-to-all spider web.
    for (const from of incoming) {
      const byArm = new Map<string, Port[]>()
      for (const to of outgoing) {
        if (to.arm === from.arm) continue
        const turn = turnDirection(from, to)
        if (!turn || !allowedByLaneTag(from, turn)) continue
        const list = byArm.get(to.arm) ?? []
        list.push(to)
        byArm.set(to.arm, list)
      }
      for (const toCandidates of byArm.values()) {
        if (connections.length >= (options.maxConnections ?? Number.POSITIVE_INFINITY)) break
        const fromNorm = (from.directionalIndex + 0.5) / Math.max(1, from.directionalCount)
        const to = toCandidates.sort((a,b) => {
          const da = Math.abs((a.directionalIndex + 0.5) / a.directionalCount - fromNorm)
          const db = Math.abs((b.directionalIndex + 0.5) / b.directionalCount - fromNorm)
          return da - db
        })[0]!
        const turn = turnDirection(from, to)!
        if (options.connectionRoadId && from.roadId !== options.connectionRoadId && to.roadId !== options.connectionRoadId) continue
        const point = roads.find(r => r.id === from.roadId)?.vertices.find(v => v.id === from.nodeId)
        if (!point) continue
        connections.push({ id: `${from.id}->${to.id}`, junctionId,
          fromRoad: from.roadId, fromLane: from.laneIndex,
          toRoad: to.roadId, toLane: to.laneIndex,
          level: from.level, turn, coordinates: curve(from.point, point, to.point) })
      }
    }
  }
  return { edges, nodes, connections, junctionCount: [...owners.values()].filter(set => set.size > 1).length }
}
