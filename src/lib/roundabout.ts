import type { RoadFeature, RoadVertex } from '../types/road'
import { penEllipseAxes } from './pen.ts'

/** Geometry in a local tangent plane around the chosen roundabout centre. */
const NON_DRIVABLE = new Set(['footway', 'path', 'steps', 'pedestrian', 'cycleway', 'bridleway', 'platform', 'corridor', 'construction', 'proposed'])
function isTrafficRoad(road: RoadFeature): boolean {
  return !NON_DRIVABLE.has(road.highway) && road.tags.area !== 'yes'
}
const M = 111_320
const EPS_METRES = 0.015
export const MIN_ROUNDABOUT_RADIUS = 8
export const MAX_ROUNDABOUT_RADIUS = 80

export interface RoundaboutPlan {
  center: RoadVertex
  radiusMetres: number
  ring: RoadVertex[]
  /** The existing roads intersected by, or lying within, the roundabout footprint. */
  affectedRoadIds: string[]
  /** Number of outgoing arms meeting the roundabout; a through road has two arms. */
  connectionCount: number
  attachmentVertices: RoadVertex[]
  result: RoadFeature[]
  removedRoadIds: string[]
  /** Present for an oval roundabout built using the pen. */
  ellipse?: { majorMetres: number; minorMetres: number; rotationRadians: number }
}

type Point = { x: number; y: number }
type Mark = { along: number; vertex: RoadVertex; point: Point }

function local(point: RoadVertex, center: RoadVertex): Point {
  return {
    x: (point.lng - center.lng) * M * Math.cos(center.lat * Math.PI / 180),
    y: (point.lat - center.lat) * M,
  }
}
function global(point: Point, center: RoadVertex, id = crypto.randomUUID()): RoadVertex {
  return {
    id,
    lng: center.lng + point.x / (M * Math.cos(center.lat * Math.PI / 180)),
    lat: center.lat + point.y / M,
  }
}
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
const length = (p: Point) => Math.hypot(p.x, p.y)
const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
const normalAngle = (p: Point) => (Math.atan2(p.y, p.x) + Math.PI * 2) % (Math.PI * 2)

/** Parameter values at which a straight OSM polyline segment crosses a circle. */
function segmentCircleHits(a: Point, b: Point, radius: number): number[] {
  const dx = b.x - a.x, dy = b.y - a.y
  const aa = dx * dx + dy * dy
  if (aa < 1e-8) return []
  const bb = 2 * (a.x * dx + a.y * dy)
  const cc = a.x * a.x + a.y * a.y - radius * radius
  const delta = bb * bb - 4 * aa * cc
  if (delta <= 1e-6) return [] // Merely tangent: do not split roads.
  const root = Math.sqrt(delta)
  return [(-bb - root) / (2 * aa), (-bb + root) / (2 * aa)]
    .filter(t => t >= -1e-9 && t <= 1 + 1e-9)
    .map(t => Math.max(0, Math.min(1, t)))
    .sort((x, y) => x - y)
}

function idAllocator(roads: RoadFeature[], reservedWayIds: string[]) {
  const negatives = [...roads.map(r => r.osmId), ...reservedWayIds]
    .map(Number).filter(n => Number.isFinite(n) && n < 0)
  let nextId = Math.min(0, ...negatives) - 1
  return () => String(nextId--)
}

/**
 * Preview and materialise a one-way circular road in the same operation.
 * Existing surface ways are clipped to the ring; each surviving arm shares
 * precisely the same OSM node ID as the circular way.
 *
 * The original roads and vertices are never modified in-place.
 */
