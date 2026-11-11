import type { RoadFeature, RoadVertex } from '../types/road'
import { distanceMetres, isTrafficRoad } from './topology.ts'
import { LANE_WIDTH_METRES, clampRoadLanes, laneDirections } from './lanes.ts'
import { serializeOsmDocument } from './xml.ts'
import { createSceneRoadIndex, sceneSegmentHit } from './sceneIndex.ts'

export type InfrastructureKind = 'traffic_signal' | 'stop' | 'give_way' | 'crossing' | 'stop_line'
export type TrafficDirection = 'forward' | 'backward' | 'both'

/** OSM infrastructure is stored separately from road ways, but a point's OSM
 * node ID is shared with the corresponding road vertex where applicable. */
export interface InfrastructureFeature {
  id: string
  osmId: string
  element: 'node' | 'way'
  kind: InfrastructureKind
  vertices: RoadVertex[]
  direction: TrafficDirection
  tags: Record<string, string>
  /** Indices of physical rendered lanes (0-based, across the whole way). */
  laneIndices?: number[]
  /** Stable OSM way ID, not the editor's transient road object ID. */
  roadOsmId?: string
}

export interface RoadPlacement {
  roadId: string
  segmentIndex: number
  t: number
  point: RoadVertex
  distance: number
}

const pointHighways = new Set(['traffic_signals', 'stop', 'give_way', 'crossing'])
const MARKING = 'road_marking'
const ROAD_REF = 'road_editor:road'
const LANE_REFS = 'road_editor:lanes'
const PREVIEW_LINE = 'road_editor:stop_line'

function parseLaneSelection(tag: string | undefined): number[] | undefined {
  if (!tag || !/^\d+(,\d+)*$/.test(tag)) return undefined
  const lanes = [...new Set(tag.split(',').map(value => Number(value) - 1))]
  return lanes.every(value => Number.isInteger(value) && value >= 0 && value < 10) ? lanes.sort((a, b) => a - b) : undefined
}
const DIRECTIONS = new Set<TrafficDirection>(['forward', 'backward', 'both'])

function elementChildren(el: Element, tag: string): Element[] {
  return Array.from(el.children).filter(child => child.tagName === tag)
}
function readTags(el: Element): Record<string, string> {
  const tags: Record<string, string> = {}
  for (const tag of elementChildren(el, 'tag')) {
    const key = tag.getAttribute('k')
    if (key) tags[key] = tag.getAttribute('v') ?? ''
  }
  return tags
}
export function readInfrastructure(xml: string): InfrastructureFeature[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.querySelector('parsererror') || doc.documentElement.tagName !== 'osm') throw new Error('Некорректный OSM XML.')
  const nodes = new Map<string, RoadVertex>()
  const features: InfrastructureFeature[] = []
  for (const node of elementChildren(doc.documentElement, 'node')) {
    const osmId = node.getAttribute('id')
    const lng = Number(node.getAttribute('lon')), lat = Number(node.getAttribute('lat'))
    if (!osmId || !Number.isFinite(lng) || !Number.isFinite(lat)) continue
    const vertex = { id: `osm-node-${osmId}`, lng, lat }
    nodes.set(osmId, vertex)
    const tags = readTags(node)
    const kind = pointHighways.has(tags.highway ?? '') ?
      (tags.highway === 'traffic_signals' ? 'traffic_signal' : tags.highway) :
      tags[MARKING] === 'stop_line' ? 'stop_line' : null
    if (!kind) continue
    const direction = tags['traffic_signals:direction'] ?? tags.direction ?? 'both'
    features.push({ id: `infra-node-${osmId}`, osmId, kind: kind as InfrastructureKind,
      element: 'node', vertices: [vertex],
      direction: DIRECTIONS.has(direction as TrafficDirection) ? direction as TrafficDirection : 'both', tags,
      roadOsmId: tags[ROAD_REF], laneIndices: parseLaneSelection(tags[LANE_REFS]) })
  }
  for (const way of elementChildren(doc.documentElement, 'way')) {
    const tags = readTags(way)
    if (tags[MARKING] !== 'stop_line') continue
    const osmId = way.getAttribute('id')
    if (!osmId) continue
    const vertices = elementChildren(way, 'nd').map(nd => nodes.get(nd.getAttribute('ref') ?? '')).filter((v): v is RoadVertex => !!v)
    if (vertices.length < 2) continue
    const direction = tags.direction ?? 'both'
    features.push({ id: `infra-way-${osmId}`, osmId, kind: 'stop_line', element: 'way', vertices,
      direction: DIRECTIONS.has(direction as TrafficDirection) ? direction as TrafficDirection : 'both', tags,
      roadOsmId: tags[ROAD_REF], laneIndices: parseLaneSelection(tags[LANE_REFS]) })
  }
  return features
}

