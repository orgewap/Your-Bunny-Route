import type { RoadFeature, RoadVertex } from '../types/road'
import { isTrafficRoad, distanceMetres } from './topology.ts'

export const PEDESTRIAN_HIGHWAYS = new Set(['footway', 'path', 'pedestrian', 'steps', 'corridor', 'platform', 'bridleway', 'cycleway'])

/** Read OSM tunnel/layer tags, not the editor's bridge height. Never change node IDs. */
export function isUndergroundPedestrianWay(road: RoadFeature): boolean {
  if (!isPedestrianWay(road)) return false
  const tunnel = (road.tags.tunnel ?? '').toLowerCase()
  const location = (road.tags.location ?? '').toLowerCase()
  const layer = Number(road.tags.layer ?? 0)
  const floor = Number(road.tags.level ?? 0)
  return (tunnel !== '' && tunnel !== 'no' && tunnel !== '0') ||
    location === 'underground' ||
    (Number.isFinite(layer) && layer < 0) ||
    (Number.isFinite(floor) && floor < 0)
}


/** Active mobility remains a separate graph: a crossing in XY is NOT a graph connection. */
export function isPedestrianWay(road: RoadFeature): boolean {
  if (road.tags.area === 'yes' || road.tags.access === 'no' || road.tags.foot === 'no') return false
  if (road.highway === 'cycleway') return road.tags.foot === 'yes'
  return PEDESTRIAN_HIGHWAYS.has(road.highway)
}
export function motorRoads(roads: readonly RoadFeature[]): RoadFeature[] {
  return roads.filter(isTrafficRoad)
}
export function pedestrianWays(roads: readonly RoadFeature[]): RoadFeature[] {
  return roads.filter(isPedestrianWay)
}

export type WalkEdge = { roadId: string; from: string; to: string; distance: number; kind: string }
export type WalkGraph = {
  edges: WalkEdge[]
  points: Map<string, RoadVertex>
  adjacency: Map<string, WalkEdge[]>
  junctions: Set<string>
}
export function buildPedestrianGraph(roads: readonly RoadFeature[]): WalkGraph {
  const points = new Map<string, RoadVertex>()
  const adjacency = new Map<string, WalkEdge[]>()
  const edges: WalkEdge[] = []
  const owners = new Map<string, Set<string>>()
  for (const road of pedestrianWays(roads)) {
    for (const vertex of road.vertices) {
      points.set(vertex.id, vertex)
      if (!owners.has(vertex.id)) owners.set(vertex.id, new Set())
      owners.get(vertex.id)!.add(road.id)
    }
    for (let i = 1; i < road.vertices.length; i++) {
      const from = road.vertices[i - 1]!, to = road.vertices[i]!
      const distance = distanceMetres(from, to)
      if (distance < 0.01) continue
      const edge = { roadId: road.id, from: from.id, to: to.id, distance, kind: road.highway }
      edges.push(edge)
      if (!adjacency.has(from.id)) adjacency.set(from.id, [])
      if (!adjacency.has(to.id)) adjacency.set(to.id, [])
      adjacency.get(from.id)!.push(edge)
      adjacency.get(to.id)!.push(edge)
    }
  }
  return { edges, points, adjacency, junctions: new Set([...owners].filter(([, roads]) => roads.size > 1).map(([id]) => id)) }
}

/** Dijkstra on actual OSM IDs; paths which merely cross geometrically stay disconnected. */
export function pedestrianRoute(graph: WalkGraph, start: string, end: string): { vertices: RoadVertex[]; metres: number } | null {
  if (!graph.points.has(start) || !graph.points.has(end)) return null
  const distance = new Map<string, number>([[start, 0]])
  const previous = new Map<string, string>()
  const settled = new Set<string>()
  // Binary heap keeps dense city extracts responsive.
  const heap: Array<{ id: string; cost: number }> = []
  function push(node: { id: string; cost: number }) {
    heap.push(node)
    let i = heap.length - 1
    while (i) {
      const parent = Math.floor((i - 1) / 2)
      if (heap[parent]!.cost <= node.cost) break
      heap[i] = heap[parent]!
      i = parent
    }
    heap[i] = node
  }
  function pop(): { id: string; cost: number } | undefined {
    const result = heap[0]
    const end = heap.pop()
    if (end && heap.length) {
      let i = 0
      while (2 * i + 1 < heap.length) {
        let child = 2 * i + 1
        if (child + 1 < heap.length && heap[child + 1]!.cost < heap[child]!.cost) child++
        if (end.cost <= heap[child]!.cost) break
        heap[i] = heap[child]!
        i = child
      }
      heap[i] = end
    }
    return result
  }
  push({ id: start, cost: 0 })
  while (heap.length) {
    const current = pop()!
    if (settled.has(current.id)) continue
    settled.add(current.id)
    if (current.id === end) break
    for (const edge of graph.adjacency.get(current.id) ?? []) {
      const target = edge.from === current.id ? edge.to : edge.from
      const next = current.cost + edge.distance
      if (next < (distance.get(target) ?? Infinity)) {
        distance.set(target, next)
        previous.set(target, current.id)
        push({ id: target, cost: next })
      }
    }
  }
  if (!distance.has(end)) return null
  const sequence = [end]
  while (sequence[sequence.length - 1] !== start) {
    const parent = previous.get(sequence[sequence.length - 1]!)
    if (!parent) return null
    sequence.push(parent)
  }
  return { vertices: sequence.reverse().map(id => graph.points.get(id)!), metres: distance.get(end)! }
}

