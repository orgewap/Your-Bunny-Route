import type { RoadFeature, RoadVertex } from '../types/road'
import { distanceMetres, isTrafficRoad } from './topology.ts'

/** A non-destructive plan. The original ways keep their OSM IDs and tags. */
export interface JunctionPlan {
  vertex: RoadVertex
  roadIds: string[]
  roads: { roadId: string; vertices: RoadVertex[] }[]
  armCount: number
  armSegments: [RoadVertex, RoadVertex][]
  /** Indicates how many distinct way nodes become one OSM node. */
  sharedNodeId: string
}

const METRES = 111_320
const EPS = 1e-8
const JOIN_DISTANCE = 1.6 // maximum correction of a misaligned T-junction, metres
const MIN_CROSSING_ANGLE = Math.PI / 8 // avoid accidentally joining parallel carriageways

function xy(v: RoadVertex, latitude: number): { x: number; y: number } {
  return { x: v.lng * METRES * Math.cos(latitude * Math.PI / 180), y: v.lat * METRES }
}
function projection(p: RoadVertex, a: RoadVertex, b: RoadVertex): { t: number; distance: number; point: RoadVertex; dx: number; dy: number } {
  const latitude = (p.lat + a.lat + b.lat) / 3
  const P = xy(p, latitude), A = xy(a, latitude), B = xy(b, latitude)
  const dx = B.x - A.x, dy = B.y - A.y
  const t = Math.max(0, Math.min(1, (dx * (P.x - A.x) + dy * (P.y - A.y)) / (dx * dx + dy * dy || 1)))
  const point = { id: '', lng: a.lng + (b.lng - a.lng) * t, lat: a.lat + (b.lat - a.lat) * t }
  return { t, distance: distanceMetres(p, point), point, dx, dy }
}
function intersection(a: RoadVertex, b: RoadVertex, c: RoadVertex, d: RoadVertex): RoadVertex | null {
  const latitude = (a.lat + b.lat + c.lat + d.lat) / 4
  const A = xy(a, latitude), B = xy(b, latitude), C = xy(c, latitude), D = xy(d, latitude)
  const rx = B.x - A.x, ry = B.y - A.y, sx = D.x - C.x, sy = D.y - C.y
  const cross = rx * sy - ry * sx
  if (Math.abs(cross) < EPS) return null
  const t = ((C.x - A.x) * sy - (C.y - A.y) * sx) / cross
  const u = ((C.x - A.x) * ry - (C.y - A.y) * rx) / cross
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null
  return { id: '', lng: a.lng + t * (b.lng - a.lng), lat: a.lat + t * (b.lat - a.lat) }
}
function previewLeg(from: RoadVertex, to: RoadVertex): [RoadVertex, RoadVertex] {
  const length = distanceMetres(from, to)
  const ratio = length <= 14 ? 1 : 14 / length
  return [ { ...from }, {
    id: to.id,
    lng: from.lng + (to.lng - from.lng) * ratio,
    lat: from.lat + (to.lat - from.lat) * ratio,
  } ]
}
function angleEnough(a: { dx: number; dy: number }, b: { dx: number; dy: number }): boolean {
  const n = Math.hypot(a.dx, a.dy) * Math.hypot(b.dx, b.dy)
  return n > EPS && Math.abs(a.dx * b.dy - a.dy * b.dx) / n >= Math.sin(MIN_CROSSING_ANGLE)
}
interface Segment {
  road: RoadFeature
  index: number
  a: RoadVertex
  b: RoadVertex
}
interface Candidate { center: RoadVertex; distance: number }

/**
 * Join ground roads at their true geometric crossing (or a <=1.6m endpoint
 * gap). It never connects bridges or parallel lanes merely because they are
 * close on-screen. Roads and OSM relation references are not replaced.
 */