export interface RoadPlacementOptions {
  /** A road identified from the exact rendered lane under the pointer. */
  preferredRoadId?: string
  /** Only allow an elevated road when the pointer was resolved in screen space. */
  allowElevated?: boolean
  /** Expand the snap radius to cover the physical width of multi-lane roads. */
  roadWidthAware?: boolean
}

/** Find the nearest usable road segment. Manual placement can use the rendered
 * road under the pointer and the actual carriageway width; imported OSM
 * lookups keep the conservative centreline-only default. */
export function findRoadPlacement(at: RoadVertex, roads: readonly RoadFeature[], toleranceMetres = 10,
  options: RoadPlacementOptions = {}): RoadPlacement | null {
  const preferred = options.preferredRoadId
    ? roads.find(road => road.id === options.preferredRoadId)
    : undefined
  const ordered = preferred ? [preferred, ...roads.filter(road => road.id !== preferred.id)] : roads
  let best: RoadPlacement | null = null
  for (const road of ordered) {
    const isPreferred = road.id === options.preferredRoadId
    if (!isTrafficRoad(road) || road.vertices.length < 2) continue
    if ((road.bridge || road.level !== 0) && !(options.allowElevated && isPreferred)) continue
    const roadTolerance = options.roadWidthAware
      ? Math.max(toleranceMetres, clampRoadLanes(road.lanes) * LANE_WIDTH_METRES / 2 + 2)
      : toleranceMetres
    let roadBest: RoadPlacement | null = null
    for (let i = 0; i < road.vertices.length - 1; i++) {
      const a = road.vertices[i]!, b = road.vertices[i + 1]!
      const metersPerLng = 111_320 * Math.max(0.1, Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180))
      const dx = (b.lng - a.lng) * metersPerLng, dy = (b.lat - a.lat) * 111_320
      const x = (at.lng - a.lng) * metersPerLng, y = (at.lat - a.lat) * 111_320
      const len2 = dx * dx + dy * dy
      if (len2 < 1e-4) continue
      const t = Math.max(0, Math.min(1, (x * dx + y * dy) / len2))
      const vertex = { id: '', lng: a.lng + (b.lng - a.lng) * t, lat: a.lat + (b.lat - a.lat) * t }
      const distance = distanceMetres(at, vertex)
      if (distance > roadTolerance || roadBest && distance >= roadBest.distance) continue
      roadBest = { roadId: road.id, segmentIndex: i, t, point: vertex, distance }
    }
    // If MapLibre identified the exact rendered road, never switch to a
    // nearby parallel road merely because its centreline is a little closer.
    if (isPreferred && roadBest) return roadBest
    if (roadBest && (!best || roadBest.distance < best.distance)) best = roadBest
  }
  return best
}

