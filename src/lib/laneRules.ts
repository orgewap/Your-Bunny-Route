import type { RoadFeature } from '../types/road'
import { clampRoadLanes, laneDirections } from './lanes.ts'

export type LaneTurnToken = 'left' | 'through' | 'right'
export const LANE_TURN_TOKENS: readonly LaneTurnToken[] = ['left', 'through', 'right']

export interface LaneDirectionPosition {
  flow: 'forward' | 'backward'
  tag: 'turn:lanes' | 'turn:lanes:forward' | 'turn:lanes:backward'
  index: number
  count: number
}

/** Physical lane order follows the right-hand traffic lane stripes. */
export function laneDirectionPosition(road: RoadFeature, laneIndex: number): LaneDirectionPosition | null {
  const lanes = clampRoadLanes(road.lanes)
  if (laneIndex < 0 || laneIndex >= lanes || (!road.oneway && lanes === 1)) return null
  const { forward, backward } = laneDirections(road)
  if (laneIndex < backward) {
    return { flow: 'backward', tag: road.oneway ? 'turn:lanes' : 'turn:lanes:backward',
      index: backward - 1 - laneIndex, count: backward }
  }
  const tag = road.oneway ? 'turn:lanes' : 'turn:lanes:forward'
  return { flow: 'forward', tag,
    index: laneIndex - backward, count: forward }
}

/** 'none' / missing means no recorded restriction, not "all turns forbidden". */
export function getLaneTurnRules(road: RoadFeature, laneIndex: number): LaneTurnToken[] {
  const position = laneDirectionPosition(road, laneIndex)
  if (!position) return [...LANE_TURN_TOKENS]
  const tag = road.tags[position.tag] ?? (position.tag === 'turn:lanes:forward' ? road.tags['turn:lanes'] : undefined)
  const tokens = tag?.split('|')
  if (!tokens || tokens.length !== position.count) return [...LANE_TURN_TOKENS]
  const token = tokens[position.index]?.trim()
  if (!token || token === 'none') return [...LANE_TURN_TOKENS]
  const rules = token.split(';').map(value => value.trim())
  return LANE_TURN_TOKENS.filter(value => rules.includes(value))
}

/** Pure tag update, ready for undo/redo and normal OSM export. */
export function withLaneTurnRules(
  road: RoadFeature, laneIndex: number, selected: readonly LaneTurnToken[],
): Record<string, string> {
  const position = laneDirectionPosition(road, laneIndex)
  if (!position) throw new Error('Для одной общей полосы требуется указать направление движения дороги.')
  const chosen = LANE_TURN_TOKENS.filter(value => selected.includes(value))
  if (!chosen.length) throw new Error('Разрешите хотя бы одно направление движения.')
  const old = road.tags[position.tag]?.split('|') ?? []
  // Only a correctly sized existing turn:lanes value can be updated in place.
  const updated = old.length === position.count ? [...old] : Array(position.count).fill('none')
  updated[position.index] = chosen.join(';')
  const tags = { ...road.tags, [position.tag]: updated.join('|') }
  // Avoid an obsolete generic tag shadowing the explicit forward direction.
  if (!road.oneway && position.flow === 'forward') delete tags['turn:lanes']
  return tags
}
