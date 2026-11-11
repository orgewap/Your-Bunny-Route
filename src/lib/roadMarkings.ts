import type { RoadFeature, RoadVertex } from '../types/road'
import { isTrafficRoad } from './topology.ts'
import { laneDirections } from './lanes.ts'
import { offsetFootpath } from './pedestrian.ts'
import { roadMarkingSections } from './junctionMarkings.ts'

export type MarkingKind = 'solid' | 'dashed' | 'double' | 'edge'
export type RoadMarkingFeature = {
  type: 'Feature'
  properties: { roadId: string; kind: MarkingKind; inferred: boolean }
  geometry: { type: 'LineString'; coordinates: number[][] }
}
export type RoadMarkingChoice = 'auto' | 'solid' | 'dashed' | 'double' | 'none'
export function markingPreference(road: RoadFeature): RoadMarkingChoice {
  const editor = road.tags['road_editor:centre_marking']
  if (editor && ['auto', 'solid', 'dashed', 'double', 'none'].includes(editor)) return editor as RoadMarkingChoice
  const osm = `${road.tags.divider ?? ''}|${road.tags['centre_line'] ?? ''}|${road.tags['center_line'] ?? ''}|${road.tags['road_marking:centre'] ?? ''}`.toLowerCase()
  if (/double/.test(osm)) return 'double'
  if (/solid|continuous/.test(osm)) return 'solid'
  if (/dashed|broken/.test(osm)) return 'dashed'
  if (road.tags.overtaking === 'no' || road.tags['overtaking:forward'] === 'no' && road.tags['overtaking:backward'] === 'no') return 'solid'
  return 'auto'
}
/** Lane changes apply to the boundary between adjacent lane numbers. */
function boundaryPreference(road: RoadFeature, boundary: number, count: number): MarkingKind {
  const changes = road.tags['change:lanes']?.split('|')
  if (changes?.length === count) {
    const lhs = changes[boundary - 1]!, rhs = changes[boundary]!
    const noL = lhs === 'no' || lhs === 'not_right'
    const noR = rhs === 'no' || rhs === 'not_left'
    if (noL && noR) return 'solid'
    if (noL || noR) return 'solid'
  }
  return 'dashed'
}
export function roadMarkingFeatures(roads: readonly RoadFeature[]): RoadMarkingFeature[] {
  const result: RoadMarkingFeature[] = []
  const paintSections = roadMarkingSections(roads)
  for (const road of roads) {
    if (!isTrafficRoad(road) || road.vertices.length < 2 || road.lanes < 1) continue
    const count = Math.max(1, Math.min(10, road.lanes))
    const { forward, backward } = laneDirections(road)
    const centre = markingPreference(road)
    const inferredCentre = centre === 'auto'
    const sections = paintSections.get(road.id) ?? []
    const sourceHasLaneInfo = ['lanes', 'lanes:forward', 'lanes:backward', 'change:lanes', 'turn:lanes',
      'turn:lanes:forward', 'turn:lanes:backward'].some(key => !!road.tags[key])
    // Lane boundaries are real-space metre offsets from the OSM axis.
    for (let boundary = 1; boundary < count; boundary++) {
      const mid = backward > 0 && forward > 0 && boundary === backward
      const kind: MarkingKind = mid
        ? centre === 'none' ? 'dashed' : centre === 'auto' ? 'solid' : centre
        : boundaryPreference(road, boundary, count)
      if (mid && centre === 'none') continue
      if (!sourceHasLaneInfo && centre === 'auto') continue
      const offset = -(boundary - count / 2) * 3.2
      const push = (distance: number, lineKind: MarkingKind) => {
        for (const vertices of sections) result.push({
          type: 'Feature', properties: { roadId: road.id, kind: lineKind, inferred: mid && inferredCentre },
          geometry: { type: 'LineString', coordinates: offsetFootpath(vertices, distance) },
        })
      }
      if (kind === 'double') { push(offset - 0.12, 'solid'); push(offset + 0.12, 'solid') }
      else push(offset, kind)
    }
    // The actual road boundary is distinct from the colored road-status outline.
    // Only create an edge mark when the OSM source or editor explicitly requests one.
    const edge = road.tags['road_editor:edge_marking'] || road.tags['edge_line'] || road.tags['road_marking:edge']
    if (edge === 'yes' || edge === 'solid') {
      for (const vertices of sections) for (const side of [-1, 1]) result.push({ type: 'Feature',
        properties: { roadId: road.id, kind: 'edge', inferred: false },
        geometry: { type: 'LineString', coordinates: offsetFootpath(vertices, side * count * 1.6) },
      })
    }
  }
  return result
}