/** A metric perpendicular line across all carriageway lanes. */
export function stopLineVertices(road: RoadFeature, segmentIndex: number, center: RoadVertex, idFactory: () => string): RoadVertex[] {
  const a = road.vertices[segmentIndex]!, b = road.vertices[segmentIndex + 1]!
  if (!a || !b) throw new Error('Отрезок дороги больше не существует.')
  const scale = 111_320 * Math.max(0.1, Math.cos(center.lat * Math.PI / 180))
  const dx = (b.lng - a.lng) * scale, dy = (b.lat - a.lat) * 111_320
  const length = Math.hypot(dx, dy)
  if (length < 1) throw new Error('Дорожный участок слишком короткий для стоп-линии.')
  const half = clampRoadLanes(road.lanes) * LANE_WIDTH_METRES / 2
  const x = dy / length * half, y = -dx / length * half
  return [
    { id: idFactory(), lng: center.lng + x / scale, lat: center.lat + y / 111_320 },
    { id: idFactory(), lng: center.lng - x / scale, lat: center.lat - y / 111_320 },
  ]
}

/** Physical lane indices compatible with a control's traffic direction. */
export function allowedInfrastructureLanes(road: RoadFeature, direction: TrafficDirection): number[] {
  const { forward, backward } = laneDirections(road)
  const count = clampRoadLanes(road.lanes)
  return Array.from({ length: count }, (_, i) => i).filter(i =>
    direction === 'both' || direction === 'forward' && i >= backward && forward > 0 ||
    direction === 'backward' && i < backward)
}
export function effectiveInfrastructureLanes(feature: InfrastructureFeature, road: RoadFeature): number[] {
  const allowed = allowedInfrastructureLanes(road, feature.direction)
  if (!feature.laneIndices?.length) return allowed
  return feature.laneIndices.filter(index => allowed.includes(index)).sort((a, b) => a - b)
}
export function contiguousLanes(lanes: readonly number[]): boolean {
  return lanes.length > 0 && lanes.every((value, i) => i === 0 || value === lanes[i - 1]! + 1)
}

/** Reusable lookup for many controls on a large OSM network.
 * Build once per road geometry revision, then resolve each sign against its
 * owning way/shared node or a small spatial bucket instead of scanning the city. */
export interface InfrastructurePlacementIndex {
  roadsById: Map<string, RoadFeature>
  roadsByOsmId: Map<string, RoadFeature[]>
  roadsByNodeId: Map<string, RoadFeature[]>
  spatial: ReturnType<typeof createSceneRoadIndex>
}

export function createInfrastructurePlacementIndex(roads: readonly RoadFeature[]): InfrastructurePlacementIndex {
  const roadsById = new Map<string, RoadFeature>()
  const roadsByOsmId = new Map<string, RoadFeature[]>()
  const roadsByNodeId = new Map<string, RoadFeature[]>()
  const motor = roads.filter(isTrafficRoad)
  for (const road of motor) {
    roadsById.set(road.id, road)
    const sameWay = roadsByOsmId.get(road.osmId)
    if (sameWay) sameWay.push(road)
    else roadsByOsmId.set(road.osmId, [road])
    for (const vertex of road.vertices) {
      const owners = roadsByNodeId.get(vertex.id)
      if (owners) {
        if (!owners.includes(road)) owners.push(road)
      } else roadsByNodeId.set(vertex.id, [road])
    }
  }
  return { roadsById, roadsByOsmId, roadsByNodeId, spatial: createSceneRoadIndex(motor) }
}

function findIndexedRoadPlacement(at: RoadVertex, index: InfrastructurePlacementIndex,
  toleranceMetres = 12): RoadPlacement | null {
  const projected = index.spatial.project(at.lng, at.lat)
  let best: RoadPlacement | null = null
  for (const entry of index.spatial.nearby(at.lng, at.lat)) {
    const road = entry.road
    if (!isTrafficRoad(road) || road.bridge || road.level !== 0) continue
    const hit = sceneSegmentHit(entry, projected.x, projected.y)
    if (hit.distance > toleranceMetres || best && hit.distance >= best.distance) continue
    best = {
      roadId: road.id,
      segmentIndex: entry.segmentIndex,
      t: hit.t,
      point: {
        id: '',
        lng: entry.a.lng + (entry.b.lng - entry.a.lng) * hit.t,
        lat: entry.a.lat + (entry.b.lat - entry.a.lat) * hit.t,
      },
      distance: hit.distance,
    }
  }
  return best
}