export function planRoundabout(
  center: RoadVertex,
  radiusMetres: number,
  existing: RoadFeature[],
  reservedWayIds: string[] = [],
): RoundaboutPlan {
  if (!Number.isFinite(radiusMetres) || radiusMetres < MIN_ROUNDABOUT_RADIUS || radiusMetres > MAX_ROUNDABOUT_RADIUS) {
    throw new Error(`Радиус кругового движения должен быть от ${MIN_ROUNDABOUT_RADIUS} до ${MAX_ROUNDABOUT_RADIUS} м.`)
  }
  const freshId = idAllocator(existing, reservedWayIds)
  const connections: Array<{ angle: number; vertex: RoadVertex; point: Point }> = []
  const changed = new Map<string, RoadFeature[]>()
  const removed: string[] = []

  function sharedBoundary(point: Point, original?: RoadVertex): RoadVertex {
    const normalized = length(point)
    const onRing = normalized > 1e-9 ? { x: point.x * radiusMetres / normalized, y: point.y * radiusMetres / normalized } : { x: radiusMetres, y: 0 }
    const previous = connections.find(item => distance(item.point, onRing) < 0.25)
    if (previous) return previous.vertex
    const vertex = original && distance(local(original, center), onRing) < 0.025
      ? { ...original }
      : global(onRing, center)
    connections.push({ angle: normalAngle(onRing), vertex, point: onRing })
    return vertex
  }

  for (const road of existing) {
    if (!isTrafficRoad(road) || road.level !== 0 || road.vertices.length < 2) continue
    const points = road.vertices.map(v => local(v, center))
    const positions = [0]
    for (let i = 1; i < points.length; i++) positions.push(positions[i - 1]! + distance(points[i - 1]!, points[i]!))
    const originalMarks: Mark[] = road.vertices.map((v, i) => ({ along: positions[i]!, vertex: { ...v }, point: points[i]! }))
    const hits: Mark[] = []
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!, b = points[i]!
      const segmentLength = positions[i]! - positions[i - 1]!
      if (segmentLength < 1e-8) continue
      for (const t of segmentCircleHits(a, b, radiusMetres)) {
        const p = lerp(a, b, t)
        const alreadyExisting = t < 1e-7 ? road.vertices[i - 1] : t > 1 - 1e-7 ? road.vertices[i] : undefined
        const vertex = sharedBoundary(p, alreadyExisting)
        hits.push({ along: positions[i - 1]! + t * segmentLength, vertex, point: local(vertex, center) })
      }
    }
    const allMarks = [...originalMarks, ...hits].sort((a, b) => a.along - b.along)
    const marks: Mark[] = []
    for (const mark of allMarks) {
      const last = marks[marks.length - 1]
      if (last && Math.abs(last.along - mark.along) < EPS_METRES) {
        // Keep the shared boundary vertex, not a duplicate old OSM node.
        if (hits.includes(mark)) marks[marks.length - 1] = mark
      } else marks.push(mark)
    }

    const fragments: RoadVertex[][] = []
    let active: RoadVertex[] = []
    let hasInside = false
    for (let i = 1; i < marks.length; i++) {
      const a = marks[i - 1]!, b = marks[i]!
      if (b.along - a.along < EPS_METRES) continue
      const midpoint = lerp(a.point, b.point, 0.5)
      const outside = length(midpoint) > radiusMetres + 1e-5
      if (outside) {
        if (!active.length) active.push({ ...a.vertex })
        else if (active[active.length - 1]!.id !== a.vertex.id) active.push({ ...a.vertex })
        active.push({ ...b.vertex })
      } else {
        hasInside = true
        if (active.length > 1) fragments.push(active)
        active = []
      }
    }
    if (active.length > 1) fragments.push(active)
    if (!hasInside) continue
    if (road.tags.junction === 'roundabout') throw new Error('Круговое движение уже существует в выбранной области.')
    if (road.highway === 'motorway' || road.highway === 'trunk') {
      throw new Error('Круговое движение нельзя автоматически вставить в автомагистраль или скоростную дорогу.')
    }
    // Remove duplicated almost-zero stubs. They are below the sampling tolerance.
    const usable = fragments.filter(vertices => vertices.some((v, i) => i > 0 && distance(local(v, center), local(vertices[0]!, center)) > 0.1))
    changed.set(road.id, usable.map((vertices, i): RoadFeature => ({
      ...road,
      id: i === 0 ? road.id : crypto.randomUUID(),
      osmId: i === 0 ? road.osmId : freshId(),
      vertices,
      tags: { ...road.tags },
    })))
    if (usable.length === 0) removed.push(road.id)
  }

  // A precise connection point must appear as a vertex of the roundabout way.
  // With no nearby roads, a standalone circle is still a valid OSM way.
  const sampleCount = Math.max(36, Math.min(144, Math.ceil(2 * Math.PI * radiusMetres / 2.7)))
  const samples = Array.from({ length: sampleCount }, (_, i) => {
    const angle = 2 * Math.PI * i / sampleCount
    const point = { x: radiusMetres * Math.cos(angle), y: radiusMetres * Math.sin(angle) }
    return { angle, point, vertex: global(point, center) }
  }).filter(sample => !connections.some(link => distance(sample.point, link.point) < 0.3))
  const ordered = [...samples, ...connections].sort((a, b) => a.angle - b.angle)
  const ring = ordered.map(item => ({ ...item.vertex }))
  if (ring.length < 4) throw new Error('Не удалось построить геометрию кругового движения.')
  ring.push({ ...ring[0]! }) // First and last node IDs MUST match for OSM roundabouts.

  const roads: RoadFeature[] = []
  for (const road of existing) {
    const replacement = changed.get(road.id)
    if (replacement) roads.push(...replacement)
    else roads.push(road)
  }
  const highwayPriority = ['primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'service']
  const connectedTypes = existing.filter(r => changed.has(r.id)).map(r => r.highway)
  const highway = highwayPriority.find(type => connectedTypes.includes(type)) ?? 'residential'
  const circle: RoadFeature = {
    id: crypto.randomUUID(), osmId: freshId(), name: '', highway,
    lanes: 1, oneway: true, bridge: false, level: 0,
    vertices: ring, tags: { junction: 'roundabout' },
  }
  roads.push(circle)

  return {
    center: { ...center }, radiusMetres, ring,
    attachmentVertices: connections.map(item => ({ ...item.vertex })),
    affectedRoadIds: Array.from(changed.keys()),
    connectionCount: connections.length,
    result: roads,
    removedRoadIds: removed,
  }
}