export function planJunction(
  click: RoadVertex,
  network: readonly RoadFeature[],
  pickRadiusMetres = 15,
): JunctionPlan {
  const radius = Math.max(2, Math.min(25, pickRadiusMetres))
  const segments: Segment[] = []
  for (const road of network) {
    if (!isTrafficRoad(road) || road.level !== 0 || road.bridge ||
      road.tags.junction === 'roundabout' || road.tags.area === 'yes') continue
    for (let i = 0; i < road.vertices.length - 1; i++) {
      const a = road.vertices[i]!, b = road.vertices[i + 1]!
      if (distanceMetres(a, b) < 0.3) continue
      if (projection(click, a, b).distance > radius + JOIN_DISTANCE) continue
      segments.push({ road, index: i, a, b })
    }
  }
  const candidates: Candidate[] = []
  for (let i = 0; i < segments.length; i++) {
    const one = segments[i]!
    for (let j = i + 1; j < segments.length; j++) {
      const two = segments[j]!
      if (one.road.id === two.road.id) continue
      const pa = projection(click, one.a, one.b)
      const pb = projection(click, two.a, two.b)
      if (!angleEnough(pa, pb)) continue
      const crossing = intersection(one.a, one.b, two.a, two.b)
      if (crossing && distanceMetres(click, crossing) <= radius) {
        candidates.push({ center: crossing, distance: distanceMetres(click, crossing) })
        continue
      }
      // T-junction whose endpoint misses the other centreline by <=1.6m.
      for (const end of [one.a, one.b]) {
        const hit = projection(end, two.a, two.b)
        if (hit.distance <= JOIN_DISTANCE && distanceMetres(click, hit.point) <= radius)
          candidates.push({ center: hit.point, distance: distanceMetres(click, hit.point) })
      }
      for (const end of [two.a, two.b]) {
        const hit = projection(end, one.a, one.b)
        if (hit.distance <= JOIN_DISTANCE && distanceMetres(click, hit.point) <= radius)
          candidates.push({ center: hit.point, distance: distanceMetres(click, hit.point) })
      }
    }
  }
  candidates.sort((a, b) => a.distance - b.distance)
  if (!candidates.length) throw new Error('В этой точке нет пересечения наземных дорог. Увеличьте масштаб или выберите другое место.')
  const center = candidates[0]!.center
  // Preserve an existing road node if it is geometrically the same junction.
  // A shared old OSM ID is preferable to an invented UUID.
  const owners = new Map<string, number>()
  for (const segment of segments) for (const vertex of [segment.a, segment.b]) {
    if (distanceMetres(center, vertex) > 0.35) continue
    owners.set(vertex.id, (owners.get(vertex.id) ?? 0) + 1)
  }
  const existingId = [...owners.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  const sharedNodeId = existingId ?? crypto.randomUUID()
  const vertex: RoadVertex = { ...center, id: sharedNodeId }
  const changed: JunctionPlan['roads'] = []
  const nodeOwners = new Map<string, number>()
  for (const road of network) for (const id of new Set(road.vertices.map(v => v.id)))
    nodeOwners.set(id, (nodeOwners.get(id) ?? 0) + 1)
  let arms = 0
  const armSegments: [RoadVertex, RoadVertex][] = []
  const connectedRoads = new Set<string>()
  for (const road of network) {
    if (!isTrafficRoad(road) || road.level !== 0 || road.bridge || road.tags.junction === 'roundabout') continue
    let best: { index: number; distance: number; t: number } | null = null
    for (let i = 0; i < road.vertices.length - 1; i++) {
      const result = projection(vertex, road.vertices[i]!, road.vertices[i + 1]!)
      if (result.distance > JOIN_DISTANCE) continue
      if (!best || result.distance < best.distance) best = { index: i, distance: result.distance, t: result.t }
    }
    if (!best) continue
    const startPoint = road.vertices[best.index]!
    const endPoint = road.vertices[best.index + 1]!
    // Parallel carriageways running one metre beside a crossing are NOT an
    // extra approach. A loose tolerance is allowed only for road endpoints.
    if (best.distance > 0.45 &&
      distanceMetres(startPoint, vertex) > JOIN_DISTANCE &&
      distanceMetres(endPoint, vertex) > JOIN_DISTANCE) continue
    const updated = road.vertices.map(v => ({ ...v }))
    const index = best.index
    // Do not move pre-existing shared nodes even if the clicked crossing is a
    // fraction of a metre away: changing one could break another junction.
    const first = updated[index]!, last = updated[index + 1]!
    const nearFirst = distanceMetres(first, vertex) <= JOIN_DISTANCE
    const nearLast = distanceMetres(last, vertex) <= JOIN_DISTANCE
    if (nearFirst) {
      if (distanceMetres(first, vertex) > 0.35 && (nodeOwners.get(first.id) ?? 0) > 1)
        throw new Error('Конец дороги уже связан с другим перекрёстком; сначала отсоедините узел.')
      updated[index] = { ...vertex }
    } else if (nearLast) {
      if (distanceMetres(last, vertex) > 0.35 && (nodeOwners.get(last.id) ?? 0) > 1)
        throw new Error('Конец дороги уже связан с другим перекрёстком; сначала отсоедините узел.')
      updated[index + 1] = { ...vertex }
    }
    else if (best.t > EPS && best.t < 1 - EPS) updated.splice(index + 1, 0, { ...vertex })
    else continue // never drag a remote endpoint onto a junction
    const junctionIndex = nearFirst ? index : index + 1
    arms += (junctionIndex > 0 ? 1 : 0) + (junctionIndex < updated.length - 1 ? 1 : 0)
    if (junctionIndex > 0) armSegments.push(previewLeg(vertex, updated[junctionIndex - 1]!))
    if (junctionIndex < updated.length - 1) armSegments.push(previewLeg(vertex, updated[junctionIndex + 1]!))
    connectedRoads.add(road.id)
    if (updated.length !== road.vertices.length || updated.some((v, i) => {
      const original = road.vertices[i]
      return !original || original.id !== v.id || original.lng !== v.lng || original.lat !== v.lat
    })) changed.push({ roadId: road.id, vertices: updated })
  }
  if (connectedRoads.size < 2 || arms < 3) {
    throw new Error('Для перекрёстка нужны минимум три подхода наземных дорог.')
  }
  if (!changed.length) throw new Error('Эти дороги уже соединены общим OSM-узлом.')
  return { vertex, roadIds: [...connectedRoads], roads: changed, armCount: arms, armSegments, sharedNodeId }
}