export type TurnArrowFeature = { type: 'Feature'; properties: {
  roadId: string; laneIndex: number; glyph: string; rotation: number
}; geometry: { type: 'Point'; coordinates: number[] } }
/** Only emit actual turn:lanes tags. Absence of tags is NOT permission data. */
export function turnArrowFeatures(roads: readonly RoadFeature[]): TurnArrowFeature[] {
  const arrows: TurnArrowFeature[] = []
  for (const road of roads) {
    if (!isTrafficRoad(road) || road.vertices.length < 2) continue
    const count = Math.max(1, Math.min(10, road.lanes))
    const { forward, backward } = laneDirections(road)
    for (let lane = 0; lane < count; lane++) {
      const backwards = lane < backward
      const group = backwards ? backward : forward
      if (!group) continue
      const tag = road.oneway ? 'turn:lanes' : backwards ? 'turn:lanes:backward' : 'turn:lanes:forward'
      const source = road.tags[tag] ?? (!backwards ? road.tags['turn:lanes'] : undefined)
      const tokens = source?.split('|')
      if (!tokens || tokens.length !== group) continue
      const physicalIndex = backwards ? backward - lane - 1 : lane - backward
      const raw = tokens[physicalIndex]?.trim()
      if (!raw || raw === 'none') continue
      const turns = raw.split(';')
      const glyph = turns.includes('left') && turns.includes('through') ? '↰↑'
        : turns.includes('right') && turns.includes('through') ? '↑↱'
        : turns.includes('left') && turns.includes('right') ? '↰↱'
        : turns.includes('left') ? '↰' : turns.includes('right') ? '↱'
        : turns.includes('through') ? '↑' : turns.includes('reverse') ? '↶' : ''
      if (!glyph) continue
      const end = backwards ? road.vertices[0]! : road.vertices[road.vertices.length - 1]!
      const towards = backwards ? road.vertices[1]! : road.vertices[road.vertices.length - 2]!
      const length = Math.hypot((end.lng - towards.lng) * 111320 * Math.cos(end.lat * Math.PI / 180), (end.lat - towards.lat) * 111320)
      if (length < 2) continue
      const distance = Math.min(14, length * 0.55)
      const t = distance / length
      const center: RoadVertex = { ...end, lng: end.lng + (towards.lng - end.lng) * t,
        lat: end.lat + (towards.lat - end.lat) * t }
      const normal = offsetFootpath([towards, end], -(lane - (count - 1) / 2) * 3.2)[1]!
      const offset: [number, number] = [(normal[0]! - end.lng), (normal[1]! - end.lat)]
      const east = (end.lng - towards.lng) * Math.cos(end.lat * Math.PI / 180) * (backwards ? -1 : 1)
      const north = (end.lat - towards.lat) * (backwards ? -1 : 1)
      arrows.push({ type: 'Feature', properties: { roadId: road.id, laneIndex: lane, glyph,
        rotation: Math.atan2(east, north) * 180 / Math.PI },
        geometry: { type: 'Point', coordinates: [center.lng + offset[0], center.lat + offset[1]] },
      })
    }
  }
  return arrows
}