export function closestWalkNode(graph: WalkGraph, at: RoadVertex, toleranceMetres: number): string | null {
  let best = toleranceMetres
  let id: string | null = null
  for (const [key, point] of graph.points) {
    const metres = distanceMetres(at, point)
    if (metres < best) { best = metres; id = key }
  }
  return id
}

/** An inferred sidewalk is a VIEW-ONLY offset, never an invented OSM way. */
export function offsetFootpath(vertices: readonly RoadVertex[], offsetMetres: number): [number, number][] {
  if (vertices.length < 2) return []
  return vertices.map((point, index) => {
    const prev = vertices[Math.max(0, index - 1)]!
    const next = vertices[Math.min(vertices.length - 1, index + 1)]!
    const factor = Math.max(0.05, Math.cos(point.lat * Math.PI / 180))
    const dx = (next.lng - prev.lng) * 111_320 * factor
    const dy = (next.lat - prev.lat) * 111_320
    const len = Math.hypot(dx, dy) || 1
    return [point.lng - dy / len * offsetMetres / (111_320 * factor),
      point.lat + dx / len * offsetMetres / 111_320]
  })
}
export type WalkVisualFeature = {
  type: 'Feature'
  properties: { roadId: string; kind: string; inferred: boolean; underground: boolean; selected: boolean; width: number; latitudeFactor: number }
  geometry: { type: 'LineString'; coordinates: number[][] }
}
export function pedestrianVisualFeatures(roads: readonly RoadFeature[], selectedId: string | null): WalkVisualFeature[] {
  const features: WalkVisualFeature[] = []
  for (const road of roads) {
    if (road.vertices.length < 2) continue
    if (isPedestrianWay(road)) {
      const tagWidth = Number.parseFloat(road.tags.width ?? '')
      const width = Number.isFinite(tagWidth) && tagWidth >= 0.6 && tagWidth <= 8
        ? tagWidth : road.highway === 'steps' ? 1.5 : 2.2
      const latitudeFactor = 1 / Math.max(0.02, Math.cos(road.vertices[0]!.lat * Math.PI / 180))
      features.push({ type: 'Feature', properties: { roadId: road.id, kind: road.highway,
        inferred: false, underground: isUndergroundPedestrianWay(road), selected: road.id === selectedId, width, latitudeFactor }, geometry: {
        type: 'LineString', coordinates: road.vertices.map(v => [v.lng, v.lat]),
      } })
    } else if (isTrafficRoad(road)) {
      const sidewalk = road.tags.sidewalk || (road.tags['sidewalk:left'] === 'yes' || road.tags['sidewalk:right'] === 'yes' ? 'custom' : '')
      if (!sidewalk || sidewalk === 'no' || sidewalk === 'none' || sidewalk === 'separate') continue
      const left = sidewalk === 'both' || sidewalk === 'left' || sidewalk === 'yes' || road.tags['sidewalk:left'] === 'yes'
      const right = sidewalk === 'both' || sidewalk === 'right' || sidewalk === 'yes' || road.tags['sidewalk:right'] === 'yes'
      // 0.7 m beyond the outermost motor lane, with road width from OSM lane count.
      const edge = road.lanes * 3.2 / 2 + 1.4
      for (const offset of [left ? edge : 0, right ? -edge : 0]) {
        if (!offset) continue
        features.push({ type: 'Feature', properties: { roadId: road.id, kind: 'sidewalk', inferred: true,
          underground: isUndergroundPedestrianWay(road), selected: false, width: 1.8, latitudeFactor: 1 / Math.max(0.02, Math.cos(road.vertices[0]!.lat * Math.PI / 180)) },
          geometry: { type: 'LineString', coordinates: offsetFootpath(road.vertices, offset) } })
      }
    }
  }
  return features
}

export type PedestrianPortalFeature = {
  type: 'Feature'
  properties: { nodeId: string; type: 'underpass-entrance' }
  geometry: { type: 'Point'; coordinates: [number, number] }
}
/** Mark the ends of an OSM underpass. Shared underground segment joints are NOT entrances. */
export function pedestrianPortalFeatures(roads: readonly RoadFeature[]): PedestrianPortalFeature[] {
  const under = pedestrianWays(roads).filter(isUndergroundPedestrianWay)
  const undergroundOwners = new Map<string, number>()
  const surfaceNodes = new Set<string>()
  for (const road of pedestrianWays(roads)) {
    for (const point of road.vertices) {
      if (!isUndergroundPedestrianWay(road)) surfaceNodes.add(point.id)
    }
  }
  for (const road of under) for (const point of [road.vertices[0], road.vertices[road.vertices.length - 1]]) {
    if (point) undergroundOwners.set(point.id, (undergroundOwners.get(point.id) ?? 0) + 1)
  }
  const result = new Map<string, PedestrianPortalFeature>()
  for (const road of under) for (const point of [road.vertices[0], road.vertices[road.vertices.length - 1]]) {
    if (!point || (!surfaceNodes.has(point.id) && (undergroundOwners.get(point.id) ?? 0) > 1)) continue
    result.set(point.id, { type: 'Feature', properties: { nodeId: point.id, type: 'underpass-entrance' },
      geometry: { type: 'Point', coordinates: [point.lng, point.lat] } })
  }
  return [...result.values()]
}