/** Prefer persisted way identity or a true shared OSM node over coordinate proximity.
 * A nearest-centreline fallback is needed for imported signs not inserted into a way. */
export function infrastructureRoadPlacement(feature: InfrastructureFeature, roads: readonly RoadFeature[],
  index?: InfrastructurePlacementIndex):
  { road: RoadFeature; hit: RoadPlacement } | null {
  const point = feature.element === 'way' && feature.vertices.length >= 2
    ? { ...feature.vertices[0]!, lng: (feature.vertices[0]!.lng + feature.vertices[feature.vertices.length - 1]!.lng) / 2,
      lat: (feature.vertices[0]!.lat + feature.vertices[feature.vertices.length - 1]!.lat) / 2 }
    : feature.vertices[0]
  if (!point) return null

  if (index) {
    const preferred = feature.roadOsmId ? index.roadsByOsmId.get(feature.roadOsmId) ?? [] : []
    for (const candidates of [preferred, index.roadsByNodeId.get(feature.vertices[0]?.id ?? '') ?? []]) {
      if (!candidates.length) continue
      const hit = findRoadPlacement(point, candidates, 18)
      if (hit) {
        const road = candidates.find(item => item.id === hit.roadId)
        if (road) return { road, hit }
      }
    }
    const hit = findIndexedRoadPlacement(point, index, 12)
    const road = hit && index.roadsById.get(hit.roadId)
    return hit && road ? { road, hit } : null
  }

  const preferred = feature.roadOsmId ? roads.filter(road => road.osmId === feature.roadOsmId) : []
  const shared = roads.filter(road => !road.bridge && road.level === 0 &&
    road.vertices.some(vertex => vertex.id === feature.vertices[0]?.id))
  for (const candidates of [preferred, shared]) {
    const hit = findRoadPlacement(point, candidates, 18)
    if (hit) {
      const road = candidates.find(road => road.id === hit.roadId)
      if (road) return { road, hit }
    }
  }
  const hit = findRoadPlacement(point, roads, 12)
  const road = hit && roads.find(road => road.id === hit.roadId)
  return hit && road ? { road, hit } : null
}

/** Candidate approaches near an OSM control at a multi-way junction.
 * Explicit user selection avoids assigning a signal to the wrong street. */
export function nearbyInfrastructureRoads(feature: InfrastructureFeature, roads: readonly RoadFeature[],
  toleranceMetres = 15, index?: InfrastructurePlacementIndex): Array<{ road: RoadFeature; hit: RoadPlacement }> {
  const point = feature.element === 'way' && feature.vertices.length >= 2
    ? { ...feature.vertices[0]!, lng: (feature.vertices[0]!.lng + feature.vertices[feature.vertices.length - 1]!.lng) / 2,
      lat: (feature.vertices[0]!.lat + feature.vertices[feature.vertices.length - 1]!.lat) / 2 }
    : feature.vertices[0]
  if (!point) return []
  const candidates = index
    ? [...new Set(index.spatial.nearby(point.lng, point.lat).map(segment => segment.road))]
    : [...roads]
  return candidates.flatMap(road => {
    const hit = findRoadPlacement(point, [road], toleranceMetres)
    return hit ? [{ road, hit }] : []
  }).sort((a, b) => a.hit.distance - b.hit.distance).slice(0, 12)
}

function segmentNormal(road: RoadFeature, segmentIndex: number, lat: number):
  { scaleX: number; nx: number; ny: number; tx: number; ty: number } {
  const a = road.vertices[segmentIndex]!, b = road.vertices[segmentIndex + 1]!
  if (!a || !b) throw new Error('Отрезок дороги больше не существует.')
  const scaleX = 111_320 * Math.max(0.1, Math.cos(lat * Math.PI / 180))
  const dx = (b.lng - a.lng) * scaleX, dy = (b.lat - a.lat) * 111_320
  const size = Math.hypot(dx, dy)
  if (size < 0.05) throw new Error('Нулевой отрезок дороги.')
  return { scaleX, nx: -dy / size, ny: dx / size, tx: dx / size, ty: dy / size }
}
function placeInMetres(center: RoadVertex, frame: ReturnType<typeof segmentNormal>, left: number, along = 0): RoadVertex {
  return { ...center, lng: center.lng + (frame.nx * left + frame.tx * along) / frame.scaleX,
    lat: center.lat + (frame.ny * left + frame.ty * along) / 111_320 }
}

