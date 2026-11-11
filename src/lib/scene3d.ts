/** Lightweight metric 3D street furniture rendered in the same MapLibre custom
 * layer as roads. No second road graph, no change to OSM junction/node IDs. */
import type { RoadFeature, RoadVertex } from '../types/road.ts'
import { infrastructureMarkings } from './infrastructure.ts'
import type { InfrastructureFeature } from './infrastructure.ts'
import { bridgeNodeHeights, sampleElevatedRoad } from './bridges.ts'
import { isTrafficRoad } from './topology.ts'
import { clampRoadLanes, LANE_WIDTH_METRES } from './lanes.ts'
import type { CrosswalkFeature } from './crosswalks.ts'
import type { RoadMarkingFeature } from './roadMarkings.ts'
import { createSceneRoadIndex, sceneSegmentHit } from './sceneIndex.ts'
import type { InfrastructurePlacementIndex } from './infrastructure.ts'
import { pedestrianVisualFeatures } from './pedestrian.ts'

export type ScenePoint = [lng: number, lat: number, height: number]
export type SceneColor = [number, number, number]
/** 0: roads only, 1: nearby simplified props, 2: full local detail. */
export type SceneDetailLevel = 0 | 1 | 2
export type SceneTriangle = (a: ScenePoint, b: ScenePoint, c: ScenePoint, color: SceneColor) => void

export interface SceneBarrier {
  kind: 'kerb' | 'guard_rail' | 'wall' | 'pier'
  vertices: RoadVertex[]
  height: number
}

/** Native OSM barrier=kerb / guard_rail / wall and bridge:support=pier
 * stay in the ORIGINAL XML. This read-only view never invents source tags. */
export function readSceneBarriers(xml: string): SceneBarrier[] {
  if (!xml) return []
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.querySelector('parsererror')) return []
  const nodes = new Map<string, RoadVertex>()
  const result: SceneBarrier[] = []
  const tags = (el: Element): Record<string, string> => {
    const found: Record<string, string> = {}
    for (const tag of Array.from(el.children)) if (tag.tagName === 'tag') {
      const key = tag.getAttribute('k')
      if (key) found[key] = tag.getAttribute('v') ?? ''
    }
    return found
  }
  const height = (raw: string | undefined, fallback: number) => {
    const n = Number.parseFloat(raw ?? '')
    return Number.isFinite(n) ? Math.max(0.05, Math.min(12, n)) : fallback
  }
  for (const node of Array.from(doc.documentElement.children)) if (node.tagName === 'node') {
    const id = node.getAttribute('id')
    const lat = Number(node.getAttribute('lat')), lng = Number(node.getAttribute('lon'))
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lng)) continue
    const vertex = { id: `osm-node-${id}`, lat, lng }
    nodes.set(id, vertex)
    if (tags(node)['bridge:support'] === 'pier') result.push({ kind: 'pier', vertices: [vertex], height: height(tags(node).height, 5) })
  }
  for (const way of Array.from(doc.documentElement.children)) {
    if (way.tagName !== 'way') continue
    const values = tags(way)
    const kind = values.barrier
    if (kind !== 'kerb' && kind !== 'guard_rail' && kind !== 'wall') continue
    const vertices = Array.from(way.children).filter(el => el.tagName === 'nd')
      .map(el => nodes.get(el.getAttribute('ref') ?? '')).filter((point): point is RoadVertex => !!point)
    if (vertices.length > 1) result.push({ kind, vertices, height: height(values.height,
      kind === 'kerb' ? 0.15 : kind === 'wall' ? 1.8 : 0.9) })
  }
  return result
}

function scaleAt(lat: number): [number, number] {
  return [111_320 * Math.max(0.05, Math.cos(lat * Math.PI / 180)), 111_320]
}
function offset(at: ScenePoint, east: number, north: number, up = 0): ScenePoint {
  const [sx, sy] = scaleAt(at[1])
  return [at[0] + east / sx, at[1] + north / sy, at[2] + up]
}

