import type { RoadFeature } from '../types/road'

/** Each imported OSM way retains ONE centreline; individual traffic lanes are rendered from it. */
export const MAX_ROAD_LANES = 10
export const LANE_WIDTH_METRES = 3.2

/** Exact width stops used by the 2D MapLibre lane offset style. */
export const LANE_VISUAL_WIDTH_STOPS: ReadonlyArray<readonly [number, number]> = [
  [14, 2.2], [15, 2.9], [16, 4.3], [17, 6.7], [18, 12], [19, 22],
]
export function laneVisualWidthPx(zoom: number): number {
  if (zoom <= 14) return 2.2
  if (zoom >= 19) return 22
  for (let i = 1; i < LANE_VISUAL_WIDTH_STOPS.length; i++) {
    const [zoomEnd, widthEnd] = LANE_VISUAL_WIDTH_STOPS[i]!
    const [zoomStart, widthStart] = LANE_VISUAL_WIDTH_STOPS[i - 1]!
    if (zoom <= zoomEnd) return widthStart + (widthEnd - widthStart) * (zoom - zoomStart) / (zoomEnd - zoomStart)
  }
  return 22
}

export function clampRoadLanes(value: number): number {
  if (!Number.isFinite(value)) return 2
  return Math.min(MAX_ROAD_LANES, Math.max(1, Math.floor(value)))
}

function parsedLaneTag(value: string | undefined): number | null {
  if (!value || !/^\s*\d+\s*$/.test(value)) return null
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/** Respect OSM lanes=* first; directional counts are the fallback when total is absent. */
export function importedLaneCount(tags: Record<string, string>): number {
  const explicit = parsedLaneTag(tags.lanes)
  if (explicit !== null) return clampRoadLanes(explicit)
  const forward = parsedLaneTag(tags['lanes:forward'])
  const backward = parsedLaneTag(tags['lanes:backward'])
  return clampRoadLanes((forward ?? 0) + (backward ?? 0) || 2)
}

/** Counts are in the order of the OSM way; don't duplicate OSM ways for each lane. */
export function laneDirections(road: Pick<RoadFeature, 'lanes' | 'oneway' | 'tags'>): {
  forward: number
  backward: number
} {
  const count = clampRoadLanes(road.lanes)
  if (road.oneway) {
    return road.tags.oneway === '-1'
      ? { forward: 0, backward: count }
      : { forward: count, backward: 0 }
  }
  if (count === 1) return { forward: 1, backward: 0 }
  const f = parsedLaneTag(road.tags['lanes:forward'])
  const b = parsedLaneTag(road.tags['lanes:backward'])
  if (f !== null && b !== null && f + b === count) return { forward: f, backward: b }
  if (f !== null && f < count) return { forward: f, backward: count - f }
  if (b !== null && b < count) return { forward: count - b, backward: b }
  return { forward: Math.ceil(count / 2), backward: Math.floor(count / 2) }
}

export interface LaneFeature {
  type: 'Feature'
  properties: {
    roadId: string
    selected: boolean
    bridge: boolean
    level: number
    lanes: number
    laneIndex: number
    laneOffset: number
    /** Metres-per-pixel depends on latitude in WebMercator. */
    latitudeFactor: number
    direction: 'forward' | 'backward' | 'shared'
  }
  geometry: { type: 'LineString'; coordinates: number[][] }
}

export interface LaneJunctionFeature {
  type: 'Feature'
  properties: {
    vertexId: string
    lanes: number
    connectedRoads: number
    bridge: boolean
  }
  geometry: { type: 'Point'; coordinates: number[] }
}

/** MapLibre line-offset works in screen pixels, so each lane is visible at editing zoom. */
export function laneVisualFeatures(roads: readonly RoadFeature[], selectedId: string | null): LaneFeature[] {
  const result: LaneFeature[] = []
  for (const road of [...roads].sort((a, b) => a.level - b.level)) {
    if (road.vertices.length < 2) continue
    const count = clampRoadLanes(road.lanes)
    const distribution = laneDirections(road)
    const coordinates = road.vertices.map(vertex => [vertex.lng, vertex.lat])
    for (let laneIndex = 0; laneIndex < count; laneIndex++) {
      result.push({
        type: 'Feature',
        properties: {
          roadId: road.id,
          selected: road.id === selectedId,
          bridge: road.bridge,
          level: road.level,
          lanes: count,
          laneIndex,
          laneOffset: laneIndex - (count - 1) / 2,
          latitudeFactor: 1 / Math.max(0.02, Math.cos(road.vertices[0]!.lat * Math.PI / 180)),
          direction: count === 1 && !road.oneway ? 'shared'
            : laneIndex < distribution.backward ? 'backward' : 'forward',
        },
        geometry: { type: 'LineString', coordinates },
      })
    }
  }
  return result
}

/** A junction is created only by a shared OSM vertex ID, NEVER by merely crossing lines. */
export function laneJunctionFeatures(roads: readonly RoadFeature[]): LaneJunctionFeature[] {
  const nodes = new Map<string, {
    coords: number[]
    roads: Set<string>
    maxLanes: number
    bridge: boolean
  }>()
  for (const road of roads) {
    if (road.vertices.length < 2) continue
    for (const vertex of road.vertices) {
      const entry = nodes.get(vertex.id) ?? {
        coords: [vertex.lng, vertex.lat], roads: new Set<string>(), maxLanes: 0, bridge: false,
      }
      entry.roads.add(road.id)
      entry.maxLanes = Math.max(entry.maxLanes, clampRoadLanes(road.lanes))
      entry.bridge ||= road.level > 0
      nodes.set(vertex.id, entry)
    }
  }
  const result: LaneJunctionFeature[] = []
  for (const [vertexId, entry] of nodes) {
    if (entry.roads.size < 2) continue
    result.push({
      type: 'Feature',
      properties: { vertexId, lanes: entry.maxLanes, connectedRoads: entry.roads.size, bridge: entry.bridge },
      geometry: { type: 'Point', coordinates: entry.coords },
    })
  }
  return result
}
