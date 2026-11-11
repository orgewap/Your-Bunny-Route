import type { RoadFeature, RoadVertex } from '../types/road'

/** Visual provenance relative to the last loaded OSM file (not an OSM tag). */
export type RoadStatus = 'imported' | 'created' | 'modified'

export const ROAD_STATUS_COLORS: Readonly<Record<RoadStatus, string>> = {
  imported: '#5089D5',
  created: '#35B985',
  modified: '#E4A744',
}

export const ROAD_STATUS_LABELS: Readonly<Record<RoadStatus, string>> = {
  imported: 'Загружена из OSM',
  created: 'Создана в редакторе',
  modified: 'Изменена после загрузки',
}

export interface RoadStatusIndex {
  byId: Map<string, RoadStatus>
  counts: Record<RoadStatus, number>
}

function sameTags(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key])
}

/** Compare exported properties and topology, not incidental Vue object identity. */
export function sameRoadData(a: RoadFeature, b: RoadFeature): boolean {
  if (a.osmId !== b.osmId || a.name !== b.name || a.highway !== b.highway ||
      a.lanes !== b.lanes || a.oneway !== b.oneway || a.bridge !== b.bridge ||
      a.level !== b.level || a.vertices.length !== b.vertices.length ||
      !sameTags(a.tags, b.tags)) return false
  return a.vertices.every((vertex, index) => {
    const original = b.vertices[index]!
    return vertex.id === original.id && vertex.lng === original.lng && vertex.lat === original.lat
  })
}

/** A newly created OSM way has an ID absent from the imported baseline.
 * Undo returning all properties and vertices restores the imported status.
 * This is view-only; it never adds custom tags to exported OSM XML.
 */
export function classifyRoads(
  roads: readonly RoadFeature[],
  original: readonly RoadFeature[],
  originalWayIds: readonly string[],
): RoadStatusIndex {
  const known = new Set(originalWayIds)
  const baselineByOsmId = new Map(original.map(road => [road.osmId, road]))
  const byId = new Map<string, RoadStatus>()
  const counts: Record<RoadStatus, number> = { imported: 0, created: 0, modified: 0 }
  for (const road of roads) {
    const baseline = baselineByOsmId.get(road.osmId)
    const status: RoadStatus = !known.has(road.osmId) ? 'created'
      : baseline && sameRoadData(road, baseline) ? 'imported' : 'modified'
    byId.set(road.id, status)
    counts[status]++
  }
  return { byId, counts }
}

/** Outer road-edge features: no duplicate OSM ways and no filled junction discs. */
export function roadStatusEdges(
  roads: readonly RoadFeature[],
  statusById: ReadonlyMap<string, RoadStatus>,
  visibleSections?: ReadonlyMap<string, RoadVertex[][]>,
) {
  return roads.flatMap(road => {
    if (road.vertices.length < 2) return []
    const sections = visibleSections?.get(road.id) ?? [road.vertices]
    const latitudeFactor = 1 / Math.max(0.02, Math.cos(road.vertices[0]!.lat * Math.PI / 180))
    const status = statusById.get(road.id) ?? 'imported'
    return sections.filter(vertices => vertices.length > 1).flatMap(vertices => {
      const coordinates = vertices.map(v => [v.lng, v.lat])
      return [-1, 1].map(side => ({
        type: 'Feature' as const,
        properties: { roadId: road.id, status, side, lanes: road.lanes, latitudeFactor },
        geometry: { type: 'LineString' as const, coordinates },
      }))
    })
  })
}
