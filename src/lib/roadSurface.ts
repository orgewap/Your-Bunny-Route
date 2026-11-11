import type { RoadFeature, RoadVertex } from '../types/road'
import { clampRoadLanes, LANE_WIDTH_METRES } from './lanes.ts'
import { distanceMetres } from './topology.ts'

/**
 * The OSM graph must meet at a shared centreline node. The *surface* must end
 * at the edge of the receiving road. Keep the original way untouched and omit
 * only the little centre-to-shoulder spur from 2D / 3D pavement rendering.
 * This is a view model, never an exported rewrite of OSM topology.
 */
export function surfaceVertices(
  road: RoadFeature,
  network: readonly RoadFeature[],
  nodeOwners?: ReadonlyMap<string, readonly RoadFeature[]>,
): RoadVertex[] {
  if (road.vertices.length < 3 || road.bridge || road.level !== 0 ||
      (!road.visualApproach?.start && !road.visualApproach?.end)) return road.vertices
  let result = road.vertices
  const endpoints: Array<'start' | 'end'> = ['start', 'end']
  for (const end of endpoints) {
    if (result.length < 3) break
    if (end === 'start' && !road.visualApproach?.start) continue
    if (end === 'end' && !road.visualApproach?.end) continue
    const first = end === 'start' ? result[0]! : result[result.length - 1]!
    const next = end === 'start' ? result[1]! : result[result.length - 2]!
    const span = distanceMetres(first, next)
    if (span < 0.3 || span > 22) continue
    // When rendering a complete network, use the shared-node index (O(V)),
    // not a full search through every road for each endpoint (O(R² * V)).
    const neighbours = (nodeOwners?.get(first.id) ?? network.filter(other =>
      other.vertices.some(vertex => vertex.id === first.id)))
      .filter(other => other.id !== road.id && other.level === road.level && !other.bridge)
    let hide = false
    for (const receiving of neighbours) {
      // Only an explicitly recorded lane attachment is eligible for trimming.
      // The receiving road may end exactly at the junction; requiring an
      // interior node incorrectly displayed a centreline spur at way ends.
      const index = receiving.vertices.findIndex(vertex => vertex.id === first.id)
      if (index < 0 || receiving.vertices.length < 2) continue
      const width = clampRoadLanes(receiving.lanes) * LANE_WIDTH_METRES / 2
      if (span > width + 3.5) continue
      const prev = receiving.vertices[Math.max(0, index - 1)]!
      const following = receiving.vertices[Math.min(receiving.vertices.length - 1, index + 1)]!
      const metresPerLng = 111_320 * Math.cos(first.lat * Math.PI / 180)
      const alongX = (following.lng - prev.lng) * metresPerLng
      const alongY = (following.lat - prev.lat) * 111_320
      const spurX = (next.lng - first.lng) * metresPerLng
      const spurY = (next.lat - first.lat) * 111_320
      const denominator = Math.hypot(alongX, alongY) * Math.hypot(spurX, spurY)
      if (denominator < 1e-4) continue
      const alignment = Math.abs((alongX * spurX + alongY * spurY) / denominator)
      // A short, near-perpendicular segment crossing the road's half-width.
      if (alignment < 0.52 && span > 1.0) { hide = true; break }
    }
    if (hide) result = end === 'start' ? result.slice(1) : result.slice(0, -1)
  }
  return result
}

/** Build a surface network without ever changing source IDs or exported ways. */
export function surfaceNetwork(roads: readonly RoadFeature[]): RoadFeature[] {
  const byNode = new Map<string, RoadFeature[]>()
  for (const road of roads) {
    // The same OSM node can occur twice in a closed ring. Index one owner once.
    const seen = new Set<string>()
    for (const vertex of road.vertices) {
      if (seen.has(vertex.id)) continue
      seen.add(vertex.id)
      const owners = byNode.get(vertex.id) ?? []
      owners.push(road)
      byNode.set(vertex.id, owners)
    }
  }
  return roads.map(road => ({ ...road, vertices: surfaceVertices(road, roads, byNode) }))
}

/** Metric offset around a polyline, with a bounded miter at turns. */
export function offsetRoadPolyline(vertices: readonly RoadVertex[], offset: number): RoadVertex[] {
  if (vertices.length < 2 || Math.abs(offset) < 1e-7) return vertices.map(v => ({ ...v }))
  return vertices.map((point, index) => {
    const prev = vertices[Math.max(0, index - 1)]!
    const next = vertices[Math.min(index + 1, vertices.length - 1)]!
    const lngScale = 111_320 * Math.max(0.01, Math.cos(point.lat * Math.PI / 180))
    const dx = (next.lng - prev.lng) * lngScale
    const dy = (next.lat - prev.lat) * 111_320
    const length = Math.hypot(dx, dy)
    if (length < 0.00001) return { ...point }
    // Right normal for travel along the way, consistent with laneSnap.
    return {
      ...point,
      lng: point.lng + (dy / length) * offset / lngScale,
      lat: point.lat - (dx / length) * offset / 111_320,
    }
  })
}
