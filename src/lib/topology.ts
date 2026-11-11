import type { RoadFeature, RoadVertex } from '../types/road'

/** Working coordinates are local metres, not screen pixels or raw lon/lat. */
const METRES_PER_DEGREE = 111_320
const EPS = 1e-7
export const BRIDGE_HALF_SPAN_METRES = 18
export const MIN_APPROACH_METRES = 6

const NON_DRIVABLE = new Set(['footway', 'path', 'steps', 'pedestrian', 'cycleway', 'bridleway', 'platform', 'corridor', 'construction', 'proposed'])
export function isTrafficRoad(road: RoadFeature): boolean { return !NON_DRIVABLE.has(road.highway) && road.tags.area !== 'yes' }
export type CrossingKind = 'bridge' | 'junction'

export interface TargetLink {
  roadId: string
  segmentIndex: number
  t: number
  vertex: RoadVertex
  /** Optional lane/border that the user clicked; the graph node stays on the OSM way. */
  laneAttachment?: {
    laneIndex: number
    laneCount: number
    boundary: boolean
    offsetMetres: number
    visibleVertex: RoadVertex
  }
}

export interface DetectedCrossing {
  id: string
  targetRoadId: string
  targetName: string
  targetSegmentIndex: number
  targetT: number
  vertex: RoadVertex
  along: number
  targetLevel: number
  bridgeLevel: number
  /** Metres along the new road. These delimit the actual elevated OSM way. */
  bridgeFrom: number
  bridgeTo: number
  kind: CrossingKind
}

export interface RoadPlan {
  path: RoadVertex[]
  endpoints: TargetLink[]
  /** Only explicit user lane-edge snaps may hide the short centre-to-edge link. */
  visualApproach?: readonly [boolean, boolean]
  crossings: DetectedCrossing[]
  totalLength: number
}

export interface RoadBuildResult {
  roads: RoadFeature[]
  modifiedExisting: Map<string, RoadVertex[]>
  bridgeCount: number
  junctionCount: number
}

const refLat = (a: RoadVertex, b: RoadVertex) => (a.lat + b.lat) / 2
function xy(point: RoadVertex, referenceLat: number): [number, number] {
  return [point.lng * METRES_PER_DEGREE * Math.cos(referenceLat * Math.PI / 180), point.lat * METRES_PER_DEGREE]
}
function pointOnSegment(a: RoadVertex, b: RoadVertex, t: number): RoadVertex {
  return { id: crypto.randomUUID(), lng: a.lng + (b.lng - a.lng) * t, lat: a.lat + (b.lat - a.lat) * t }
}
export function distanceMetres(a: RoadVertex, b: RoadVertex): number {
  const latitude = refLat(a, b)
  const p = xy(a, latitude), q = xy(b, latitude)
  return Math.hypot(p[0] - q[0], p[1] - q[1])
}
function projection(p: RoadVertex, a: RoadVertex, b: RoadVertex): { t: number; point: RoadVertex; distance: number } {
  const latitude = refLat(a, b)
  const [px, py] = xy(p, latitude), [ax, ay] = xy(a, latitude), [bx, by] = xy(b, latitude)
  const vx = bx - ax, vy = by - ay
  const t = Math.min(1, Math.max(0, (vx * (px - ax) + vy * (py - ay)) / (vx * vx + vy * vy || 1)))
  const point = pointOnSegment(a, b, t)
  return { t, point, distance: distanceMetres(p, point) }
}

/**
 * Snap onto any drivable OSM way, including bridge layers +1/+2.
 * At overlapping 2D positions the caller's selected layer takes priority;
 * this prevents accidentally joining a ground road beneath a selected bridge.
 * Does not mutate original OSM geometry.
 */
