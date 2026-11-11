import type { RoadFeature, RoadVertex } from '../types/road'
import { roadLengthMeters } from './geometry.ts'

export const LEVEL_HEIGHT_METRES = 5
export const RAMP_LENGTH_METRES = 35

function length(a: RoadVertex, b: RoadVertex): number {
  return roadLengthMeters([a, b])
}
function accumulated(vertices: RoadVertex[]): number[] {
  const positions = [0]
  for (let i = 1; i < vertices.length; i++) positions.push(positions[i - 1]! + length(vertices[i - 1]!, vertices[i]!))
  return positions
}
function interpolate(a: RoadVertex, b: RoadVertex, t: number): RoadVertex {
  return { id: crypto.randomUUID(), lng: a.lng + (b.lng - a.lng) * t, lat: a.lat + (b.lat - a.lat) * t }
}
function pointAt(vertices: RoadVertex[], positions: number[], distance: number): RoadVertex {
  const total = positions[positions.length - 1]!
  if (distance <= 0) return { ...vertices[0]! }
  if (distance >= total) return { ...vertices[vertices.length - 1]! }
  for (let i = 1; i < positions.length; i++) {
    if (Math.abs(positions[i]! - distance) < 0.001) return { ...vertices[i]! }
    if (distance < positions[i]!) return interpolate(vertices[i - 1]!, vertices[i]!, (distance - positions[i - 1]!) / (positions[i]! - positions[i - 1]!))
  }
  return { ...vertices[vertices.length - 1]! }
}
const smoothstep = (x: number): number => {
  const v = Math.min(1, Math.max(0, x))
  return v * v * (3 - 2 * v)
}

/**
 * The elevated OSM way has a constant deck height. The ground approach shares
 * the boundary node ID and receives a visual (non-OSM) smooth ramp.
 */

export function bridgeNodeHeights(
  roads: readonly RoadFeature[]
): Map<string, number> {
  const heights = new Map<string, number>()

  for (const road of roads) {
    if (road.level <= 0 || road.vertices.length < 2) {
      continue
    }

    const elevated = road.level * LEVEL_HEIGHT_METRES

    // Учитываем все узлы поднятой дороги,
    // включая точки соединения посередине моста.
    for (const vertex of road.vertices) {
      const previous = heights.get(vertex.id) ?? 0

      heights.set(
        vertex.id,
        Math.max(previous, elevated)
      )
    }
  }

  return heights
}


/** Precompute ramp anchors once, including shared OSM boundary nodes. */
function heightSampler(road: RoadFeature, elevations: Map<string, number>): (metres: number) => number {
  if (road.level > 0) return () => road.level * LEVEL_HEIGHT_METRES
  const positions = accumulated(road.vertices)
  const total = positions[positions.length - 1] ?? 0
  const anchors = road.vertices.flatMap((vertex, i) => {
    const elevated = elevations.get(vertex.id) ?? 0
    if (!elevated) return []
    const position = positions[i]!
    return [{ position, elevated,
      rampBack: Math.min(RAMP_LENGTH_METRES, position || RAMP_LENGTH_METRES),
      rampForward: Math.min(RAMP_LENGTH_METRES, total - position || RAMP_LENGTH_METRES),
    }]
  })
  return (distance: number) => {
    let height = 0
    for (const anchor of anchors) {
      const diff = distance - anchor.position
      const reach = diff < 0 ? anchor.rampBack : anchor.rampForward
      height = Math.max(height, anchor.elevated * smoothstep(1 - Math.abs(diff) / Math.max(0.01, reach)))
    }
    return height
  }
}

/** Height profile for one way at any distance along its polyline. */
export function roadHeightAt(road: RoadFeature, atMetres: number, elevations: Map<string, number>): number {
  return heightSampler(road, elevations)(atMetres)
}

export interface RaisedPoint { lng: number; lat: number; height: number }