/** A line crosses only the specified contiguous lane bands; absent lanes have no markings. */
export function stopLineLaneSegments(road: RoadFeature, segmentIndex: number, center: RoadVertex,
  laneIndices: readonly number[], along = 0): RoadVertex[][] {
  const count = clampRoadLanes(road.lanes)
  const ordered = [...new Set(laneIndices)].filter(index => Number.isInteger(index) && index >= 0 && index < count).sort((a, b) => a - b)
  if (!ordered.length) return []
  const frame = segmentNormal(road, segmentIndex, center.lat)
  const groups: number[][] = []
  for (const index of ordered) {
    if (groups.length && groups[groups.length - 1]![groups[groups.length - 1]!.length - 1] === index - 1)
      groups[groups.length - 1]!.push(index)
    else groups.push([index])
  }
  return groups.map(group => {
    const start = group[0]!, end = group[group.length - 1]!
    return [
      placeInMetres(center, frame, (count / 2 - start) * LANE_WIDTH_METRES, along),
      placeInMetres(center, frame, (count / 2 - end - 1) * LANE_WIDTH_METRES, along),
    ]
  })
}

/** Icon is centered over the selected lanes, never the way's centreline by default. */
export function infrastructureIconLocation(feature: InfrastructureFeature, roads: readonly RoadFeature[], index?: InfrastructurePlacementIndex): RoadVertex | null {
  const point = feature.vertices[0]
  if (!point) return null
  // Crosswalk signs are tied to their exact source point. Looking up the
  // closest road for every imported crossing was an expensive no-op on large
  // OSM maps (hundreds of crossings × thousands of road segments).
  if (feature.kind === 'crossing') return point
  const placement = infrastructureRoadPlacement(feature, roads, index)
  if (!placement) return point
  const lanes = effectiveInfrastructureLanes(feature, placement.road)
  if (!lanes.length) return point
  const frame = segmentNormal(placement.road, placement.hit.segmentIndex, point.lat)
  const count = clampRoadLanes(placement.road.lanes)
  const mean = lanes.reduce((a, b) => a + b, 0) / lanes.length
  return placeInMetres(point, frame, ((count - 1) / 2 - mean) * LANE_WIDTH_METRES)
}

export interface TrafficMarking { infraId: string; selected: boolean; coordinates: [number, number][] }
/** Includes physical stop-line ways and *visual-only* approach lines for signs.
 * Automatic approach lines are not represented as physical OSM ways. */