/** Emits an axis-aligned-in-height prism in local metre coordinates. */
export function emitSceneBox(triangle: SceneTriangle, center: ScenePoint,
  tx: number, ty: number, length: number, width: number, bottom: number, top: number, color: SceneColor): void {
  if (length <= 0 || width <= 0 || top <= bottom || !Number.isFinite(top)) return
  const mag = Math.hypot(tx, ty) || 1
  const ux = tx / mag, uy = ty / mag, nx = -uy, ny = ux
  const corner = (along: number, across: number, z: number): ScenePoint =>
    offset(center, ux * along + nx * across, uy * along + ny * across, z - center[2])
  const a = corner(-length / 2, -width / 2, bottom), b = corner(length / 2, -width / 2, bottom)
  const c = corner(length / 2, width / 2, bottom), d = corner(-length / 2, width / 2, bottom)
  const A = corner(-length / 2, -width / 2, top), B = corner(length / 2, -width / 2, top)
  const C = corner(length / 2, width / 2, top), D = corner(-length / 2, width / 2, top)
  const quad = (p: ScenePoint, q: ScenePoint, r: ScenePoint, s: ScenePoint, tint: SceneColor) => {
    triangle(p, q, r, tint); triangle(p, r, s, tint)
  }
  quad(A, B, C, D, color)
  quad(a, b, B, A, color)
  quad(b, c, C, B, color)
  quad(c, d, D, C, color)
  quad(d, a, A, D, color)
}

const CURB: SceneColor = [0.74, 0.74, 0.70]
const RAIL: SceneColor = [0.69, 0.72, 0.73]
const PIER: SceneColor = [0.53, 0.54, 0.55]
const WHITE: SceneColor = [0.94, 0.95, 0.90]
const LAMP: SceneColor = [0.17, 0.20, 0.22]

function direction(kind: string | undefined, sidewalk: string | undefined): 'both' | 'left' | 'right' | 'no' {
  const raw = kind && kind !== 'auto' ? kind : sidewalk
  return raw === 'yes' || raw === 'both' ? 'both' : raw === 'left' || raw === 'right' ? raw : 'no'
}
function numeric(input: string | undefined, fallback: number, lo: number, hi: number): number {
  const parsed = Number(input)
  return input && Number.isFinite(parsed) ? Math.max(lo, Math.min(hi, parsed)) : fallback
}
function segment(a: ScenePoint, b: ScenePoint): { east: number; north: number; length: number; center: ScenePoint } {
  const [sx, sy] = scaleAt((a[1] + b[1]) / 2)
  const east = (b[0] - a[0]) * sx, north = (b[1] - a[1]) * sy
  return { east, north, length: Math.hypot(east, north), center: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2] }
}
function sideOf(a: ScenePoint, b: ScenePoint, metres: number): [ScenePoint, ScenePoint] {
  const s = segment(a, b)
  if (s.length < 0.01) return [a, b]
  const nx = -s.north / s.length * metres, ny = s.east / s.length * metres
  return [offset(a, nx, ny), offset(b, nx, ny)]
}
function addBeam(tri: SceneTriangle, a: ScenePoint, b: ScenePoint, width: number, z0: number, height: number, color: SceneColor): void {
  const s = segment(a, b)
  if (s.length < 0.08) return
  emitSceneBox(tri, s.center, s.east, s.north, s.length, width, z0, z0 + height, color)
}

/** 3D world objects are recreated only when road geometry, visibility, or infrastructure changes.
 * Prefer modest silhouettes to avoid breaking WebGL on city-wide datasets. */