/** Vertices with continuous elevations for a WebGL triangle road ribbon. */
export function sampleElevatedRoad(road: RoadFeature, elevations: Map<string, number>, spacingMetres = 3): RaisedPoint[] {
  const samples: RaisedPoint[] = []
  const heightAt = heightSampler(road, elevations)
  let travelled = 0
  for (let i = 1; i < road.vertices.length; i++) {
    const a = road.vertices[i - 1]!, b = road.vertices[i]!
    const distance = length(a, b)
    if (distance < 0.001) continue
    const subdivisions = Math.max(1, Math.ceil(distance / spacingMetres))
    for (let j = i === 1 ? 0 : 1; j <= subdivisions; j++) {
      const t = j / subdivisions
      samples.push({
        lng: a.lng + (b.lng - a.lng) * t,
        lat: a.lat + (b.lat - a.lat) * t,
        height: heightAt(travelled + distance * t),
      })
    }
    travelled += distance
  }
  return samples
}

export interface SplitBridgeResult {
  roadParts: [RoadFeature, RoadFeature, RoadFeature]
  bridgeRoadId: string
  bridgeStartId: string
  bridgeEndId: string
}

/**
 * Split a selected ground way into ground / bridge / ground, retaining its
 * original OSM way ID on the first part. All seams use shared node IDs.
 */
export function splitGroundRoadForBridge(
  road: RoadFeature, from: number, to: number, reservedWayIds: string[],
  otherRoadNodeIds: ReadonlySet<string> = new Set(),
): SplitBridgeResult {
  if (road.bridge || road.level !== 0 || road.tags.junction === 'roundabout') throw new Error('Выберите обычный наземный дорожный участок.')
  const positions = accumulated(road.vertices)
  const total = positions[positions.length - 1] ?? 0
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 1 || to > total - 1 || to - from < 4) {
    throw new Error('Начало и конец моста должны находиться внутри дороги с пролётом не меньше 4 метров.')
  }
  const boundaryStart = pointAt(road.vertices, positions, from)
  const boundaryEnd = pointAt(road.vertices, positions, to)
  const points = road.vertices.map((vertex, i) => ({ position: positions[i]!, vertex: { ...vertex } }))
  points.push({ position: from, vertex: boundaryStart }, { position: to, vertex: boundaryEnd })
  points.sort((a, b) => a.position - b.position)
  // Keep the original node if a boundary is exactly on an OSM vertex.
  const deduplicated: typeof points = []
  for (const point of points) {
    const last = deduplicated[deduplicated.length - 1]
    if (last && Math.abs(last.position - point.position) < 0.001) {
      if (point.position === from) boundaryStart.id = last.vertex.id
      if (point.position === to) boundaryEnd.id = last.vertex.id
      continue
    }
    deduplicated.push(point)
  }
  const start = deduplicated.find(point => Math.abs(point.position - from) < 0.001)!.vertex
  const end = deduplicated.find(point => Math.abs(point.position - to) < 0.001)!.vertex
  const slice = (a: number, b: number) => deduplicated.filter(point => point.position >= a - 0.001 && point.position <= b + 0.001).map(point => ({ ...point.vertex }))
  const used = Math.min(0, ...reservedWayIds.map(Number).filter(n => Number.isFinite(n) && n < 0)) - 1
  const cleanTags = { ...road.tags }
  delete cleanTags.bridge
  delete cleanTags.layer
  const groundOne: RoadFeature = { ...road, vertices: slice(0, from), tags: { ...cleanTags } }
  const elevatedVertices = slice(from, to)
  // Internal original junctions are NOT valid connections to traffic under the bridge.
  // Give those vertices independent OSM IDs while preserving their coordinates.
  for (let i = 1; i < elevatedVertices.length - 1; i++) {
    if (otherRoadNodeIds.has(elevatedVertices[i]!.id)) elevatedVertices[i]!.id = crypto.randomUUID()
  }
  const bridge: RoadFeature = { ...road, id: crypto.randomUUID(), osmId: String(used), bridge: true, level: 1, vertices: elevatedVertices, tags: { ...cleanTags } }
  const groundTwo: RoadFeature = { ...road, id: crypto.randomUUID(), osmId: String(used - 1), bridge: false, level: 0, vertices: slice(to, total), tags: { ...cleanTags } }
  return { roadParts: [groundOne, bridge, groundTwo], bridgeRoadId: bridge.id, bridgeStartId: start.id, bridgeEndId: end.id }
}
