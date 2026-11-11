import type { RoadVertex } from '../types/road'

/** Quadratic Bézier for a three-click curve: start -> control -> finish. */
export function sampleBezier(start: RoadVertex, control: RoadVertex, end: RoadVertex, steps = 24): RoadVertex[] {
  const points: RoadVertex[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const a = (1 - t) * (1 - t)
    const b = 2 * (1 - t) * t
    const c = t * t
    points.push({
      id: crypto.randomUUID(),
      lng: a * start.lng + b * control.lng + c * end.lng,
      lat: a * start.lat + b * control.lat + c * end.lat,
    })
  }
  points[0]!.id = start.id
  points[points.length - 1]!.id = end.id
  return points
}

export function roadLengthMeters(vertices: RoadVertex[]): number {
  let distance = 0
  for (let i = 1; i < vertices.length; i++) {
    const a = vertices[i - 1]!
    const b = vertices[i]!
    const dlat = (b.lat - a.lat) * 111_320
    const dlng = (b.lng - a.lng) * 111_320 * Math.cos(a.lat * Math.PI / 180)
    distance += Math.hypot(dlat, dlng)
  }
  return distance
}