export function appendSceneInfrastructure(tri: SceneTriangle, roads: readonly RoadFeature[],
  features: readonly InfrastructureFeature[] = [], crossings: readonly CrosswalkFeature[] = [],
  barriers: readonly SceneBarrier[] = [], markingLines: readonly RoadMarkingFeature[] = [],
  detail: SceneDetailLevel = 2, placementIndex?: InfrastructurePlacementIndex,
  options: { roadFurniture?: boolean; controls?: boolean } = {}): void {
  // Roads are rendered by RoadMeshLayer; a zoomed-out city does not need
  // tens of thousands of individual kerbs, paint triangles or sign posts.
  if (detail === 0) return
  const roadFurniture = options.roadFurniture !== false
  const controls = options.controls !== false
  const motor = roadFurniture || controls && !placementIndex ? roads.filter(isTrafficRoad) : []
  const heights = roadFurniture ? bridgeNodeHeights(roads) : new Map<string, number>()
  let boxes = 0
  const maxBoxes = detail === 1 ? 1_200 : 5_000
  const box = (center: ScenePoint, east: number, north: number, length: number, width: number,
    low: number, high: number, color: SceneColor) => {
    if (boxes >= maxBoxes) return
    boxes++
    emitSceneBox(tri, center, east, north, length, width, low, high, color)
  }
  const beam = (a: ScenePoint, b: ScenePoint, width: number, z0: number, height: number, color: SceneColor) => {
    if (boxes >= maxBoxes) return
    const s = segment(a, b)
    if (s.length < 0.08) return
    box(s.center, s.east, s.north, s.length, width, z0, z0 + height, color)
  }
  const activeMotor = motor.filter(road => road.vertices.length > 1)
  // Spatial index replaces full OSM scans for EVERY bridge pier and sign.
  // Only candidates within one 40-metre cell need precise distance tests.
  const needSupportIndex = roadFurniture && activeMotor.some(road =>
    (road.bridge || road.level > 0) && road.tags['road_editor:bridge_support'] !== 'none')
  const needSignIndex = controls && features.some(feature =>
    feature.kind === 'traffic_signal' || feature.kind === 'stop' || feature.kind === 'give_way')
  const roadIndex = needSupportIndex || needSignIndex ? placementIndex?.spatial ?? createSceneRoadIndex(activeMotor) : null
  const supportBlocked = (point: ScenePoint): boolean => {
    if (!roadIndex) return false
    const p = roadIndex.project(point[0], point[1])
    return roadIndex.nearby(point[0], point[1]).some(entry =>
      entry.road.level === 0 && !entry.road.bridge &&
      sceneSegmentHit(entry, p.x, p.y).distance < entry.radius)
  }
  if (roadFurniture) for (const road of activeMotor) {
    if (boxes >= maxBoxes) break
    const curb = direction(road.tags['road_editor:kerb'], road.tags.sidewalk)
    const guard = direction(road.tags['road_editor:guard_rail'], undefined)
    const supports = (road.bridge || road.level > 0) && road.tags['road_editor:bridge_support'] !== 'none'
    if (curb === 'no' && guard === 'no' && !supports) continue
    const curbHeight = numeric(road.tags['road_editor:kerb_height'], 0.15, 0.03, 0.45)
    // No subdivisions for the vast majority of level/flat roads. Only a
    // ground approach sharing a bridge node actually has a curved height.
    const hasRamp = road.level === 0 && road.vertices.some(vertex => heights.has(vertex.id))
    const profile = hasRamp ? sampleElevatedRoad(road, heights, detail === 1 ? 20 : 10)
      .map(p => [p.lng, p.lat, p.height] as ScenePoint)
      : road.vertices.map(p => [p.lng, p.lat, road.level * 5] as ScenePoint)
    const roadHalf = Math.max(3.5, clampRoadLanes(road.lanes) * LANE_WIDTH_METRES) / 2
    for (let i = 1; i < profile.length && boxes < maxBoxes; i++) {
      const a = profile[i - 1]!, b = profile[i]!
      for (const [side, active] of [[1, curb === 'both' || curb === 'left'], [-1, curb === 'both' || curb === 'right']] as const) {
        if (!active || road.level > 0 || road.bridge) continue // kerbs only beside ground roads
        const [x, y] = sideOf(a, b, side * (roadHalf + 0.13))
        beam(x, y, 0.20, (a[2] + b[2]) / 2 + 0.18, curbHeight, CURB)
      }
      for (const [side, active] of [[1, guard === 'both' || guard === 'left'], [-1, guard === 'both' || guard === 'right']] as const) {
        if (!active) continue
        const [x, y] = sideOf(a, b, side * (roadHalf + 0.25))
        const baseline = (a[2] + b[2]) / 2 + 0.18
        beam(x, y, 0.16, baseline + 0.88, 0.13, RAIL)
        if (detail === 2 && i % 2 === 1) for (const p of [x, y]) box(p, 1, 0, 0.13, 0.13, p[2] + 0.18, p[2] + 1.08, RAIL)
      }
    }
    if (supports) {
      const spacing = numeric(road.tags['road_editor:support_spacing'], 22, 8, 100)
      let travelled = 0, next = spacing
      for (let i = 1; i < profile.length && boxes < maxBoxes; i++) {
        const a = profile[i - 1]!, b = profile[i]!, s = segment(a, b)
        if (s.length < 0.01) continue
        while (next <= travelled + s.length && boxes < maxBoxes) {
          const t = (next - travelled) / s.length
          const p: ScenePoint = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
          if (p[2] > 2.3 && !supportBlocked(p)) box(p, s.east, s.north, 0.95, 0.95, 0, p[2] - 0.22, PIER)
          next += spacing
        }
        travelled += s.length
      }
    }
  }
  // Explicit barrier=kerb, barrier=guard_rail and bridge:support=pier
  // from the imported XML, even when these are not part of the road graph.
  for (const barrier of roadFurniture && detail === 2 ? barriers : []) {
    if (boxes >= maxBoxes) break
    if (barrier.kind === 'pier') {
      const p = barrier.vertices[0]
      if (p) box([p.lng, p.lat, 0], 1, 0, 1.1, 1.1, 0, barrier.height, PIER)
      continue
    }
    const width = barrier.kind === 'kerb' ? 0.20 : barrier.kind === 'wall' ? 0.28 : 0.15
    const color = barrier.kind === 'kerb' ? CURB : RAIL
    for (let i = 1; i < barrier.vertices.length && boxes < maxBoxes; i++) {
      const a = barrier.vertices[i - 1]!, b = barrier.vertices[i]!
      beam([a.lng, a.lat, 0], [b.lng, b.lat, 0], width, 0.08, barrier.height, color)
    }
  }
  // Road markings are drawn on the asphalt at true elevations. The input
  // already has the junction sections removed by roadMarkingFeatures(): do
  // not paint straight through crossings or restore artificial centre lines.
  const roadById = new Map(activeMotor.map(road => [road.id, road]))
  for (const marking of (roadFurniture && detail === 2 ? markingLines.slice(0, 1200) : [])) {
    if (boxes >= maxBoxes) break
    const road = roadById.get(marking.properties.roadId)
    if (!road) continue
    const z = road.level * 5 + 0.235
    for (let i = 1; i < marking.geometry.coordinates.length && boxes < maxBoxes; i++) {
      const a = marking.geometry.coordinates[i - 1]!, b = marking.geometry.coordinates[i]!
      const x: ScenePoint = [a[0]!, a[1]!, z], y: ScenePoint = [b[0]!, b[1]!, z]
      const s = segment(x, y)
      const tint = marking.properties.inferred ? [0.84, 0.84, 0.76] as SceneColor : WHITE
      if (marking.properties.kind !== 'dashed') {
        beam(x, y, marking.properties.kind === 'edge' ? 0.12 : 0.13, z, 0.012, tint)
      } else {
        const stride = 7, painted = 3.2
        for (let m = 0; m < s.length && boxes < maxBoxes; m += stride) {
          const end = Math.min(s.length, m + painted)
          const lerp = (t: number): ScenePoint => [x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, z]
          beam(lerp(m / s.length), lerp(end / s.length), 0.13, z, 0.012, tint)
        }
      }
    }
  }
  // Visible stop bars are projected as thin raised paint, reusing the same
  // lane-specific polygons as the existing 2D layer. Not new OSM ways.
  const stopFeatures = controls && detail === 2 ? features.filter(feature => feature.kind === 'stop_line' ||
    feature.kind === 'traffic_signal' || feature.kind === 'stop' || feature.kind === 'give_way').slice(0, 180) : []
  for (const marking of infrastructureMarkings(stopFeatures, roads, null, placementIndex).slice(0, 400)) {
    if (boxes >= maxBoxes) break
    for (let i = 1; i < marking.coordinates.length && boxes < maxBoxes; i++) {
      const a = marking.coordinates[i - 1]!, b = marking.coordinates[i]!
      beam([a[0], a[1], 0.23], [b[0], b[1], 0.23], 0.24, 0.23, 0.015, WHITE)
    }
  }
  let signs = 0
  for (const feature of controls ? features : []) {
    if (boxes >= maxBoxes || signs >= (detail === 1 ? 60 : 240)) break
    if (feature.kind !== 'traffic_signal' && feature.kind !== 'stop' && feature.kind !== 'give_way') continue
    const v = feature.vertices[0]
    if (!v) continue
    signs++
    let p: ScenePoint = [v.lng, v.lat, 0]
    let best = 10
    const projected = roadIndex?.project(v.lng, v.lat)
    for (const entry of roadIndex?.nearby(v.lng, v.lat) ?? []) {
      const { distance, t } = sceneSegmentHit(entry, projected!.x, projected!.y)
      if (distance >= best) continue
      best = distance
      const len = Math.sqrt(entry.length2)
      const sign = feature.direction === 'backward' ? 1 : -1
      const metres = sign * (clampRoadLanes(entry.road.lanes) * LANE_WIDTH_METRES / 2 + 0.65)
      p = offset([entry.a.lng + (entry.b.lng - entry.a.lng) * t,
          entry.a.lat + (entry.b.lat - entry.a.lat) * t, 0],
        -entry.dy / len * metres, entry.dx / len * metres)
    }
    // A static 3D sign on the roadside; no invented traffic-light controller.
    box(p, 1, 0, 0.11, 0.11, 0, feature.kind === 'traffic_signal' ? 3.15 : 2.35, RAIL)
    if (feature.kind === 'traffic_signal') {
      box(p, 1, 0, 0.45, 0.30, 2.65, 3.30, LAMP)
      for (const [i, color] of ([[0, [0.9, 0.13, 0.11]], [1, [0.84, 0.62, 0.11]], [2, [0.10, 0.65, 0.29]]] as const)) {
        const lens = offset(p, 0.0, -0.17, 3.14 - i * 0.20)
        box(lens, 1, 0, 0.14, 0.035, lens[2] - 0.06, lens[2] + 0.06, [...color])
      }
    } else {
      const color: SceneColor = feature.kind === 'stop' ? [0.75, 0.11, 0.10] : [0.94, 0.73, 0.18]
      box(p, 1, 0, 0.48, 0.055, 1.90, 2.40, color)
    }
  }
}