export function snapToRoad(
  raw: RoadVertex,
  roads: RoadFeature[],
  toleranceMetres: number,
  level: number | null = null,
  preferredLevel: number | null = null,
): { vertex: RoadVertex; link: TargetLink | null } {
  let nearest: { roadId: string; segmentIndex: number; t: number; vertex: RoadVertex; distance: number; level: number } | null = null
  for (const road of roads) {
    if (!isTrafficRoad(road) || (level !== null && road.level !== level)) continue
    for (let i = 1; i < road.vertices.length; i++) {
      const a = road.vertices[i - 1]!, b = road.vertices[i]!
      const result = projection(raw, a, b)
      if (result.distance > toleranceMetres) continue
      if (nearest) {
        const distanceDifference = result.distance - nearest.distance
        const approximatelySameLocation = Math.abs(distanceDifference) <= 1.2
        if (!approximatelySameLocation && distanceDifference >= 0) continue
        if (approximatelySameLocation) {
          if (preferredLevel !== null) {
            const newPreferred = road.level === preferredLevel
            const previousPreferred = nearest.level === preferredLevel
            if (previousPreferred && !newPreferred) continue
            if (newPreferred && !previousPreferred) {
              // Keep this candidate, even if slightly farther away.
            } else if (distanceDifference >= 0) continue
          } else {
            // In overlapping 2D geometry choose the upper deck by default.
            if (road.level < nearest.level) continue
            if (road.level === nearest.level && distanceDifference >= 0) continue
          }
        }
      }
      const segmentLength = distanceMetres(a, b)
      let t = result.t
      let vertex = result.point
      // Reuse an existing OSM node near the endpoint, rather than inventing one.
      if (t * segmentLength <= Math.min(1.2, toleranceMetres * 0.35)) { t = 0; vertex = { ...a } }
      else if ((1 - t) * segmentLength <= Math.min(1.2, toleranceMetres * 0.35)) { t = 1; vertex = { ...b } }
      nearest = { roadId: road.id, segmentIndex: i - 1, t, vertex, distance: result.distance, level: road.level }
    }
  }
  if (!nearest) return { vertex: { ...raw }, link: null }
  return { vertex: nearest.vertex, link: { roadId: nearest.roadId, segmentIndex: nearest.segmentIndex, t: nearest.t, vertex: nearest.vertex } }
}

interface Intersection { t: number; u: number; vertex: RoadVertex }
function intersection(a: RoadVertex, b: RoadVertex, c: RoadVertex, d: RoadVertex): Intersection | null {
  const latitude = (a.lat + b.lat + c.lat + d.lat) / 4
  const [ax, ay] = xy(a, latitude), [bx, by] = xy(b, latitude)
  const [cx, cy] = xy(c, latitude), [dx, dy] = xy(d, latitude)
  const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy
  const denominator = rx * sy - ry * sx
  if (Math.abs(denominator) < 1e-7) return null // Parallel / collinear; never invent a junction.
  const qx = cx - ax, qy = cy - ay
  const t = (qx * sy - qy * sx) / denominator
  const u = (qx * ry - qy * rx) / denominator
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null
  return { t: Math.min(1, Math.max(0, t)), u: Math.min(1, Math.max(0, u)), vertex: pointOnSegment(a, b, Math.min(1, Math.max(0, t))) }
}
function lengths(path: RoadVertex[]): number[] {
  const result = [0]
  for (let i = 1; i < path.length; i++) result.push(result[i - 1]! + distanceMetres(path[i - 1]!, path[i]!))
  return result
}