export function findPedestrianSnap(at: RoadVertex, roads: readonly RoadFeature[], tolerance: number):
  { roadId: string; segmentIndex: number; t: number; vertex: RoadVertex } | null {
  let bestDistance = tolerance
  let best: { roadId: string; segmentIndex: number; t: number; vertex: RoadVertex } | null = null
  for (const road of pedestrianWays(roads)) for (let i = 0; i + 1 < road.vertices.length; i++) {
    const a = road.vertices[i]!, b = road.vertices[i + 1]!
    const cos = Math.max(0.05, Math.cos(at.lat * Math.PI / 180))
    const dx = (b.lng - a.lng) * cos, dy = b.lat - a.lat
    const t = Math.max(0, Math.min(1, ((at.lng - a.lng) * cos * dx + (at.lat - a.lat) * dy) / (dx * dx + dy * dy || 1)))
    const projected = { id: crypto.randomUUID(), lng: a.lng + (b.lng - a.lng) * t, lat: a.lat + (b.lat - a.lat) * t }
    const metres = distanceMetres(at, projected)
    if (metres >= bestDistance) continue
    bestDistance = metres
    const nearest = t < 0.015 || distanceMetres(a, projected) < 0.5 ? a :
      t > 0.985 || distanceMetres(b, projected) < 0.5 ? b : projected
    best = { roadId: road.id, segmentIndex: i, t: nearest === a ? 0 : nearest === b ? 1 : t, vertex: nearest }
  }
  return best
}

/** One undoable, topology-safe operation; existing roads are modified only at chosen endpoints. */
export function attachPedestrianPath(roads: readonly RoadFeature[], path: readonly RoadVertex[], tolerance = 7):
  { roads: RoadFeature[]; vertices: RoadVertex[] } {
  if (path.length < 2) throw new Error('Пешеходная дорожка должна иметь хотя бы две точки.')
  const edited = roads.map(r => ({ ...r, vertices: r.vertices.map(v => ({ ...v })) }))
  const vertices: RoadVertex[] = path.map(v => ({ ...v, id: crypto.randomUUID() }))
  for (const index of [0, vertices.length - 1]) {
    const nearest = findPedestrianSnap(vertices[index]!, edited, tolerance)
    if (!nearest) continue
    const road = edited.find(r => r.id === nearest.roadId)!
    if (nearest.t > 0 && nearest.t < 1) road.vertices.splice(nearest.segmentIndex + 1, 0, { ...nearest.vertex })
    vertices[index] = { ...nearest.vertex }
  }
  if (vertices.some((point, i) => i && distanceMetres(point, vertices[i - 1]!) < 0.4)) {
    throw new Error('Слишком короткий отрезок пешеходной дорожки.')
  }
  return { roads: edited, vertices }
}

export type PedestrianSurfaceFeature = { type: 'Feature'; properties: {
  roadId: string; kind: string; inferred: boolean; width: number
}; geometry: { type: 'Polygon'; coordinates: number[][][] } }
/** Slightly raised pedestrian ribbons in 3D. These are visualization only. */
export function pedestrianSurfaceFeatures(roads: readonly RoadFeature[]): PedestrianSurfaceFeature[] {
  const features: PedestrianSurfaceFeature[] = []
  const lines = pedestrianVisualFeatures(roads, null)
  const lookup = new Map(roads.map(road => [road.id, road]))
  for (const line of lines) {
    // The 3D raised curb is a surface structure; a tunnel is shown only as a dashed diagram.
    if (line.properties.underground || line.geometry.coordinates.length < 2) continue
    const owner = lookup.get(line.properties.roadId)
    const explicit = owner?.tags.width ? Number.parseFloat(owner.tags.width) : NaN
    const width = Number.isFinite(explicit) && explicit >= 0.6 && explicit <= 8 ? explicit :
      line.properties.kind === 'steps' ? 1.5 : line.properties.inferred ? 1.8 : 2.2
    const points = line.geometry.coordinates.map(([lng, lat], index) => ({ id: `surface-${index}`, lng: lng!, lat: lat! }))
    const left = offsetFootpath(points, width / 2)
    const right = offsetFootpath(points, -width / 2).reverse()
    const ring = [...left, ...right]
    if (ring.length < 4) continue
    ring.push([...ring[0]!])
    features.push({ type: 'Feature', properties: { roadId: line.properties.roadId, kind: line.properties.kind,
      inferred: line.properties.inferred, width }, geometry: { type: 'Polygon', coordinates: [ring] } })
  }
  return features
}
