/** Uniform metre-grid used only to place 3D scenery. OSM topology is unchanged.
 * A nearest-road query should visit streets near the point, not every street
 * in an imported city. */
import type { RoadFeature, RoadVertex } from '../types/road.ts'
import { clampRoadLanes, LANE_WIDTH_METRES } from './lanes.ts'

export interface SceneRoadSegment {
  road: RoadFeature
  segmentIndex: number
  a: RoadVertex
  b: RoadVertex
  radius: number
  ax: number
  ay: number
  dx: number
  dy: number
  length2: number
}

export function createSceneRoadIndex(roads: readonly RoadFeature[], cellMetres = 40) {
  const first = roads.find(road => road.vertices.length)?.vertices[0]
  const lng0 = first?.lng ?? 0, lat0 = first?.lat ?? 0
  const eastScale = 111_320 * Math.max(0.05, Math.cos(lat0 * Math.PI / 180))
  const size = Math.max(10, cellMetres)
  const xOf = (lng: number) => (lng - lng0) * eastScale
  const yOf = (lat: number) => (lat - lat0) * 111_320
  const buckets = new Map<string, SceneRoadSegment[]>()
  // Exception for long diagonals spanning thousands of grid cells. A few
  // unindexed segments are cheaper than allocating enormous sparse grids.
  const longSegments: SceneRoadSegment[] = []
  let segmentCount = 0
  for (const road of roads) {
    const radius = clampRoadLanes(road.lanes) * LANE_WIDTH_METRES / 2 + 0.65
    for (let i = 1; i < road.vertices.length; i++) {
      const a = road.vertices[i - 1]!, b = road.vertices[i]!
      const ax = xOf(a.lng), ay = yOf(a.lat)
      const dx = xOf(b.lng) - ax, dy = yOf(b.lat) - ay
      const length2 = dx * dx + dy * dy
      if (length2 < 0.01) continue
      const entry: SceneRoadSegment = { road, segmentIndex: i - 1, a, b, radius, ax, ay, dx, dy, length2 }
      segmentCount++
      // Include the widest supported carriageway and the 10m sign search;
      // querying just ONE cell is then safe for proximity tests.
      const pad = Math.max(20, radius)
      const x0 = Math.floor((Math.min(ax, ax + dx) - pad) / size)
      const x1 = Math.floor((Math.max(ax, ax + dx) + pad) / size)
      const y0 = Math.floor((Math.min(ay, ay + dy) - pad) / size)
      const y1 = Math.floor((Math.max(ay, ay + dy) + pad) / size)
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 500) {
        longSegments.push(entry)
        continue
      }
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const key = `${x}:${y}`
        const cell = buckets.get(key)
        if (cell) cell.push(entry)
        else buckets.set(key, [entry])
      }
    }
  }
  const nearby = (lng: number, lat: number): readonly SceneRoadSegment[] => {
    const key = `${Math.floor(xOf(lng) / size)}:${Math.floor(yOf(lat) / size)}`
    const local = buckets.get(key) ?? []
    return longSegments.length ? local.concat(longSegments) : local
  }
  const project = (lng: number, lat: number) => ({ x: xOf(lng), y: yOf(lat) })
  return { nearby, project, segmentCount }
}

export function sceneSegmentHit(segment: SceneRoadSegment, x: number, y: number) {
  const vx = x - segment.ax, vy = y - segment.ay
  const t = Math.max(0, Math.min(1, (vx * segment.dx + vy * segment.dy) / segment.length2))
  return { distance: Math.hypot(vx - t * segment.dx, vy - t * segment.dy), t }
}
