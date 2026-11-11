import type { RoadFeature, RoadVertex } from '../types/road'
import type { InfrastructureFeature } from './infrastructure.ts'
import { isTrafficRoad, distanceMetres } from './topology.ts'
import { clampRoadLanes, LANE_WIDTH_METRES } from './lanes.ts'

export type CrosswalkFeature = {
  type: 'Feature'
  properties: { sourceId: string; marked: boolean; inferred: boolean }
  geometry: { type: 'Polygon'; coordinates: number[][][] }
}
function pointProjection(p: RoadVertex, a: RoadVertex, b: RoadVertex): { point: RoadVertex; distance: number; vector: [number, number] } {
  const cos = Math.max(0.1, Math.cos(p.lat * Math.PI / 180))
  const dx = (b.lng - a.lng) * 111_320 * cos, dy = (b.lat - a.lat) * 111_320
  const x = (p.lng - a.lng) * 111_320 * cos, y = (p.lat - a.lat) * 111_320
  const len2 = dx * dx + dy * dy
  const t = Math.max(0, Math.min(1, (x * dx + y * dy) / (len2 || 1)))
  const point = { id: '', lng: a.lng + (b.lng - a.lng) * t, lat: a.lat + (b.lat - a.lat) * t }
  const len = Math.sqrt(len2) || 1
  return { point, distance: distanceMetres(p, point), vector: [dx / len, dy / len] }
}
function crossingMarking(tags: Record<string, string>): 'marked' | 'inferred' | 'unmarked' {
  const mark = (tags['crossing:markings'] || '').toLowerCase()
  const crossing = (tags.crossing || '').toLowerCase()
  if (['no', 'unmarked', 'informal', 'none'].includes(mark) ||
      ['no', 'unmarked', 'informal'].includes(crossing)) return 'unmarked'
  if ((mark && mark !== 'unknown') || ['zebra', 'marked'].includes(crossing)) return 'marked'
  return 'inferred'
}
/**
 * Painted zebra bars are physically-sized POLYGONS (not pixel-width lines), so
 * they grow with the map at every zoom. Each long bar is parallel to the road
 * axis; the series runs ACROSS its width. Only explicitly marked crossings
 * receive paint — crossing=traffic_signals alone doesn't imply a zebra.
 */
export function crosswalkStripeFeatures(roads: readonly RoadFeature[], infra: readonly InfrastructureFeature[]): CrosswalkFeature[] {
  const motor = roads.filter(road => isTrafficRoad(road) && road.level === 0 && road.vertices.length > 1)
  type Segment = { road: RoadFeature; a: RoadVertex; b: RoadVertex }
  const cellSize = 0.002
  const grid = new Map<string, Segment[]>()
  const longSegments: Segment[] = []
  const key = (x: number, y: number) => `${x},${y}`
  for (const road of motor) for (let i = 1; i < road.vertices.length; i++) {
    const a = road.vertices[i - 1]!, b = road.vertices[i]!
    const segment = { road, a, b }
    const minX = Math.floor(Math.min(a.lng, b.lng) / cellSize), maxX = Math.floor(Math.max(a.lng, b.lng) / cellSize)
    const minY = Math.floor(Math.min(a.lat, b.lat) / cellSize), maxY = Math.floor(Math.max(a.lat, b.lat) / cellSize)
    if (maxX - minX > 16 || maxY - minY > 16) { longSegments.push(segment); continue }
    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) {
      const bucket = key(x, y)
      const entries = grid.get(bucket) ?? []
      entries.push(segment)
      grid.set(bucket, entries)
    }
  }
  const candidates: Array<{ id: string; at: RoadVertex; tags: Record<string, string> }> = []
  for (const feature of infra) if (feature.kind === 'crossing' && feature.vertices.length) {
    candidates.push({ id: feature.id, at: feature.vertices[0]!, tags: feature.tags })
  }
  for (const road of roads) if (road.tags.footway === 'crossing' || road.highway === 'footway' && road.tags.crossing) {
    const start = road.vertices[0], end = road.vertices[road.vertices.length - 1]
    if (start && end) {
      const midpoint = { ...start, lng: (start.lng + end.lng) / 2, lat: (start.lat + end.lat) / 2 }
      candidates.push({ id: road.id, at: midpoint, tags: road.tags })
    }
  }
  const emitted: RoadVertex[] = []
  const stripes: CrosswalkFeature[] = []
  for (const candidate of candidates) {
    // Don't invent visible crosswalk paint where OSM only has a crossing node.
    if (crossingMarking(candidate.tags) !== 'marked') continue
    let best: { road: RoadFeature; point: RoadVertex; distance: number; vector: [number, number] } | null = null
    const cx = Math.floor(candidate.at.lng / cellSize), cy = Math.floor(candidate.at.lat / cellSize)
    const nearby = [...longSegments]
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      nearby.push(...(grid.get(key(cx + dx, cy + dy)) ?? []))
    }
    for (const segment of nearby) {
      const projected = pointProjection(candidate.at, segment.a, segment.b)
      if (projected.distance < (best?.distance ?? 12)) best = { road: segment.road, ...projected }
    }
    if (!best || emitted.some(at => distanceMetres(at, best!.point) < 3)) continue
    emitted.push(best.point)
    const cos = Math.max(0.1, Math.cos(best.point.lat * Math.PI / 180))
    const roadWidth = clampRoadLanes(best.road.lanes) * LANE_WIDTH_METRES
    const [ux, uy] = best.vector
    const nx = -uy, ny = ux
    // A 0.46m-wide bar every 0.85m across the roadway, ~3m long in its axis.
    const pitch = 0.85, width = 0.46, length = 3.0
    const count = Math.max(2, Math.floor((roadWidth - 0.4) / pitch))
    const toLngLat = (along: number, across: number): number[] => [
      best.point.lng + (ux * along + nx * across) / (111_320 * cos),
      best.point.lat + (uy * along + ny * across) / 111_320,
    ]
    for (let i = 0; i < count; i++) {
      const x = (i - (count - 1) / 2) * pitch
      const corners = [
        toLngLat(-length / 2, x - width / 2),
        toLngLat(length / 2, x - width / 2),
        toLngLat(length / 2, x + width / 2),
        toLngLat(-length / 2, x + width / 2),
      ]
      stripes.push({ type: 'Feature', properties: { sourceId: candidate.id, marked: true, inferred: false },
        geometry: { type: 'Polygon', coordinates: [[...corners, corners[0]!.slice()]] } })
    }
  }
  return stripes
}