/** Preview first; call materializeRoadPlan ONLY after the user confirms crossings. */
export function planRoad(
  path: RoadVertex[],
  existing: RoadFeature[],
  snapToleranceMetres = 8,
  preferredLevel: number | null = null,
  snapEnds: readonly [boolean, boolean] = [true, true],
  explicitLinks: readonly [TargetLink | null, TargetLink | null] = [null, null],
): RoadPlan {
  if (path.length < 2) throw new Error('Для построения нужны минимум две точки.')
  const snapped = path.map(vertex => ({ ...vertex }))
  const endpoints: TargetLink[] = []
  // A curve control point isn't snapped to the road network.
  

for (const [endIndex, index] of [0, path.length - 1].entries()) {
  if (!snapEnds[endIndex]) continue

  const pinned = explicitLinks[endIndex]

  if (pinned) {
    const target = existing.find(
      road => road.id === pinned.roadId
    )

    if (!target?.vertices[pinned.segmentIndex + 1]) {
      throw new Error(
        'Дорога, к которой привязывали конец, больше недоступна.'
      )
    }
  }

  const result = pinned
    ? {
        vertex: { ...pinned.vertex },
        link: pinned
      }
    : snapToRoad(
        snapped[index]!,
        existing,
        snapToleranceMetres,
        null,
        preferredLevel
      )

  snapped[index] = result.vertex

  if (
    result.link &&
    !endpoints.some(link =>
      link.roadId === result.link!.roadId &&
      link.segmentIndex === result.link!.segmentIndex &&
      link.t === result.link!.t
    )
  ) {
    endpoints.push(result.link)
  }
}


  // A branch is attached topologically at the centreline OSM node, but can
  // leave the carriageway from ANY selected lane or outer road edge.
  // The short approach becomes real OSM geometry, not just a visual offset.
  // Preserve the core shared junction node at the very first/last vertex.
  const startLane = snapEnds[0] ? explicitLinks[0]?.laneAttachment : undefined
  const endLane = snapEnds[1] ? explicitLinks[1]?.laneAttachment : undefined
  if (startLane && Math.abs(startLane.offsetMetres) > 0.5) {
    snapped.splice(1, 0, { ...startLane.visibleVertex })
  }
  if (endLane && Math.abs(endLane.offsetMetres) > 0.5) {
    snapped.splice(snapped.length - 1, 0, { ...endLane.visibleVertex })
  }

  const visualApproach: [boolean, boolean] = [
    !!startLane && Math.abs(startLane.offsetMetres) > 0.5,
    !!endLane && Math.abs(endLane.offsetMetres) > 0.5,
  ]

  const positions = lengths(snapped)
  const totalLength = positions[positions.length - 1]!
  if (totalLength < 2) throw new Error('Дорога слишком короткая (минимум 2 м).')
  const crossings: DetectedCrossing[] = []
  for (let i = 1; i < snapped.length; i++) {
    const start = snapped[i - 1]!, end = snapped[i]!
    const segmentLength = distanceMetres(start, end)
    if (segmentLength < EPS) continue
    for (const target of existing) {
      if (!isTrafficRoad(target)) continue
      for (let j = 1; j < target.vertices.length; j++) {
        const hit = intersection(start, end, target.vertices[j - 1]!, target.vertices[j]!)
        if (!hit) continue
        const along = positions[i - 1]! + hit.t * segmentLength
        // First/last path points are handled by network snapping, not by bridge creation.
        if (along <= 0.2 || totalLength - along <= 0.2) continue
        // One OSM vertex belongs to two adjacent segments: report it only once per target way.
        if (crossings.some(item => item.targetRoadId === target.id && Math.abs(item.along - along) < 0.5)) continue
        // Reuse the exact existing node when crossing on an OSM vertex.
        if (hit.u < 1e-7) hit.vertex = { ...target.vertices[j - 1]! }
        else if (hit.u > 1 - 1e-7) hit.vertex = { ...target.vertices[j]! }
        const kind: CrossingKind = target.level === 0 && endpoints.some(link => link.roadId === target.id && distanceMetres(hit.vertex, link.vertex) < 0.5) ? 'junction' : 'bridge'
        crossings.push({
          id: `${target.id}:${j - 1}:${Math.round(along * 100)}`,
          targetRoadId: target.id, targetName: target.name || `way/${target.osmId}`,
          targetSegmentIndex: j - 1, targetT: hit.u, vertex: hit.vertex, along,
          targetLevel: target.level, bridgeLevel: Math.max(1, target.level + 1),
          bridgeFrom: Math.max(MIN_APPROACH_METRES, along - BRIDGE_HALF_SPAN_METRES),
          bridgeTo: Math.min(totalLength - MIN_APPROACH_METRES, along + BRIDGE_HALF_SPAN_METRES), kind,
        })
      }
    }
  }
  crossings.sort((a, b) => a.along - b.along)
  return { path: snapped, endpoints, visualApproach, crossings, totalLength }
}

function atDistance(plan: RoadPlan, distances: number[], along: number): RoadVertex {
  for (let i = 1; i < distances.length; i++) {
    const start = distances[i - 1]!, end = distances[i]!
    if (Math.abs(along - start) < 0.01) return { ...plan.path[i - 1]! }
    if (Math.abs(along - end) < 0.01) return { ...plan.path[i]! }
    if (along > start && along < end) return pointOnSegment(plan.path[i - 1]!, plan.path[i]!, (along - start) / (end - start))
  }
  return { ...plan.path[plan.path.length - 1]! }
}

