import type { RoadVertex } from '../types/road'

/** Screen-space samples preserve mouse motion without creating a vertex for every event. */
export interface ScreenPoint { x: number; y: number }
export interface FreehandSample {
  vertex: RoadVertex
  screen: ScreenPoint
}

export function appendFreehandSample(
  samples: readonly FreehandSample[],
  vertex: RoadVertex,
  screen: ScreenPoint,
  minSpacingPx = 3,
  forceEndpoint = false,
): FreehandSample[] {
  const next = { vertex: { ...vertex }, screen: { ...screen } }
  const last = samples[samples.length - 1]
  if (!last) return [next]
  const distance = Math.hypot(last.screen.x - screen.x, last.screen.y - screen.y)
  if (distance < minSpacingPx) {
    // A final click must use the precise snapped OSM node, not a nearby raw sample.
    return forceEndpoint && samples.length >= 2
      ? [...samples.slice(0, -1), next]
      : [...samples]
  }
  return [...samples, next]
}

/** Ramer–Douglas–Peucker in screen pixels: preserves the shape and both OSM endpoints. */
export function simplifyFreehandSamples(
  samples: readonly FreehandSample[],
  tolerancePx = 1.3,
): FreehandSample[] {
  if (samples.length < 3) return [...samples]
  const keep = new Set([0, samples.length - 1])
  const intervals: Array<[number, number]> = [[0, samples.length - 1]]
  const toleranceSquared = tolerancePx * tolerancePx
  while (intervals.length) {
    const [first, last] = intervals.pop()!
    const a = samples[first]!.screen, b = samples[last]!.screen
    const dx = b.x - a.x, dy = b.y - a.y
    const squared = dx * dx + dy * dy
    let maxDistance = toleranceSquared, farthest = -1
    for (let i = first + 1; i < last; i++) {
      const p = samples[i]!.screen
      const t = squared > 0
        ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / squared))
        : 0
      const deviation = (p.x - a.x - t * dx) ** 2 + (p.y - a.y - t * dy) ** 2
      if (deviation > maxDistance) {
        maxDistance = deviation
        farthest = i
      }
    }
    if (farthest !== -1) {
      keep.add(farthest)
      intervals.push([first, farthest], [farthest, last])
    }
  }
  return samples.filter((_, index) => keep.has(index))
}

/** Catmull–Rom path through clicked vertices. Every control vertex remains on the road. */
export function samplePenCurve(knots: readonly RoadVertex[], stepsPerSpan = 10): RoadVertex[] {
  if (knots.length < 3) return knots.map(point => ({ ...point }))
  const sampled: RoadVertex[] = []
  const steps = Math.max(2, Math.floor(stepsPerSpan))
  for (let i = 0; i < knots.length - 1; i++) {
    const p0 = knots[Math.max(0, i - 1)]!
    const p1 = knots[i]!
    const p2 = knots[i + 1]!
    const p3 = knots[Math.min(knots.length - 1, i + 2)]!
    for (let j = 0; j < steps; j++) {
      if (j === 0) {
        sampled.push({ ...p1 })
        continue
      }
      const t = j / steps, t2 = t * t, t3 = t2 * t
      const catmull = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2
          + (-a + 3 * b - 3 * c + d) * t3)
      sampled.push({
        id: crypto.randomUUID(),
        lng: catmull(p0.lng, p1.lng, p2.lng, p3.lng),
        lat: catmull(p0.lat, p1.lat, p2.lat, p3.lat),
      })
    }
  }
  sampled.push({ ...knots[knots.length - 1]! })
  return sampled
}

/**
 * Geometrically correct ellipse in local metres (not longitude degrees).
 * 1st click: centre; 2nd click: main radius/orientation;
 * 3rd click: perpendicular radius. Shift on third click => exact circle.
 */
export interface PenEllipseAxes {
  majorMetres: number
  minorMetres: number
  /** Counterclockwise angle of the first radius, relative to east. */
  rotationRadians: number
}

/** Shared metric axes for the ellipse preview and roundabout topology. */
export function penEllipseAxes(
  center: RoadVertex,
  axisPoint: RoadVertex,
  widthPoint: RoadVertex | null,
  circle = false,
): PenEllipseAxes {
  const metreLat = 111_320
  const metreLng = metreLat * Math.cos(center.lat * Math.PI / 180)
  const dx = (axisPoint.lng - center.lng) * metreLng
  const dy = (axisPoint.lat - center.lat) * metreLat
  const majorMetres = Math.hypot(dx, dy)
  if (majorMetres < 2) throw new Error('Радиус должен быть не меньше 2 метров.')
  const ux = dx / majorMetres, uy = dy / majorMetres
  const width = widthPoint
    ? Math.abs((widthPoint.lng - center.lng) * metreLng * -uy
      + (widthPoint.lat - center.lat) * metreLat * ux)
    : majorMetres
  const minorMetres = circle ? majorMetres : width
  if (minorMetres < 2) throw new Error('Ширина овала должна быть не меньше 2 метров.')
  return { majorMetres, minorMetres, rotationRadians: Math.atan2(uy, ux) }
}

export function samplePenEllipse(
  center: RoadVertex,
  axisPoint: RoadVertex,
  widthPoint: RoadVertex | null,
  circle = false,
  steps = 96,
): RoadVertex[] {
  const { majorMetres, minorMetres, rotationRadians } = penEllipseAxes(center, axisPoint, widthPoint, circle)
  const metreLat = 111_320
  const metreLng = metreLat * Math.cos(center.lat * Math.PI / 180)
  const ux = Math.cos(rotationRadians), uy = Math.sin(rotationRadians)
  const vx = -uy, vy = ux
  const count = Math.max(24, Math.floor(steps))
  const firstId = crypto.randomUUID()
  const vertices: RoadVertex[] = []
  for (let i = 0; i < count; i++) {
    const angle = 2 * Math.PI * i / count
    const x = majorMetres * Math.cos(angle) * ux + minorMetres * Math.sin(angle) * vx
    const y = majorMetres * Math.cos(angle) * uy + minorMetres * Math.sin(angle) * vy
    vertices.push({
      id: i === 0 ? firstId : crypto.randomUUID(),
      lng: center.lng + x / metreLng,
      lat: center.lat + y / metreLat,
    })
  }
  // Proper closed OSM way: identical first/last node ID.
  vertices.push({ ...vertices[0]! })
  return vertices
}

export function previewPen(
  mode: 'draw' | 'curve' | 'freehand' | 'ellipse',
  fixed: readonly RoadVertex[],
  cursor: RoadVertex | null,
  circle = false,
): RoadVertex[] {
  if (mode !== 'ellipse') {
    const points = cursor ? [...fixed, cursor] : [...fixed]
    return mode === 'curve' ? samplePenCurve(points) : points
  }
  if (!fixed.length || (!cursor && fixed.length < 2)) return []
  if (fixed.length === 1 && cursor) {
    try { return samplePenEllipse(fixed[0]!, cursor, null, true) }
    catch { return [] }
  }
  if (fixed.length >= 2) {
    try { return samplePenEllipse(fixed[0]!, fixed[1]!, cursor, circle) }
    catch { return [] }
  }
  return []
}