/** Zebra paint is kept in the pedestrian buffer so changing a traffic sign
 * does not rebuild thousands of existing crosswalk stripe triangles. */
export function appendSceneCrosswalks(
  tri: SceneTriangle,
  crossings: readonly CrosswalkFeature[],
  detail: SceneDetailLevel = 2,
): void {
  for (const polygon of crossings.slice(0, detail === 2 ? 1200 : 250)) {
    const points = polygon.geometry.coordinates[0]
    if (!points || points.length < 4) continue
    const a: ScenePoint = [points[0]![0]!, points[0]![1]!, 0.23]
    const b: ScenePoint = [points[1]![0]!, points[1]![1]!, 0.23]
    const c: ScenePoint = [points[2]![0]!, points[2]![1]!, 0.23]
    const d: ScenePoint = [points[3]![0]!, points[3]![1]!, 0.23]
    tri(a, b, c, WHITE); tri(a, c, d, WHITE)
  }
}

/** Raised metre-based pedestrian pavement for the custom 3D layer.
 * It complements the 2D line overlay and remains visible when MapLibre's
 * fill-extrusion drape is obscured by the custom road mesh. */
export function appendScenePedestrianSurfaces(
  tri: SceneTriangle,
  roads: readonly RoadFeature[],
  detail: SceneDetailLevel = 2,
  crossings: readonly CrosswalkFeature[] = [],
): void {
  if (detail === 0) return
  if (!roads.length) {
    appendSceneCrosswalks(tri, crossings, detail)
    return
  }
  const byId = new Map(roads.map(road => [road.id, road]))
  const features = pedestrianVisualFeatures(roads, null)
  const crosswalkBounds = crossings.flatMap(feature => {
    const points = feature.geometry.coordinates[0] ?? []
    if (!points.length) return []
    return [{
      west: Math.min(...points.map(point => point[0]!)),
      east: Math.max(...points.map(point => point[0]!)),
      south: Math.min(...points.map(point => point[1]!)),
      north: Math.max(...points.map(point => point[1]!)),
    }]
  })
  const maxSegments = detail === 1 ? 1800 : 4800
  let emitted = 0
  for (const feature of features) {
    if (emitted >= maxSegments || feature.properties.underground) continue
    const road = byId.get(feature.properties.roadId)
    if (!road) continue
    const width = Math.max(0.8, Math.min(8, feature.properties.width))
    const base = Math.max(0, road.level * 5)
    const color: SceneColor = feature.properties.inferred ? [0.43, 0.61, 0.50]
      : feature.properties.kind === 'steps' ? [0.68, 0.57, 0.43]
      : feature.properties.kind === 'cycleway' ? [0.18, 0.55, 0.63]
      : [0.20, 0.65, 0.50]
    const coords = feature.geometry.coordinates
    for (let i = 1; i < coords.length && emitted < maxSegments; i++) {
      const a = coords[i - 1]!, b = coords[i]!
      const segmentBounds = { west: Math.min(a[0]!, b[0]!), east: Math.max(a[0]!, b[0]!),
        south: Math.min(a[1]!, b[1]!), north: Math.max(a[1]!, b[1]!) }
      if (crosswalkBounds.some(bounds => segmentBounds.east >= bounds.west &&
          segmentBounds.west <= bounds.east && segmentBounds.north >= bounds.south &&
          segmentBounds.south <= bounds.north)) continue
      const pointA: ScenePoint = [a[0]!, a[1]!, base]
      const pointB: ScenePoint = [b[0]!, b[1]!, base]
      const part = segment(pointA, pointB)
      if (part.length < 0.25) continue
      emitSceneBox(tri, part.center, part.east, part.north, part.length, width,
        base + 0.18, base + 0.31, color)
      emitted++
    }
  }
  appendSceneCrosswalks(tri, crossings, detail)
}