type Mark = { along: number; vertex: RoadVertex }
function markKey(n: number): string { return n.toFixed(4) }
function addMark(marks: Map<string, Mark>, along: number, vertex: RoadVertex): void {
  const key = markKey(along)
  // Existing vertices have priority over generated bridge segment boundaries.
  if (!marks.has(key)) marks.set(key, { along, vertex })
}

/** Highlight actual projected bridge spans while the user chooses crossing types. */
export function previewBridgeSpans(plan: RoadPlan): RoadVertex[][] {
  const distances = lengths(plan.path)
  const spans = plan.crossings.filter(cross => cross.kind === 'bridge').map(cross => ({
    from: cross.bridgeFrom,
    to: cross.bridgeTo,
  })).filter(span => span.to > span.from).sort((a, b) => a.from - b.from)
  const merged: typeof spans = []
  for (const span of spans) {
    const last = merged[merged.length - 1]
    if (last && span.from <= last.to + 0.1) last.to = Math.max(last.to, span.to)
    else merged.push({ ...span })
  }
  return merged.map(span => [
    atDistance(plan, distances, span.from),
    ...plan.path.filter((_, index) => distances[index]! > span.from + 0.01 && distances[index]! < span.to - 0.01),
    atDistance(plan, distances, span.to),
  ])
}