export function infrastructureMarkings(features: readonly InfrastructureFeature[], roads: readonly RoadFeature[],
  selectedId: string | null, index?: InfrastructurePlacementIndex): TrafficMarking[] {
  const result: TrafficMarking[] = []
  const addLine = (feature: InfrastructureFeature, vertices: readonly RoadVertex[]) => {
    if (vertices.length > 1) result.push({ infraId: feature.id, selected: feature.id === selectedId,
      coordinates: vertices.map(v => [v.lng, v.lat]) })
  }
  for (const feature of features) {
    const found = infrastructureRoadPlacement(feature, roads, index)
    if (feature.kind === 'stop_line') {
      if (feature.element === 'node' && found) {
        for (const segment of stopLineLaneSegments(found.road, found.hit.segmentIndex, found.hit.point,
          effectiveInfrastructureLanes(feature, found.road))) addLine(feature, segment)
        continue
      }
      if (feature.element !== 'way' || feature.vertices.length < 2) continue
      // Untouched imported geometry must remain visually faithful to the source.
      if (!found || !feature.laneIndices?.length) { addLine(feature, feature.vertices); continue }
      const center = { ...found.hit.point, lng: (feature.vertices[0]!.lng + feature.vertices[feature.vertices.length - 1]!.lng) / 2,
        lat: (feature.vertices[0]!.lat + feature.vertices[feature.vertices.length - 1]!.lat) / 2 }
      for (const segment of stopLineLaneSegments(found.road, found.hit.segmentIndex, center,
        effectiveInfrastructureLanes(feature, found.road))) addLine(feature, segment)
      continue
    }
    const enabled = feature.tags[PREVIEW_LINE] === 'yes' ||
      feature.tags[PREVIEW_LINE] !== 'no' && (feature.kind === 'traffic_signal' || feature.kind === 'stop')
    if (!enabled || !found) continue
    const selected = effectiveInfrastructureLanes(feature, found.road)
    const distribution = laneDirections(found.road)
    const groups: { indices: number[]; along: number }[] = []
    if (feature.direction !== 'backward') groups.push({
      indices: selected.filter(i => i >= distribution.backward), along: -2.3 })
    if (feature.direction !== 'forward') groups.push({
      indices: selected.filter(i => i < distribution.backward), along: 2.3 })
    for (const group of groups) {
      for (const segment of stopLineLaneSegments(found.road, found.hit.segmentIndex, found.hit.point,
        group.indices, group.along)) addLine(feature, segment)
    }
  }
  return result
}

export function featureTags(kind: InfrastructureKind, direction: TrafficDirection, existing: Record<string, string> = {}): Record<string, string> {
  if (!DIRECTIONS.has(direction)) throw new Error('Некорректное направление движения.')
  const tags = { ...existing }
  delete tags.highway
  if (kind === 'stop_line' || existing[MARKING] !== 'stop_line') delete tags[MARKING]
  delete tags['traffic_signals:direction']
  delete tags.direction
  if (kind === 'traffic_signal') {
    tags.highway = 'traffic_signals'
    if (direction !== 'both') tags['traffic_signals:direction'] = direction
  } else if (kind === 'stop_line') {
    tags[MARKING] = 'stop_line'
    tags.stroke = existing.stroke ?? 'solid'
    if (direction !== 'both') tags.direction = direction
  } else {
    tags.highway = kind
    if (kind === 'crossing') tags['crossing:markings'] = existing['crossing:markings'] ?? 'zebra'
    if (kind !== 'crossing' && direction !== 'both') tags.direction = direction
  }
  return tags
}

/** Use a high-magnitude negative ID so five clients cannot accidentally
 * allocate the same -1/-2 ID while they are editing different roads. */
export function newOsmId(reserved: ReadonlySet<string>): string {
  for (let i = 0; i < 20; i++) {
    const id = String(-Date.now() * 1024 - Math.floor(Math.random() * 1024))
    if (!reserved.has(id)) return id
  }
  throw new Error('Не удалось выделить уникальный идентификатор OSM.')
}