/**
 * Build a real OSM roundabout from the pen's circle / oval.  The existing
 * circular topology algorithm operates in a locally transformed plane so
 * its intersections, road clipping and shared node IDs remain exact.
 * Unlike drawing a closed way, this replaces interior road fragments.
 */
export function planPenEllipseRoundabout(
  center: RoadVertex,
  axisPoint: RoadVertex,
  widthPoint: RoadVertex,
  circle: boolean,
  existing: RoadFeature[],
  reservedWayIds: string[] = [],
): RoundaboutPlan | null {
  const axes = penEllipseAxes(center, axisPoint, widthPoint, circle)
  const { majorMetres, minorMetres, rotationRadians } = axes
  // The original roundabout editor supports radii 8–80 m.  Outside that
  // range the pen retains its ordinary closed-road behaviour.
  if (Math.min(majorMetres, minorMetres) < MIN_ROUNDABOUT_RADIUS ||
      Math.max(majorMetres, minorMetres) > MAX_ROUNDABOUT_RADIUS) return null

  // The original circular planner handles the exact-circle case unchanged.
  const isCircle = circle || Math.abs(majorMetres - minorMetres) < 0.05
  if (isCircle) {
    const plan = planRoundabout(center, majorMetres, existing, reservedWayIds)
    return plan.connectionCount >= 3 ? plan : null
  }

  const ux = Math.cos(rotationRadians), uy = Math.sin(rotationRadians)
  const vx = -uy, vy = ux
  const scale = majorMetres / minorMetres
  const metreLat = 111_320
  const metreLng = metreLat * Math.cos(center.lat * Math.PI / 180)

  function transform(vertex: RoadVertex, inverse: boolean): RoadVertex {
    const x = (vertex.lng - center.lng) * metreLng
    const y = (vertex.lat - center.lat) * metreLat
    const forward = x * ux + y * uy
    const sideways = (x * vx + y * vy) * (inverse ? 1 / scale : scale)
    return {
      id: vertex.id,
      lng: center.lng + (forward * ux + sideways * vx) / metreLng,
      lat: center.lat + (forward * uy + sideways * vy) / metreLat,
    }
  }

  const transformed = existing.map(road => ({
    ...road,
    vertices: road.vertices.map(vertex => transform(vertex, false)),
  }))
  const plan = planRoundabout(center, majorMetres, transformed, reservedWayIds)
  if (plan.connectionCount < 3) return null
  const unchanged = new Map(existing.map(road => [road.id, road]))
  const affected = new Set(plan.affectedRoadIds)
  return {
    ...plan,
    ellipse: axes,
    ring: plan.ring.map(vertex => transform(vertex, true)),
    attachmentVertices: plan.attachmentVertices.map(vertex => transform(vertex, true)),
    result: plan.result.map(road => {
      // Avoid marking untouched imported ways as edited due to floating-point
      // differences introduced by the affine transform.
      const original = unchanged.get(road.id)
      if (original && !affected.has(road.id)) return original
      return { ...road, vertices: road.vertices.map(vertex => transform(vertex, true)) }
    }),
  }
}

/** Lightweight mouse-motion preview (no graph mutations or topology search). */
export function previewCircle(center: RoadVertex, radiusMetres: number): RoadVertex[] {
  const points: RoadVertex[] = []
  const steps = 72
  const radius = Math.max(MIN_ROUNDABOUT_RADIUS, Math.min(MAX_ROUNDABOUT_RADIUS, radiusMetres))
  for (let i = 0; i <= steps; i++) {
    const angle = 2 * Math.PI * i / steps
    points.push(global({ x: radius * Math.cos(angle), y: radius * Math.sin(angle) }, center))
  }
  points[steps]!.id = points[0]!.id
  return points
}