/** Creates tagged bridge spans and inserts shared OSM vertices only at true junctions. */
export function materializeRoadPlan(plan: RoadPlan, existing: RoadFeature[], reservedWayIds: string[] = []): RoadBuildResult {
  const distances = lengths(plan.path)
  const intervals: Array<{ from: number; to: number; level: number }> = []
  const junctions = plan.crossings.filter(cross => cross.kind === 'junction')
  const bridges = plan.crossings.filter(cross => cross.kind === 'bridge')
  for (const cross of bridges) {
    if (cross.bridgeLevel > 2) throw new Error(`Нельзя создать мост над «${cross.targetName}»: максимальный уровень +2.`)
    if (cross.along < MIN_APPROACH_METRES || plan.totalLength - cross.along < MIN_APPROACH_METRES) {
      throw new Error(`Для моста над «${cross.targetName}» не хватает длины подъездного участка. Продлите дорогу.`)
    }
    if (!Number.isFinite(cross.bridgeFrom) || !Number.isFinite(cross.bridgeTo) ||
        cross.bridgeFrom < MIN_APPROACH_METRES - EPS || cross.bridgeTo > plan.totalLength - MIN_APPROACH_METRES + EPS ||
        cross.bridgeTo - cross.bridgeFrom < 4 || cross.along <= cross.bridgeFrom || cross.along >= cross.bridgeTo) {
      throw new Error(`У моста над «${cross.targetName}» укажите начало и конец по обе стороны пересечения. Оставьте минимум ${MIN_APPROACH_METRES} м для подъездов.`)
    }
    intervals.push({ from: cross.bridgeFrom, to: cross.bridgeTo, level: cross.bridgeLevel })
  }
  for (const cross of junctions) {
    if (cross.targetLevel !== 0) throw new Error(`Нельзя создать наземный перекрёсток с «${cross.targetName}» уровня +${cross.targetLevel}.`)
    if (intervals.some(interval => cross.along > interval.from - 0.2 && cross.along < interval.to + 0.2)) {
      throw new Error('Обычный перекрёсток находится внутри мостового пролёта. Измените тип пересечения или геометрию.')
    }
  }

  const marks = new Map<string, Mark>()
  plan.path.forEach((vertex, index) => addMark(marks, distances[index]!, { ...vertex }))
  for (const interval of intervals) {
    addMark(marks, interval.from, atDistance(plan, distances, interval.from))
    addMark(marks, interval.to, atDistance(plan, distances, interval.to))
  }
  for (const junction of junctions) addMark(marks, junction.along, { ...junction.vertex })
  const sorted = Array.from(marks.values()).sort((a, b) => a.along - b.along)
  if (sorted.length < 2) throw new Error('Не удалось сформировать геометрию новой дороги.')
  // Resolve shared junction IDs against the existing OSM graph.
  for (const cross of junctions) {
    const mark = marks.get(markKey(cross.along))!
    const target = existing.find(r => r.id === cross.targetRoadId)
    if (!target) continue
    const a = target.vertices[cross.targetSegmentIndex]!, b = target.vertices[cross.targetSegmentIndex + 1]!
    if (cross.targetT < 1e-7) mark.vertex.id = a.id
    else if (cross.targetT > 1 - 1e-7) mark.vertex.id = b.id
  }
  const requestedInsertions = new Map<string, Array<{ index: number; t: number; vertex: RoadVertex }>>()
  const request = (roadId: string, index: number, t: number, vertex: RoadVertex) => {
    if (!requestedInsertions.has(roadId)) requestedInsertions.set(roadId, [])
    requestedInsertions.get(roadId)!.push({ index, t, vertex })
  }
  for (const link of plan.endpoints) {
    const vertex = sorted.find(m => distanceMetres(m.vertex, link.vertex) < 0.2)?.vertex ?? link.vertex
    request(link.roadId, link.segmentIndex, link.t, vertex)
  }
  for (const junction of junctions) request(junction.targetRoadId, junction.targetSegmentIndex, junction.targetT, marks.get(markKey(junction.along))!.vertex)
  const modifiedExisting = new Map<string, RoadVertex[]>()
  for (const [roadId, changes] of requestedInsertions.entries()) {
    const road = existing.find(item => item.id === roadId)
    if (!road) continue
    const bySegment = new Map<number, typeof changes>()
    changes.forEach(change => {
      if (!bySegment.has(change.index)) bySegment.set(change.index, [])
      bySegment.get(change.index)!.push(change)
    })
    const baseVertices = road.vertices.map(vertex => ({ ...vertex }))
    const vertices: RoadVertex[] = []
    for (let i = 0; i < baseVertices.length - 1; i++) {
      const original = baseVertices[i]!
      vertices.push(original)
      const additions = (bySegment.get(i) ?? []).sort((a, b) => a.t - b.t)
      for (const change of additions) {
        if (change.t <= 1e-7) {
          if (original.id !== change.vertex.id) original.id = change.vertex.id
        } else if (change.t < 1 - 1e-7 && vertices[vertices.length - 1]?.id !== change.vertex.id) {
          vertices.push({ ...change.vertex })
        }
      }
      // A junction on the end of a segment must update that existing vertex too.
      for (const change of additions) {
        if (change.t >= 1 - 1e-7 && baseVertices[i + 1]!.id !== change.vertex.id) {
          baseVertices[i + 1]!.id = change.vertex.id
        }
      }
    }
    vertices.push({ ...baseVertices[baseVertices.length - 1]! })
    modifiedExisting.set(roadId, vertices)
  }

  // Consecutive intervals with the same level are a single OSM way.
  const sections: Array<{ level: number; vertices: RoadVertex[] }> = []
  for (let i = 1; i < sorted.length; i++) {
    const first = sorted[i - 1]!, last = sorted[i]!
    if (last.along - first.along < 0.005) continue
    const midpoint = (first.along + last.along) / 2
    const level = intervals.reduce((max, interval) => midpoint >= interval.from - EPS && midpoint <= interval.to + EPS ? Math.max(max, interval.level) : max, 0)
    const previous = sections[sections.length - 1]
    if (previous && previous.level === level) previous.vertices.push(last.vertex)
    else sections.push({ level, vertices: [first.vertex, last.vertex] })
  }
  const nextIdStart = Math.min(0, ...[...existing.map(road => road.osmId), ...reservedWayIds].map(Number).filter(n => Number.isFinite(n) && n < 0)) - 1
  const endpointLevels = plan.endpoints.map(link => existing.find(road => road.id === link.roadId)?.level ?? 0)
  const connectingSameBridgeLevel = endpointLevels.length === 2 && endpointLevels[0]! > 0 && endpointLevels[0] === endpointLevels[1] && bridges.length === 0
  const roads = sections.map((section, index): RoadFeature => ({
    id: crypto.randomUUID(), osmId: String(nextIdStart - index), name: '', highway: 'residential',
    lanes: 2, oneway: false, bridge: section.level > 0 || connectingSameBridgeLevel, level: connectingSameBridgeLevel ? endpointLevels[0]! : section.level,
    vertices: section.vertices.map(vertex => ({ ...vertex })), tags: {},
    visualApproach: {
      start: index === 0 && !!plan.visualApproach?.[0],
      end: index === sections.length - 1 && !!plan.visualApproach?.[1],
    },
  }))
  return { roads, modifiedExisting, bridgeCount: sections.filter(s => s.level > 0).length, junctionCount: junctions.length + plan.endpoints.length }
}
