import type { RoadFeature, RoadVertex } from '../types/road'
import type { TargetLink } from './topology.ts'
import { distanceMetres, isTrafficRoad } from './topology.ts'
import { clampRoadLanes, LANE_WIDTH_METRES } from './lanes.ts'

export type ScreenPoint = { x: number; y: number }
export type LaneProjection = (lng: number, lat: number, heightMetres: number) => ScreenPoint | null
export interface LaneSnapResult {
  /** The point drawn under the user's pointer, at the selected lane/boundary. */
  visibleVertex: RoadVertex
  /** Actual OSM junction on the original way's centreline. */
  link: TargetLink
  laneIndex: number
  laneCount: number
  boundary: boolean
  screenDistance: number
}

function offsetGeo(a: RoadVertex, b: RoadVertex, t: number, offsetMetres: number): RoadVertex {
  const lat = a.lat + (b.lat - a.lat) * t
  const lng = a.lng + (b.lng - a.lng) * t
  const latFactor = 111_320
  const lngFactor = latFactor * Math.max(0.01, Math.cos(lat * Math.PI / 180))
  const dx = (b.lng - a.lng) * lngFactor
  const dy = (b.lat - a.lat) * latFactor
  const length = Math.hypot(dx, dy)
  if (length < 0.001) return { id: crypto.randomUUID(), lng, lat }
  // Positive lane offset is to the RIGHT in way travel direction, matching
  // MapLibre's positive line-offset and the existing laneVisualFeatures model.
  return {
    id: crypto.randomUUID(),
    lng: lng + (dy / length) * offsetMetres / lngFactor,
    lat: lat - (dx / length) * offsetMetres / latFactor,
  }
}

function screenDistance(pointer: ScreenPoint, a: ScreenPoint, b: ScreenPoint): { t: number; distance: number } {
  const dx = b.x - a.x, dy = b.y - a.y
  const denominator = dx * dx + dy * dy
  if (denominator < 0.000001) return { t: 0, distance: Number.POSITIVE_INFINITY }
  const t = Math.max(0, Math.min(1, ((pointer.x - a.x) * dx + (pointer.y - a.y) * dy) / denominator))
  return { t, distance: Math.hypot(pointer.x - (a.x + t * dx), pointer.y - (a.y + t * dy)) }
}

/**
 * Pick ANY visible stripe or boundary (including both outside edges), not
 * merely the OSM way's centreline. The snapped OSM junction remains on the
 * centreline; the selected lateral position becomes a short approach vertex.
 * This preserves valid way/node topology without inventing duplicate OSM ways.
 */
export function snapToLaneAtScreen(
  pointer: ScreenPoint,
  roads: readonly RoadFeature[],
  project: LaneProjection,
  zoom: number,
  mode: '2d' | '3d',
  tolerancePx = 12,
  preferredLevel: number | null = null,
): LaneSnapResult | null {
  if (mode === '2d' && zoom < 14) return null
  let best: (LaneSnapResult & { level: number }) | null = null

  for (const road of roads) {
    if (!isTrafficRoad(road) || road.vertices.length < 2) continue
    const count = clampRoadLanes(road.lanes)
    const elevation = mode === '3d' ? road.level * 5 : 0
    for (let segmentIndex = 0; segmentIndex < road.vertices.length - 1; segmentIndex++) {
      const a = road.vertices[segmentIndex]!, b = road.vertices[segmentIndex + 1]!
      if (distanceMetres(a, b) < 0.01) continue
      const aScreen = project(a.lng, a.lat, elevation)
      const bScreen = project(b.lng, b.lat, elevation)
      if (!aScreen || !bScreen) continue
      const dx = bScreen.x - aScreen.x, dy = bScreen.y - aScreen.y
      const magnitude = Math.hypot(dx, dy)
      if (magnitude < 0.001) continue
      // Mousemove runs over the whole imported network. Skip distant segments
      // before calculating all lane/border tracks.
      const distanceFromAxis = screenDistance(pointer, aScreen, bScreen).distance
      // Use one real-metre screen projection for all 2D stripes instead of
      // projecting 10–20 offset segments on *every* mousemove. WebMercator
      // lane widths are now rendered in real metres, not arbitrary pixels.
      const nx = -dy / magnitude, ny = dx / magnitude
      const midpoint = { x: (aScreen.x + bScreen.x) / 2, y: (aScreen.y + bScreen.y) / 2 }
      const unitRight = offsetGeo(a, b, 0.5, 1)
      const oneMetre = project(unitRight.lng, unitRight.lat, elevation)
      const pxPerMetre = oneMetre
        ? Math.hypot(oneMetre.x - midpoint.x, oneMetre.y - midpoint.y) : 0
      const maxShiftPx = count / 2 * LANE_WIDTH_METRES * pxPerMetre
      if (distanceFromAxis > maxShiftPx + tolerancePx + 3) continue

      // At half-integer offsets: lane CENTRES. At integer/half-integer
      // boundaries: lane edges, including the two outer carriageway edges.
      for (let halfIndex = 0; halfIndex <= count * 2; halfIndex++) {
        const laneOffset = (halfIndex - count) / 2
        const boundary = halfIndex % 2 === 0
        const offsetMetres = laneOffset * LANE_WIDTH_METRES
        let begin: ScreenPoint | null, end: ScreenPoint | null
        if (mode === '2d') {
          const shift = offsetMetres * pxPerMetre
          begin = { x: aScreen.x + nx * shift, y: aScreen.y + ny * shift }
          end = { x: bScreen.x + nx * shift, y: bScreen.y + ny * shift }
        } else {
          const left = offsetGeo(a, b, 0, offsetMetres)
          const right = offsetGeo(a, b, 1, offsetMetres)
          begin = project(left.lng, left.lat, elevation)
          end = project(right.lng, right.lat, elevation)
        }
        if (!begin || !end) continue
        const hit = screenDistance(pointer, begin, end)
        if (hit.distance > tolerancePx) continue
        if (best) {
          const diff = hit.distance - best.screenDistance
          if (diff > 0.75) continue
          if (Math.abs(diff) <= 0.75) {
            if (preferredLevel !== null) {
              if (best.level === preferredLevel && road.level !== preferredLevel) continue
              if (road.level !== preferredLevel && best.level !== preferredLevel && diff >= 0) continue
            } else {
              if (road.level < best.level) continue
              if (road.level === best.level && diff >= 0) continue
            }
          }
        }
        const segmentLength = distanceMetres(a, b)
        let t = hit.t
        let centre: RoadVertex = {
          id: crypto.randomUUID(),
          lng: a.lng + (b.lng - a.lng) * t,
          lat: a.lat + (b.lat - a.lat) * t,
        }
        if (t * segmentLength <= 1.2) { t = 0; centre = { ...a } }
        else if ((1 - t) * segmentLength <= 1.2) { t = 1; centre = { ...b } }

        const visibleVertex = offsetGeo(a, b, t, offsetMetres)
        const laneIndex = Math.max(0, Math.min(count - 1, Math.floor(halfIndex / 2)))
        const link: TargetLink = {
          roadId: road.id, segmentIndex, t, vertex: centre,
          laneAttachment: {
            laneIndex, laneCount: count, boundary,
            offsetMetres, visibleVertex,
          },
        }
        best = { visibleVertex, link, laneIndex, laneCount: count, boundary, screenDistance: hit.distance, level: road.level }
      }
    }
  }
  return best
}
