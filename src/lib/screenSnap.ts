import type { RoadFeature, RoadVertex } from '../types/road'
import type { TargetLink } from './topology.ts'
import { distanceMetres } from './topology.ts'

export type ScreenPoint = { x: number; y: number }
export type ProjectElevated = (lng: number, lat: number, elevation: number) => ScreenPoint | null

/** Hit-test the VISIBLE deck, not the ground coordinate returned by MapMouseEvent.lngLat. */
export function snapElevatedAtScreen(
  pointer: ScreenPoint,
  roads: RoadFeature[],
  project: ProjectElevated,
  tolerancePx = 16,
): TargetLink | null {
  let best: TargetLink | null = null
  let bestDistance = tolerancePx
  for (const road of roads) {
    if (road.level <= 0 || road.vertices.length < 2) continue
    const elevation = road.level * 5
    for (let i = 1; i < road.vertices.length; i++) {
      const a = road.vertices[i - 1]!
      const b = road.vertices[i]!
      const aScreen = project(a.lng, a.lat, elevation)
      const bScreen = project(b.lng, b.lat, elevation)
      if (!aScreen || !bScreen) continue
      const dx = bScreen.x - aScreen.x
      const dy = bScreen.y - aScreen.y
      const denominator = dx * dx + dy * dy
      if (denominator < 0.00001) continue
      const fraction = Math.max(0, Math.min(1,
        ((pointer.x - aScreen.x) * dx + (pointer.y - aScreen.y) * dy) / denominator,
      ))
      const distance = Math.hypot(
        pointer.x - (aScreen.x + dx * fraction),
        pointer.y - (aScreen.y + dy * fraction),
      )
      if (distance >= bestDistance) continue
      const segmentMetres = distanceMetres(a, b)
      let t = fraction
      let vertex: RoadVertex = {
        id: crypto.randomUUID(),
        lng: a.lng + (b.lng - a.lng) * t,
        lat: a.lat + (b.lat - a.lat) * t,
      }
      // Reuse a real existing OSM node where possible.
      if (t * segmentMetres <= 1.2) { t = 0; vertex = { ...a } }
      else if ((1 - t) * segmentMetres <= 1.2) { t = 1; vertex = { ...b } }
      best = { roadId: road.id, segmentIndex: i - 1, t, vertex }
      bestDistance = distance
    }
  }
  return best
}
