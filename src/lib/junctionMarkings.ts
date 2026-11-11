import type { RoadFeature, RoadVertex } from '../types/road'
import { clampRoadLanes, LANE_WIDTH_METRES } from './lanes.ts'
import { distanceMetres, isTrafficRoad } from './topology.ts'

/**
 * The centre-line OSM graph has nodes in the middle of junctions. Painted lane
 * dividers MUST terminate at the adjacent carriageway edge, not cross the
 * middle of the intersection. This is presentation geometry only: exported
 * OSM ways and their shared node IDs are never changed.
 */
export function roadMarkingSections(roads: readonly RoadFeature[], drawnRoads: readonly RoadFeature[] = roads): Map<string, RoadVertex[][]> {
  type Arm = { roadId: string; vertexId: string; halfWidth: number }
  const armsAtNode = new Map<string, Arm[]>()
  const drivable = roads.filter(road => isTrafficRoad(road) && road.vertices.length >= 2)
  for (const road of drivable) {
    const halfWidth = clampRoadLanes(road.lanes) * LANE_WIDTH_METRES / 2
    for (let i = 0; i < road.vertices.length; i++) {
      const vertex = road.vertices[i]!
      const arms = [road.vertices[i - 1], road.vertices[i + 1]]
        .filter((other): other is RoadVertex => !!other && distanceMetres(vertex, other) > 0.05)
      if (!arms.length) continue
      const key = `${road.level}:${vertex.id}`
      const bucket = armsAtNode.get(key) ?? []
      for (const _ of arms) bucket.push({ roadId: road.id, vertexId: vertex.id, halfWidth })
      armsAtNode.set(key, bucket)
    }
  }

  const cutsByRoad = new Map<string, Map<string, number>>()
  for (const arms of armsAtNode.values()) {
    // A normal join between two consecutive OSM ways has TWO arms, not a junction.
    if (arms.length < 3 || new Set(arms.map(arm => arm.roadId)).size < 2) continue
    for (const arm of arms) {
      const crossWidth = Math.max(0, ...arms.filter(other => other.roadId !== arm.roadId)
        .map(other => other.halfWidth))
      if (!crossWidth) continue
      const cuts = cutsByRoad.get(arm.roadId) ?? new Map<string, number>()
      cuts.set(arm.vertexId, Math.max(cuts.get(arm.vertexId) ?? 0, Math.min(24, crossWidth + 1.1)))
      cutsByRoad.set(arm.roadId, cuts)
    }
  }

  const result = new Map<string, RoadVertex[][]>()
  for (const road of drawnRoads.filter(road => isTrafficRoad(road) && road.vertices.length >= 2)) {
    const cuts = cutsByRoad.get(road.id)
    if (!cuts?.size) {
      result.set(road.id, [road.vertices])
      continue
    }
    const vertices = road.vertices
    const distances = [0]
    for (let i = 1; i < vertices.length; i++) {
      distances.push(distances[i - 1]! + distanceMetres(vertices[i - 1]!, vertices[i]!))
    }
    const total = distances[distances.length - 1]!
    if (total < 0.1) { result.set(road.id, []); continue }
    const removed = vertices.flatMap((vertex, index) => {
      const radius = cuts.get(vertex.id)
      return radius === undefined ? [] : [{
        from: Math.max(0, distances[index]! - radius),
        to: Math.min(total, distances[index]! + radius),
      }]
    }).sort((a, b) => a.from - b.from)
    const merged: Array<{ from: number; to: number }> = []
    for (const interval of removed) {
      const last = merged[merged.length - 1]
      if (last && interval.from <= last.to) last.to = Math.max(last.to, interval.to)
      else merged.push({ ...interval })
    }
    const pointAt = (metres: number): RoadVertex => {
      for (let i = 1; i < vertices.length; i++) {
        if (distances[i]! + 1e-7 < metres) continue
        const len = distances[i]! - distances[i - 1]!
        const t = len > 1e-7 ? Math.max(0, Math.min(1, (metres - distances[i - 1]!) / len)) : 0
        const a = vertices[i - 1]!, b = vertices[i]!
        return { id: a.id, lng: a.lng + (b.lng - a.lng) * t,
          lat: a.lat + (b.lat - a.lat) * t }
      }
      return { ...vertices[vertices.length - 1]! }
    }
    const section = (start: number, end: number): RoadVertex[] => {
      if (end - start < 0.35) return []
      const points = [pointAt(start)]
      for (let i = 1; i < vertices.length - 1; i++) {
        if (distances[i]! > start + 1e-6 && distances[i]! < end - 1e-6) points.push(vertices[i]!)
      }
      points.push(pointAt(end))
      return points
    }
    let cursor = 0
    const visible: RoadVertex[][] = []
    for (const interval of merged) {
      const points = section(cursor, interval.from)
      if (points.length >= 2) visible.push(points)
      cursor = Math.max(cursor, interval.to)
    }
    const tail = section(cursor, total)
    if (tail.length >= 2) visible.push(tail)
    result.set(road.id, visible)
  }
  return result
}