function ensureNode(doc: Document, root: Element, id: string, vertex: RoadVertex): Element {
  let node = elementChildren(root, 'node').find(el => el.getAttribute('id') === id)
  if (!node) {
    node = doc.createElement('node')
    node.setAttribute('id', id)
    node.setAttribute('visible', 'true')
    node.setAttribute('version', '1')
    const firstWay = Array.from(root.children).find(el => el.tagName === 'way' || el.tagName === 'relation')
    if (firstWay) root.insertBefore(node, firstWay)
    else root.appendChild(node)
  }
  node.setAttribute('lat', vertex.lat.toFixed(8))
  node.setAttribute('lon', vertex.lng.toFixed(8))
  return node
}
function replaceRelevantTags(doc: Document, node: Element, feature: InfrastructureFeature, before?: InfrastructureFeature): void {
  // Keep unrelated OSM tags and POIs on the shared road node, including tags
  // the editor does not know how to interpret. Only remove owned keys.
  const keys = new Set(['highway', MARKING, 'traffic_signals:direction', 'direction', ROAD_REF, LANE_REFS, PREVIEW_LINE])
  if (feature.kind === 'crossing' || before?.kind === 'crossing') keys.add('crossing:markings')
  if (feature.kind === 'stop_line' || before?.kind === 'stop_line') keys.add('stroke')
  for (const tag of elementChildren(node, 'tag')) if (keys.has(tag.getAttribute('k') ?? '')) node.removeChild(tag)
  for (const key of keys) if (feature.tags[key] !== undefined) {
    const el = doc.createElement('tag')
    el.setAttribute('k', key)
    el.setAttribute('v', feature.tags[key]!)
    node.appendChild(el)
  }
}
function removeRelevantTags(node: Element, feature: InfrastructureFeature): void {
  const keys = new Set(['highway', MARKING, 'traffic_signals:direction', 'direction', ROAD_REF, LANE_REFS, PREVIEW_LINE])
  if (feature.kind === 'crossing') keys.add('crossing:markings')
  if (feature.kind === 'stop_line') keys.add('stroke')
  // A STOP node can additionally encode a painted stop-line. Removing the
  // sign must not silently delete that independent physical road marking.
  if (feature.kind !== 'stop_line' && feature.tags[MARKING] === 'stop_line') { keys.delete(MARKING); keys.delete('stroke') }
  for (const tag of elementChildren(node, 'tag')) {
    const name = tag.getAttribute('k') ?? ''
    if (keys.has(name)) node.removeChild(tag)
  }
}
/** Serialize edits without deleting unrelated nodes, relations or OSM ways.
 * Import/export of untouched infrastructure is byte-semantically preserved. */
export function writeInfrastructure(xml: string, features: readonly InfrastructureFeature[], baseline: readonly InfrastructureFeature[]): string {
  // Avoid a second XML parse on the common no-infrastructure/no-change path.
  if (!features.length && !baseline.length) return xml
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.querySelector('parsererror')) throw new Error('Некорректный рабочий OSM XML.')
  const root = doc.documentElement
  const original = new Map(baseline.map(f => [f.id, f]))
  const current = new Map(features.map(f => [f.id, f]))
  const findElement = (kind: 'node' | 'way', id: string) => elementChildren(root, kind).find(el => el.getAttribute('id') === id)
  for (const old of baseline) {
    const next = current.get(old.id)
    if (next) continue
    const el = findElement(old.element, old.osmId)
    if (!el) continue
    if (old.element === 'node') removeRelevantTags(el, old)
    else root.removeChild(el) // leave original node references intact
  }
  for (const feature of features) {
    const old = original.get(feature.id)
    if (old && JSON.stringify(old) === JSON.stringify(feature)) continue
    if (feature.element === 'node') {
      const vertex = feature.vertices[0]
      if (!vertex) continue
      const node = ensureNode(doc, root, feature.osmId, vertex)
      replaceRelevantTags(doc, node, feature, old)
    } else {
      let way = findElement('way', feature.osmId)
      if (!way) {
        way = doc.createElement('way')
        way.setAttribute('id', feature.osmId)
        way.setAttribute('visible', 'true')
        way.setAttribute('version', '1')
        const firstRelation = elementChildren(root, 'relation')[0]
        if (firstRelation) root.insertBefore(way, firstRelation)
        else root.appendChild(way)
      }
      for (const nd of elementChildren(way, 'nd')) way.removeChild(nd)
      for (const vertex of feature.vertices) {
        const osmId = vertex.id.startsWith('osm-node-') ? vertex.id.slice(9) : vertex.id
        ensureNode(doc, root, osmId, vertex)
        const nd = doc.createElement('nd')
        nd.setAttribute('ref', osmId)
        const firstTag = elementChildren(way, 'tag')[0]
        if (firstTag) way.insertBefore(nd, firstTag)
        else way.appendChild(nd)
      }
      replaceRelevantTags(doc, way, feature, old)
    }
  }
  return serializeOsmDocument(new XMLSerializer().serializeToString(doc))
}
