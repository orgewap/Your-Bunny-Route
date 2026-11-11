import { readSceneBarriers } from '../lib/scene3d'
import type { SceneBarrier } from '../lib/scene3d'
import { computed, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import type { EditorTool, PenMode, RoadFeature, RoadPatch, ViewMode } from '../types/road'
import { downloadOsm, exportOsm, importOsm } from '../lib/osm'
import { materializeRoadPlan, distanceMetres, isTrafficRoad } from '../lib/topology'
import { planRoundabout, planPenEllipseRoundabout } from '../lib/roundabout'
import { splitGroundRoadForBridge } from '../lib/bridges'
import type { RoadPlan } from '../lib/topology'
import type { RoundaboutPlan } from '../lib/roundabout'
import type { RoadVertex } from '../types/road'
import { reconnectDraggedEndpoint } from '../lib/reconnect'
import { updateSelectedDraggedVertex } from '../lib/vertexDrag'
import { clampRoadLanes } from '../lib/lanes'
import { classifyRoads } from '../lib/roadStatus'
import { withLaneTurnRules } from '../lib/laneRules'
import type { LaneTurnToken } from '../lib/laneRules'
import { planJunction } from '../lib/junction'
import type { JunctionPlan } from '../lib/junction'
import type { TargetLink } from '../lib/topology'
import { disconnectRoadVertex } from '../lib/disconnect'
import { attachPedestrianPath, isPedestrianWay, pedestrianWays, motorRoads } from '../lib/pedestrian'
import type { RoadMarkingChoice } from '../lib/roadMarkings'
import { isolatedMoveVertices, shiftVertices } from '../lib/translate'
import { readInfrastructure, writeInfrastructure, findRoadPlacement, featureTags, newOsmId, allowedInfrastructureLanes, effectiveInfrastructureLanes, contiguousLanes, infrastructureRoadPlacement, nearbyInfrastructureRoads, stopLineLaneSegments } from '../lib/infrastructure'
import type { InfrastructureFeature, InfrastructureKind, TrafficDirection } from '../lib/infrastructure'
import { analyzeRoadNetwork } from '../lib/networkAnalysis'
import type { RoadNetworkAnalysis } from '../lib/networkAnalysis'
import { inspectSimulatorOsm } from '../lib/simulatorExport'
import type { SimulatorExportReport } from '../lib/simulatorExport'


// Copy individual values rather than passing Vue reactive proxies to structuredClone.
const copyRoads = (roads: RoadFeature[]): RoadFeature[] => roads.map(road => ({
  ...road,
  tags: { ...road.tags },
  vertices: road.vertices.map(vertex => ({ ...vertex })),
}))

const copyInfrastructure = (features: InfrastructureFeature[]) => features.map(f => ({
  ...f, tags: { ...f.tags }, vertices: f.vertices.map(v => ({ ...v })),
  laneIndices: f.laneIndices ? [...f.laneIndices] : undefined,
}))
type HistorySnapshot =
  | { kind: 'full'; roads: RoadFeature[]; infrastructure: InfrastructureFeature[] }
  | { kind: 'infrastructure'; infrastructure: InfrastructureFeature[];
      roadVertices?: { roadId: string; vertices: RoadVertex[] } }

export const useEditorStore = defineStore('editor', () => {
  const roads = ref<RoadFeature[]>([])
  const infrastructure = ref<InfrastructureFeature[]>([])
  const sceneBarriers = ref<SceneBarrier[]>([])
  const originalInfrastructure = ref<InfrastructureFeature[]>([])
  const selectedInfrastructureId = ref<string | null>(null)
  const selectedInfrastructure = computed(() => infrastructure.value.find(f => f.id === selectedInfrastructureId.value) ?? null)
  const infraKind = ref<InfrastructureKind>('traffic_signal')
  const infraRelocationId = ref<string | null>(null)
  const readOnly = ref(false)
  // Lightweight invalidation for map rendering. Watching roads deeply visited
  // every vertex on every mousemove and made large OSM projects unusable.
  const geometryRevision = ref(0)
  const roadRenderRevision = ref(0)
  const roadOverlayRevision = ref(0)
  const infrastructureRevision = ref(0)
  const roadStatusRevision = ref(0)
  const crosswalkRevision = ref(0)
  const reservedOsmIds = new Set<string>()
  const selectedId = ref<string | null>(null)
  const tool = ref<EditorTool>('select')
  const penMode = ref<PenMode>('draw')
  const moveObjectMode = ref(false)
  const mode = ref<ViewMode>('2d')
  const graphView = ref(false)
  const networkMode = ref<'motor' | 'pedestrian' | 'all'>('motor')
  const motorRoadCount = computed(() => motorRoads(roads.value).length)
  const walkWayCount = computed(() => pedestrianWays(roads.value).length)
  const selectedGraphLane = ref<{ roadId: string; laneIndex: number } | null>(null)
  const projectName = ref('Новый проект')
  const sourceXml = ref('')
  const originalRoadIds = ref<string[]>([])
  const originalWayIds = ref<string[]>([])
  const baselineRoads = ref<RoadFeature[]>([])
  const importedCounts = ref({ nodes: 0, ways: 0, relations: 0 })
  const notifications = ref<string[]>(['Готово'])
  const dirty = ref(false)
  // Undo snapshots are immutable. Vue must not proxy tens of thousands of
  // historical vertices: it wastes memory and slows down every edit.
  const history = shallowRef<HistorySnapshot[]>([])
  const future = shallowRef<HistorySnapshot[]>([])
  const selectedRoad = computed(() => roads.value.find((road) => road.id === selectedId.value) ?? null)
  const bridgeCount = computed(() => roads.value.filter((road) => road.bridge).length)
  // Statuses depend on the imported baseline, not on whether Undo has a snapshot.
  // geometryRevision invalidates the result while a vertex is being dragged.
  const roadStatusIndex = computed(() => {
    void roadStatusRevision.value
    return classifyRoads(roads.value, baselineRoads.value, originalRoadIds.value)
  })
  const roadStatusById = computed(() => roadStatusIndex.value.byId)
  const roadStatusCounts = computed(() => {
    const counts = { imported: 0, created: 0, modified: 0 }
    for (const road of roads.value) if (isTrafficRoad(road)) {
      const status = roadStatusIndex.value.byId.get(road.id) ?? 'imported'
      counts[status]++
    }
    return counts
  })
  // Analysis is deliberately on-demand: opening the tab does not scan a large
  // city. Results are view-only and never enter OSM XML or project persistence.
  const roadAnalysis = shallowRef<RoadNetworkAnalysis | null>(null)
  const roadAnalysisStale = ref(false)
  const roadAnalysisVisible = ref(true)
  const roadAnalysisRevision = ref(0)

  function markRoadAnalysisStale(): void {
    if (roadAnalysis.value && !roadAnalysisStale.value) {
      roadAnalysisStale.value = true
      roadAnalysisRevision.value++
    }
  }
  function runRoadAnalysis(): RoadNetworkAnalysis {
    const result = analyzeRoadNetwork(roads.value, baselineRoads.value)
    roadAnalysis.value = result
    roadAnalysisStale.value = false
    roadAnalysisVisible.value = true
    roadAnalysisRevision.value++
    return result
  }
  function clearRoadAnalysis(): void {
    roadAnalysis.value = null
    roadAnalysisStale.value = false
    roadAnalysisVisible.value = false
    roadAnalysisRevision.value++
  }



  function notify(message: string): void {
    notifications.value = [message, ...notifications.value].slice(0, 40)
  }
  function canEdit(): boolean {
    if (!readOnly.value) return true
    notify('Недостаточно прав: проект доступен только для просмотра.')
    return false
  }
  function touchRoads(): void {
    geometryRevision.value++
    roadRenderRevision.value++
    roadStatusRevision.value++
    markRoadAnalysisStale()
  }
  function touchRoadOverlays(): void {
    geometryRevision.value++
    roadOverlayRevision.value++
    roadStatusRevision.value++
  }
  function touchInfrastructure(roadTopologyChanged = false, crosswalkChanged = false): void {
    geometryRevision.value++
    infrastructureRevision.value++
    if (roadTopologyChanged) {
      roadStatusRevision.value++
      markRoadAnalysisStale()
    }
    if (crosswalkChanged) crosswalkRevision.value++
  }
  function reserveRoadIds(items: readonly RoadFeature[]): void {
    for (const road of items) {
      reservedOsmIds.add(road.osmId)
      for (const vertex of road.vertices) {
        if (vertex.id.startsWith('osm-node-')) reservedOsmIds.add(vertex.id.slice('osm-node-'.length))
      }
    }
  }
  function rebuildReservedOsmIds(xml: string): void {
    reservedOsmIds.clear()
    if (xml) {
      const doc = new DOMParser().parseFromString(xml, 'application/xml')
      for (const element of Array.from(doc.querySelectorAll('node[id], way[id], relation[id]'))) {
        const id = element.getAttribute('id')
        if (id) reservedOsmIds.add(id)
      }
    }
    reserveRoadIds(roads.value)
    for (const feature of infrastructure.value) {
      reservedOsmIds.add(feature.osmId)
      for (const vertex of feature.vertices) {
        if (vertex.id.startsWith('osm-node-')) reservedOsmIds.add(vertex.id.slice('osm-node-'.length))
      }
    }
  }
  function allocateOsmId(): string {
    const id = newOsmId(reservedOsmIds)
    reservedOsmIds.add(id)
    return id
  }
  function pushHistory(snapshot: HistorySnapshot): void {
    history.value = [...history.value.slice(-24), snapshot]
    future.value = []
  }
  function checkpoint(): void {
    pushHistory({ kind: 'full', roads: copyRoads(roads.value), infrastructure: copyInfrastructure(infrastructure.value) })
  }
  function checkpointInfrastructure(roadId?: string): void {
    const road = roadId ? roads.value.find(item => item.id === roadId) : undefined
    pushHistory({ kind: 'infrastructure', infrastructure: copyInfrastructure(infrastructure.value),
      roadVertices: road ? { roadId: road.id, vertices: road.vertices.map(vertex => ({ ...vertex })) } : undefined })
  }
  function captureHistoryState(shape: HistorySnapshot): HistorySnapshot {
    if (shape.kind === 'full') {
      return { kind: 'full', roads: copyRoads(roads.value), infrastructure: copyInfrastructure(infrastructure.value) }
    }
    const road = shape.roadVertices ? roads.value.find(item => item.id === shape.roadVertices!.roadId) : undefined
    return { kind: 'infrastructure', infrastructure: copyInfrastructure(infrastructure.value),
      roadVertices: road ? { roadId: road.id, vertices: road.vertices.map(vertex => ({ ...vertex })) } : undefined }
  }
  function applyHistoryState(snapshot: HistorySnapshot): void {
    infrastructure.value = snapshot.infrastructure
    if (snapshot.kind === 'full') {
      roads.value = snapshot.roads
      return
    }
    if (snapshot.roadVertices) {
      const road = roads.value.find(item => item.id === snapshot.roadVertices!.roadId)
      if (road) road.vertices = snapshot.roadVertices.vertices.map(vertex => ({ ...vertex }))
    }
  }
  function selectRoad(id: string | null): void {
    if (selectedId.value !== id) { moveObjectMode.value = false; selectedGraphLane.value = null }
    selectedId.value = id
    selectedInfrastructureId.value = null
    infraRelocationId.value = null
    tool.value = 'select'
  }
  function selectInfrastructure(id: string | null): void {
    selectedInfrastructureId.value = id
    selectedId.value = null
    selectedGraphLane.value = null
    moveObjectMode.value = false
    infraRelocationId.value = null
    tool.value = 'select'
  }
  function setInfrastructureTool(kind: InfrastructureKind): void {
    if (!canEdit()) return
    infraKind.value = kind
    infraRelocationId.value = null
    tool.value = 'infrastructure'
  }
  function selectGraphLane(roadId: string, laneIndex: number): void {
    selectRoad(roadId)
    selectedGraphLane.value = { roadId, laneIndex }
  }
  function setNetworkMode(value: 'motor' | 'pedestrian' | 'all'): void {
    if (networkMode.value === value) return
    networkMode.value = value
    selectedId.value = null
    selectedGraphLane.value = null
    moveObjectMode.value = false
    if (value !== 'motor') graphView.value = false
    tool.value = 'select'
    // View-only change; redraw handles the network switch without rebuilding geometry.
    notify(value === 'motor' ? 'Автомобильный граф' : value === 'pedestrian' ? 'Пешеходный граф' : 'Оба графа')
  }
  function setTool(value: EditorTool): void { if (readOnly.value && value !== 'select') return; tool.value = value; if (value !== 'select') moveObjectMode.value = false; if (value !== 'infrastructure') infraRelocationId.value = null }
  function undo(): void {
    if (!canEdit()) return
    const snapshot = history.value[history.value.length - 1]
    if (!snapshot) return
    history.value = history.value.slice(0, -1)
    future.value = [...future.value, captureHistoryState(snapshot)]
    applyHistoryState(snapshot)
    selectedInfrastructureId.value = null
    selectedGraphLane.value = null
    if (selectedId.value && !roads.value.some(road => road.id === selectedId.value)) selectedId.value = null
    dirty.value = true
    geometryRevision.value++
    infrastructureRevision.value++
    crosswalkRevision.value++
    if (snapshot.kind === 'full') {
      roadRenderRevision.value++
      roadStatusRevision.value++
      markRoadAnalysisStale()
    } else if (snapshot.roadVertices) {
      roadStatusRevision.value++
      markRoadAnalysisStale()
    }
    notify('Последнее изменение отменено.')
  }
  function redo(): void {
    if (!canEdit()) return
    const snapshot = future.value[future.value.length - 1]
    if (!snapshot) return
    future.value = future.value.slice(0, -1)
    history.value = [...history.value, captureHistoryState(snapshot)]
    applyHistoryState(snapshot)
    selectedInfrastructureId.value = null
    selectedGraphLane.value = null
    if (selectedId.value && !roads.value.some(road => road.id === selectedId.value)) selectedId.value = null
    dirty.value = true
    geometryRevision.value++
    infrastructureRevision.value++
    crosswalkRevision.value++
    if (snapshot.kind === 'full') {
      roadRenderRevision.value++
      roadStatusRevision.value++
      markRoadAnalysisStale()
    } else if (snapshot.roadVertices) {
      roadStatusRevision.value++
      markRoadAnalysisStale()
    }
    notify('Изменение повторено.')
  }
  /** Pedestrian ways stay real OSM ways with shared node IDs, never car lanes. */
  function addPedestrianWay(path: RoadVertex[], type: 'footway' | 'path' | 'steps' = 'footway'): void {
    if (!canEdit()) return
    const attached = attachPedestrianPath(roads.value, path, 7)
    const reserved = new Set([...originalWayIds.value, ...roads.value.map(item => item.osmId)])
    let osm = -1
    while (reserved.has(String(osm))) osm--
    checkpoint()
    const newRoad: RoadFeature = { id: crypto.randomUUID(), osmId: String(osm), name: '',
      highway: type, lanes: 1, oneway: false, bridge: false, level: 0,
      vertices: attached.vertices, tags: { highway: type, foot: 'yes' } }
    roads.value = [...attached.roads, newRoad]
    selectedId.value = newRoad.id
    tool.value = 'select'
    dirty.value = true
    touchRoads()
    notify(`Добавлена пешеходная дорожка (${newRoad.vertices.length} узлов).`)
  }
  function setRoadMarking(roadId: string, field: 'centre' | 'edge', kind: RoadMarkingChoice): void {
    if (!canEdit()) return
    const road = roads.value.find(item => item.id === roadId)
    if (!road || isPedestrianWay(road)) return
    checkpoint()
    const key = field === 'centre' ? 'road_editor:centre_marking' : 'road_editor:edge_marking'
    if (kind === 'auto') delete road.tags[key]
    else road.tags[key] = kind
    dirty.value = true
    touchRoadOverlays()
    notify('Дорожная разметка обновлена.')
  }
  /** Separate metadata editor: never mutates existing road topology. */
  function setWebotsTag(roadId: string, key: 'road_editor:kerb' | 'road_editor:kerb_height' |
    'road_editor:guard_rail' | 'road_editor:bridge_support' | 'road_editor:support_spacing', value: string): void {
    if (!canEdit()) return
    const road = roads.value.find(item => item.id === roadId)
    if (!road || isPedestrianWay(road)) return
    if (road.tags[key] === value || (!road.tags[key] && (value === 'auto' || !value))) return
    checkpoint()
    if (!value || value === 'auto') delete road.tags[key]
    else road.tags[key] = value
    dirty.value = true
    touchRoadOverlays()
    notify('Параметры инфраструктуры 3D сохранены в OSM.')
  }

  function setPedestrianAttribute(roadId: string, key: 'surface' | 'footway' | 'wheelchair', value: string): void {
    if (!canEdit()) return
    const road = roads.value.find(item => item.id === roadId)
    if (!road || !isPedestrianWay(road)) return
    checkpoint()
    if (!value) delete road.tags[key]
    else road.tags[key] = value
    dirty.value = true
    touchRoadOverlays()
    notify('Параметры пешеходной дорожки сохранены.')
  }
  /** Place traffic infrastructure on the selected ground way, sharing its
   * OSM node in the serialized graph (no free-floating signs). */
  function placeInfrastructure(at: RoadVertex, toleranceMetres = 10,
    screenTarget?: TargetLink, preferredRoadId?: string): void {
    if (!canEdit()) return
    // In 3D the map's lngLat is the ground coordinate beneath the cursor,
    // not necessarily the raised bridge deck. A screen-space lane target is
    // authoritative and already contains the exact OSM segment and fraction.
    let hit = null as ReturnType<typeof findRoadPlacement>
    if (screenTarget) {
      const targetRoad = roads.value.find(road => road.id === screenTarget.roadId)
      const validSegment = targetRoad && Number.isInteger(screenTarget.segmentIndex) &&
        screenTarget.segmentIndex >= 0 && screenTarget.segmentIndex < targetRoad.vertices.length - 1 &&
        Number.isFinite(screenTarget.t) && screenTarget.t >= 0 && screenTarget.t <= 1 &&
        isTrafficRoad(targetRoad)
      if (validSegment && targetRoad) {
        hit = { roadId: targetRoad.id, segmentIndex: screenTarget.segmentIndex,
          t: screenTarget.t, point: { ...screenTarget.vertex }, distance: 0 }
      }
    }
    if (!hit) hit = findRoadPlacement(at, roads.value, toleranceMetres, {
      preferredRoadId, roadWidthAware: true,
    })
    if (!hit) throw new Error('Наведите на дорожное полотно. Для широкой дороги можно нажать на любую полосу.')
    const road = roads.value.find(r => r.id === hit!.roadId)!
    // Avoid zero-length edges at an intersection node. Use an approach node
    // at least 1.5m inside this segment; stop lines can stay at exact bounds.
    const segmentA = road.vertices[hit.segmentIndex]!
    const segmentB = road.vertices[hit.segmentIndex + 1]!
    const segmentLength = distanceMetres(segmentA, segmentB)
    const minimum = 1.5 / Math.max(1, segmentLength)
    const adjustedT = Math.max(minimum, Math.min(1 - minimum, hit.t))
    const attachPoint = segmentLength > 3.2
      ? { ...hit.point, lng: segmentA.lng + (segmentB.lng - segmentA.lng) * adjustedT,
          lat: segmentA.lat + (segmentB.lat - segmentA.lat) * adjustedT }
      : null
    const relocating = infraRelocationId.value ? infrastructure.value.find(f => f.id === infraRelocationId.value) : null
    const kind = relocating?.kind ?? infraKind.value
    const allocate = () => allocateOsmId()
    if (infrastructure.value.some(f => (!relocating || f.id !== relocating.id) && f.element === 'node' &&
      f.vertices.some(v => distanceMetres(v, attachPoint ?? hit.point) < 1.3))) {
      throw new Error('В этой точке уже находится дорожный объект. Выберите его для редактирования.')
    }
    if (kind !== 'stop_line' && !attachPoint) throw new Error('Участок слишком короткий для установки отдельного OSM-узла.')
    const requestedDirection = relocating?.direction ?? (road.oneway && road.tags.oneway === '-1' ? 'backward' : 'forward')
    const allowed = allowedInfrastructureLanes(road, requestedDirection)
    if (!allowed.length) throw new Error('Для этой дороги нет полос выбранного направления.')
    const previous = relocating ? effectiveInfrastructureLanes(relocating, road) : []
    const lanes = previous.length ? previous : allowed
    if (kind === 'stop_line' && !contiguousLanes(lanes))
      throw new Error('Одна OSM-стоп-линия может проходить только по соседним полосам.')
    const roadWasImported = roadStatusById.value.get(road.id) === 'imported'
    checkpointInfrastructure(kind === 'stop_line' ? undefined : road.id)
    const direction = requestedDirection
    const osmTags = featureTags(kind, direction, relocating?.tags)
    osmTags['road_editor:road'] = road.osmId
    osmTags['road_editor:lanes'] = lanes.map(index => index + 1).join(',')
    let feature: InfrastructureFeature
    if (kind === 'stop_line') {
      const marking = stopLineLaneSegments(road, hit.segmentIndex, hit.point, lanes)[0]
      if (!marking) throw new Error('Не удалось построить стоп-линию по выбранным полосам.')
      const vertices = marking.map(point => ({ ...point, id: `osm-node-${allocate()}` }))
      const osmId = allocate()
      feature = { id: `infra-way-${osmId}`, osmId, element: 'way', kind,
        vertices, direction, tags: osmTags, roadOsmId: road.osmId, laneIndices: [...lanes] }
    } else {
      const osmId = allocate()
      const point = { ...attachPoint!, id: `osm-node-${osmId}` }
      road.vertices.splice(hit.segmentIndex + 1, 0, point)
      feature = { id: `infra-node-${osmId}`, osmId, element: 'node', kind,
        vertices: [{ ...point }], direction, tags: osmTags, roadOsmId: road.osmId, laneIndices: [...lanes] }
    }
    if (relocating) infrastructure.value = infrastructure.value.filter(f => f.id !== relocating.id)
    infrastructure.value.push(feature)
    selectedInfrastructureId.value = feature.id
    selectedId.value = null
    // Keep the placement tool active so several signs/lines can be placed in
    // one pass. Relocation is a one-shot action and returns to selection.
    if (relocating) tool.value = 'select'
    infraRelocationId.value = null
    dirty.value = true
    touchInfrastructure(kind !== 'stop_line' && roadWasImported, kind === 'crossing')
    notify('Дорожный объект добавлен и связан с OSM. Действие можно отменить через Ctrl+Z.')
  }
  function changeInfrastructureDirection(id: string, direction: TrafficDirection): void {
    if (!canEdit()) return
    const feature = infrastructure.value.find(f => f.id === id)
    if (!feature) return
    const placement = infrastructureRoadPlacement(feature, roads.value)
    const allowed = placement ? allowedInfrastructureLanes(placement.road, direction) : []
    if (placement && !allowed.length) throw new Error('У дороги нет полос выбранного направления.')
    const existing = feature.laneIndices?.filter(index => allowed.includes(index)) ?? []
    const laneIndices = placement ? (existing.length ? existing : allowed) : feature.laneIndices
    if (feature.kind === 'stop_line' && laneIndices && !contiguousLanes(laneIndices))
      throw new Error('Одна стоп-линия может занимать только соседние полосы.')
    checkpointInfrastructure()
    feature.direction = direction
    feature.laneIndices = laneIndices ? [...laneIndices] : undefined
    if (placement) feature.roadOsmId = placement.road.osmId
    feature.tags = featureTags(feature.kind, direction, feature.tags)
    if (feature.roadOsmId) feature.tags['road_editor:road'] = feature.roadOsmId
    if (laneIndices) feature.tags['road_editor:lanes'] = laneIndices.map(index => index + 1).join(',')
    if (feature.kind === 'stop_line' && placement && laneIndices?.length) {
      const center = placement.hit.point
      const segments = stopLineLaneSegments(placement.road, placement.hit.segmentIndex, center, laneIndices)
      if (segments.length === 1) feature.vertices = segments[0]!.map((point, index) =>
        ({ ...point, id: feature.vertices[index]?.id ?? point.id }))
    }
    dirty.value = true
    touchInfrastructure()
    notify('Направление действия и соответствующие полосы обновлены.')
  }
  function assignInfrastructureRoad(id: string, roadId: string): void {
    if (!canEdit()) return
    const feature = infrastructure.value.find(f => f.id === id)
    if (!feature) return
    const nearby = nearbyInfrastructureRoads(feature, roads.value)
    const selected = nearby.find(item => item.road.id === roadId)
    if (!selected) throw new Error('Дорога должна находиться рядом со знаком (до 15 м).')
    const lanes = allowedInfrastructureLanes(selected.road, feature.direction)
    if (!lanes.length) throw new Error('На этом участке нет полос выбранного направления.')
    checkpointInfrastructure()
    feature.roadOsmId = selected.road.osmId
    feature.laneIndices = [...lanes]
    feature.tags = { ...feature.tags, 'road_editor:road': selected.road.osmId,
      'road_editor:lanes': lanes.map(i => i + 1).join(',') }
    if (feature.kind === 'stop_line' && feature.element === 'way') {
      const segment = stopLineLaneSegments(selected.road, selected.hit.segmentIndex, selected.hit.point, lanes)[0]!
      feature.vertices = segment.map((point, index) => ({ ...point, id: feature.vertices[index]?.id ?? point.id }))
    }
    dirty.value = true
    touchInfrastructure(false, feature.kind === 'crossing')
    notify('Дорога для знака выбрана. Теперь укажите полосы галочками.')
  }
  function changeInfrastructureLanes(id: string, laneIndices: number[]): void {
    if (!canEdit()) return
    const feature = infrastructure.value.find(f => f.id === id)
    if (!feature) return
    const placement = infrastructureRoadPlacement(feature, roads.value)
    if (!placement) throw new Error('Не найдена дорога для знака. Переместите его на дорожный участок.')
    const allowed = allowedInfrastructureLanes(placement.road, feature.direction)
    const chosen = [...new Set(laneIndices)].sort((a, b) => a - b)
    if (!chosen.length || chosen.some(index => !allowed.includes(index)))
      throw new Error('Выберите хотя бы одну полосу указанного направления.')
    if (feature.kind === 'stop_line' && !contiguousLanes(chosen))
      throw new Error('Для одной OSM-стоп-линии выберите соседние полосы. Для раздельных участков создайте две линии.')
    checkpointInfrastructure()
    feature.laneIndices = chosen
    feature.roadOsmId = placement.road.osmId
    feature.tags = { ...feature.tags, 'road_editor:road': placement.road.osmId,
      'road_editor:lanes': chosen.map(index => index + 1).join(',') }
    if (feature.kind === 'stop_line') {
      const segment = stopLineLaneSegments(placement.road, placement.hit.segmentIndex, placement.hit.point, chosen)[0]!
      feature.vertices = segment.map((point, index) => ({ ...point, id: feature.vertices[index]?.id ?? point.id }))
    }
    dirty.value = true
    touchInfrastructure()
    notify(`Объект действует на полосы: ${chosen.map(index => index + 1).join(', ')}.`)
  }
  function toggleInfrastructureStopLine(id: string, enabled: boolean): void {
    if (!canEdit()) return
    const feature = infrastructure.value.find(f => f.id === id)
    if (!feature || feature.kind === 'stop_line' || feature.kind === 'crossing') return
    checkpointInfrastructure()
    feature.tags = { ...feature.tags, 'road_editor:stop_line': enabled ? 'yes' : 'no' }
    dirty.value = true
    touchInfrastructure()
    notify(enabled ? 'Стоп-линия показана на выбранных полосах.' : 'Автоматическая стоп-линия скрыта.')
  }
  function removeInfrastructure(id: string): void {
    if (!canEdit()) return
    const feature = infrastructure.value.find(f => f.id === id)
    if (!feature) return
    if (feature.element === 'way' && sourceXml.value) {
      const doc = new DOMParser().parseFromString(sourceXml.value, 'application/xml')
      if (Array.from(doc.querySelectorAll('relation member[type="way"]')).some(el => el.getAttribute('ref') === feature.osmId)) {
        throw new Error('Стоп-линия используется в OSM-отношении. Удаление требует правки отношения.')
      }
    }
    checkpointInfrastructure()
    infrastructure.value = infrastructure.value.filter(f => f.id !== id)
    if (selectedInfrastructureId.value === id) selectedInfrastructureId.value = null
    if (infraRelocationId.value === id) infraRelocationId.value = null
    dirty.value = true
    touchInfrastructure(false, feature.kind === 'crossing')
    notify('Объект дорожной инфраструктуры удалён.')
  }
  function beginInfrastructureRelocation(id: string): void {
    if (!canEdit()) return
    const f = infrastructure.value.find(item => item.id === id)
    if (!f) return
    infraRelocationId.value = id
    infraKind.value = f.kind
    tool.value = 'infrastructure'
    notify('Выберите новую точку на дороге. Esc — отмена переноса.')
  }
  function cancelInfrastructureRelocation(): void { infraRelocationId.value = null }

  /** Per-lane turn arrows are standard OSM turn:lanes tags and survive export. */
  function setLaneTurns(roadId: string, laneIndex: number, turns: LaneTurnToken[]): void {
    if (!canEdit()) return

    const road = roads.value.find(item => item.id === roadId)
    if (!road) throw new Error('Дорога не найдена.')
    const tags = withLaneTurnRules(road, laneIndex, turns)
    checkpoint()
    road.tags = tags
    dirty.value = true
    touchRoadOverlays()
    notify(`Полоса ${laneIndex + 1}: направления движения сохранены в OSM-тегах.`)
  }
  function addRoad(vertices: RoadFeature['vertices']): void {
    if (!canEdit()) return

    if (vertices.length < 2) return
    checkpoint()
    const usedIds = roads.value.map((road) => Number(road.osmId)).filter((value) => value < 0)
    const osmId = String(Math.min(0, ...usedIds) - 1)
    const road: RoadFeature = {
      id: crypto.randomUUID(), osmId, name: '', highway: 'residential', lanes: 2,
      oneway: false, bridge: false, level: 0, vertices, tags: {},
    }
    roads.value.push(road)
    selectedId.value = road.id
    tool.value = 'select'
    dirty.value = true
    touchRoads()
    notify(`Дорога создана (${vertices.length} узлов).`)
  }
  /** Atomically apply the confirmed edit: OSM graph junctions + levelled bridge spans. */
  function commitRoadPlan(plan: RoadPlan): void {
    if (!canEdit()) return

    const result = materializeRoadPlan(plan, roads.value, originalWayIds.value)
    checkpoint()
    const current = roads.value.map(road => {
      const vertices = result.modifiedExisting.get(road.id)
      return vertices ? { ...road, vertices } : road
    })
    roads.value = [...current, ...result.roads]
    reserveRoadIds(result.roads)
    selectedId.value = result.roads.find(road => road.bridge)?.id ?? result.roads[0]?.id ?? null
    tool.value = 'select'
    dirty.value = true
    touchRoads()
    const parts = [`Создано участков: ${result.roads.length}`]
    if (result.bridgeCount) parts.push(`мостов: ${result.bridgeCount}`)
    if (result.junctionCount) parts.push(`соединений: ${result.junctionCount}`)
    const elevatedEnd = plan.endpoints.find(link => current.some(road => road.id === link.roadId && road.level > 0))
    if (elevatedEnd) {
      const targetLevel = current.find(road => road.id === elevatedEnd.roadId)?.level ?? 0
      parts.push(`стыковка с мостом +${targetLevel}`)
    }
    notify(parts.join(' · '))
  }

  /** Single-click intersection planner, without altering sources until confirmation. */
  function prepareJunction(at: RoadVertex, nearbyRoads: RoadFeature[], toleranceMetres: number): JunctionPlan {
    return planJunction(at, nearbyRoads, toleranceMetres)
  }
  function commitJunction(plan: JunctionPlan, expectedRevision: number): void {
    if (!canEdit()) return
    if (geometryRevision.value !== expectedRevision) {
      throw new Error('Дороги изменились после предпросмотра. Выберите перекрёсток заново.')
    }
    const changed = new Map(plan.roads.map(item => [item.roadId, item.vertices]))
    if (!changed.size || !plan.roadIds.every(id => roads.value.some(road => road.id === id))) {
      throw new Error('Участки перекрёстка больше недоступны.')
    }
    checkpoint()
    roads.value = roads.value.map(road => {
      const vertices = changed.get(road.id)
      return vertices ? { ...road, vertices: vertices.map(v => ({ ...v })) } : road
    })
    selectedId.value = null
    selectedGraphLane.value = null
    tool.value = 'select'
    dirty.value = true
    touchRoads()
    notify(`Перекрёсток создан: ${plan.armCount} подхода, ${plan.roadIds.length} дорог.`)
  }

  /** Preview is immutable; commit replaces all related OSM ways in ONE history step. */
  function affectedRelationIds(roadIds: string[]): string[] {
    if (!sourceXml.value || !roadIds.length) return []
    const wayIds = new Set(roads.value.filter(road => roadIds.includes(road.id)).map(road => road.osmId))
    const doc = new DOMParser().parseFromString(sourceXml.value, 'application/xml')
    return Array.from(doc.getElementsByTagName('relation'))
      .filter(relation => Array.from(relation.getElementsByTagName('member'))
        .some(member => member.getAttribute('type') === 'way' && wayIds.has(member.getAttribute('ref') ?? '')))
      .map(relation => relation.getAttribute('id') ?? '')
      .filter(Boolean)
  }
  function prepareRoundabout(center: RoadVertex, radiusMetres: number): RoundaboutPlan {
    const plan = planRoundabout(center, radiusMetres, roads.value, originalWayIds.value)
    const danglingRelations = affectedRelationIds(plan.removedRoadIds)
    if (danglingRelations.length) {
      throw new Error(`Нельзя удалить внутренние OSM-участки: их используют отношения ${danglingRelations.slice(0, 3).join(', ')}. Уменьшите радиус.`)
    }
    return plan
  }
  /** The pen makes a traffic roundabout only at real junctions (at least three road arms). */
  function preparePenRoundabout(
    center: RoadVertex, axisPoint: RoadVertex, widthPoint: RoadVertex, circle: boolean,
  ): RoundaboutPlan | null {
    const plan = planPenEllipseRoundabout(center, axisPoint, widthPoint, circle, roads.value, originalWayIds.value)
    if (!plan) return null
    const danglingRelations = affectedRelationIds(plan.removedRoadIds)
    if (danglingRelations.length) {
      throw new Error(`Нельзя удалить внутренние OSM-участки: их используют отношения ${danglingRelations.slice(0, 3).join(', ')}. Уменьшите круг.`)
    }
    return plan
  }
  function commitRoundabout(plan: RoundaboutPlan): void {
    if (!canEdit()) return

    const relationCount = affectedRelationIds(plan.affectedRoadIds).length
    checkpoint()
    roads.value = plan.result
    reserveRoadIds(plan.result)
    selectedId.value = plan.result[plan.result.length - 1]?.id ?? null
    tool.value = 'select'
    dirty.value = true
    touchRoads()
    notify(`Круговое движение: ${plan.connectionCount} примыканий · ${plan.ellipse ? `овал ${Math.round(plan.ellipse.majorMetres * 2)} × ${Math.round(plan.ellipse.minorMetres * 2)} м` : `радиус ${Math.round(plan.radiusMetres)} м`}`)
    if (relationCount) notify(`Проверьте ${relationCount} OSM-отношений, содержащих изменённые дороги.`)
  }

  /** Split an existing ground road into an approach, a bridge and an exit. */
  function createBridgeOnRoad(roadId: string, fromMetres: number, toMetres: number): void {
    if (!canEdit()) return

    const road = roads.value.find(entry => entry.id === roadId)
    if (!road) throw new Error('Дорожный участок не найден.')
    if (affectedRelationIds([roadId]).length) throw new Error('Участок используется в OSM-отношении. Разделение требует обновления отношений; выберите другой участок.')
    const reserved = [...originalWayIds.value, ...roads.value.map(item => item.osmId)]
    const externalNodes = new Set(roads.value.filter(entry => entry.id !== roadId).flatMap(entry => entry.vertices.map(vertex => vertex.id)))
    const split = splitGroundRoadForBridge(road, fromMetres, toMetres, reserved, externalNodes)
    checkpoint()
    const index = roads.value.findIndex(entry => entry.id === roadId)
    roads.value.splice(index, 1, ...split.roadParts)
    reserveRoadIds(split.roadParts)
    selectedId.value = split.bridgeRoadId
    tool.value = 'select'
    dirty.value = true
    touchRoads()
    notify(`Мост создан: ${Math.round(toMetres - fromMetres)} м. Подъезды остаются наземными.`)
  }

  function patchRoad(id: string, patch: RoadPatch): void {
    if (!canEdit()) return

    const road = roads.value.find((entry) => entry.id === id)
    if (!road) return
    checkpoint()
    Object.assign(road, patch)
    if ('lanes' in patch) {
      road.lanes = clampRoadLanes(road.lanes)
      // Counts by direction from imported OSM must not contradict a new total.
      delete road.tags['lanes:forward']
      delete road.tags['lanes:backward']
    }
    if ('level' in patch) road.bridge = road.level > 0
    if ('bridge' in patch) road.level = road.bridge ? Math.max(1, road.level) : 0
    dirty.value = true
    touchRoads()
  }
  function removeRoad(id: string): void {
    if (!canEdit()) return

    if (!roads.value.some((road) => road.id === id)) return
    checkpoint()
    roads.value = roads.value.filter((road) => road.id !== id)
    if (selectedId.value === id) selectedId.value = null
    dirty.value = true
    touchRoads()
    notify('Дорога удалена из рабочей модели.')
  }
  function insertRoadVertex(roadId: string, segmentIndex: number, vertex: RoadVertex): void {
    if (!canEdit()) return

    const road = roads.value.find(item => item.id === roadId)
    if (!road || segmentIndex < 0 || segmentIndex >= road.vertices.length - 1) return
    checkpoint()
    road.vertices.splice(segmentIndex + 1, 0, { ...vertex })
    if (vertex.id.startsWith('osm-node-')) reservedOsmIds.add(vertex.id.slice('osm-node-'.length))
    dirty.value = true
    touchRoads()
    notify('Контрольная точка добавлена. Перетащите её для изменения линии.')
  }
  function startVertexDrag(): void {
    if (!canEdit()) return
 checkpoint() }
  function updateDraggedVertex(roadId: string, vertexId: string, lng: number, lat: number): string {
    if (!canEdit()) return vertexId

    const newId = updateSelectedDraggedVertex(roads.value, roadId, vertexId, lng, lat)
    dirty.value = true
    touchRoads()
    return newId
  }
  function updateVertex(vertexId: string, lng: number, lat: number): void {
    if (!canEdit()) return

    for (const road of roads.value) {
      for (const vertex of road.vertices) {
        if (vertex.id === vertexId) { vertex.lng = lng; vertex.lat = lat }
      }
    }
    dirty.value = true
    touchRoads()
  }


function disconnectVertex(
  roadId: string,
  vertexId: string,
): void {
    if (!canEdit()) return

  const updated = disconnectRoadVertex(
    roads.value,
    roadId,
    vertexId,
  )

  if (!updated) return

  checkpoint()

  roads.value = updated
  dirty.value = true
  touchRoads()

  notify(
    'Соединение разорвано. Вершину можно перемещать отдельно.'
  )
}

  /** One checkpoint per move; neighbouring OSM roads remain in place. */
  function moveRoadExact(roadId: string, east: number, north: number): void {
    if (!canEdit()) return

    const road = roads.value.find(item => item.id === roadId)
    if (!road) return
    if (Math.hypot(east, north) < 0.00001) return
    const isolated = isolatedMoveVertices(roads.value, roadId)
    if (!isolated) return
    const moved = shiftVertices(isolated, east, north)
    checkpoint()
    road.vertices = moved
    dirty.value = true
    touchRoads()
    notify(`Объект перемещён: восток ${east.toFixed(2)} м, север ${north.toFixed(2)} м.`)
  }

  /** Drag gesture: detach only once and remember geometry from its initial position. */
  function startRoadDrag(roadId: string): RoadVertex[] | null {
    if (!canEdit()) return null

    const road = roads.value.find(item => item.id === roadId)
    if (!road) return null
    const isolated = isolatedMoveVertices(roads.value, roadId)
    if (!isolated) return null
    checkpoint()
    road.vertices = isolated
    dirty.value = true
    touchRoads()
    return isolated.map(vertex => ({ ...vertex }))
  }

  /** Absolute, not incremental, drag displacement: no accumulated precision drift. */
  function updateRoadDrag(
    roadId: string, originalVertices: readonly RoadVertex[],
    east: number, north: number,
  ): void {
    if (!canEdit()) return

    const road = roads.value.find(item => item.id === roadId)
    if (!road) return
    road.vertices = shiftVertices(originalVertices, east, north)
    dirty.value = true
    touchRoads()
  }

  function importFile(xml: string, filename: string): void {
    const project = importOsm(xml, filename)
    roads.value = project.roads
    infrastructure.value = readInfrastructure(project.xml)
    sceneBarriers.value = readSceneBarriers(project.xml)
    originalInfrastructure.value = copyInfrastructure(infrastructure.value)
    selectedInfrastructureId.value = null
    infraRelocationId.value = null
    selectedId.value = null
    selectedGraphLane.value = null
    moveObjectMode.value = false
    sourceXml.value = project.xml
    rebuildReservedOsmIds(project.xml)
    originalRoadIds.value = project.roads.map((road) => road.osmId)
    originalWayIds.value = project.allWayIds
    baselineRoads.value = copyRoads(project.roads)
    projectName.value = project.name
    importedCounts.value = { nodes: project.allNodeCount, ways: project.allWayCount, relations: project.relationCount }
    history.value = []
    future.value = []
    tool.value = 'select'
    dirty.value = false
    roadAnalysis.value = null
    roadAnalysisStale.value = false
    roadAnalysisVisible.value = false
    roadAnalysisRevision.value++
    touchRoads()
    notifications.value = [`Импортировано ${project.roads.length} дорог.`, ...project.warnings].slice(0, 40)
  }
  /** Current working XML, including unexported edits, for server persistence. */
  function workspaceXml(): string {
    const roadsXml = exportOsm(sourceXml.value, roads.value, originalRoadIds.value, baselineRoads.value)
    return writeInfrastructure(roadsXml, infrastructure.value, originalInfrastructure.value)
  }
  /** Prepare one OSM file for the existing MATSim → SUMO → Webots converter. */
  function prepareSimulationExport(): { xml: string; report: SimulatorExportReport } {
    const xml = workspaceXml()
    return { xml, report: inspectSimulatorOsm(xml, sourceXml.value) }
  }
  function exportFile(): void {
    const xml = workspaceXml()
    downloadOsm(xml)
    dirty.value = false
    notify('Файл edited.osm сформирован.')
  }


function attachDraggedEndpoint(
  vertexId: string,
  link: TargetLink
): void {
    if (!canEdit()) return

  const target = roads.value.find(
    road => road.id === link.roadId
  )

  const level = target?.level ?? 0

  roads.value = reconnectDraggedEndpoint(
    roads.value,
    vertexId,
    link
  )

  dirty.value = true
  touchRoads()

  notify(
    level > 0
      ? `Соединено с мостом +${level}.`
      : 'Соединено с наземной дорогой.'
  )
}


  return {
    roads, networkMode, setNetworkMode, motorRoadCount, walkWayCount, addPedestrianWay, setRoadMarking, setPedestrianAttribute, setWebotsTag, sceneBarriers, infrastructure, selectedInfrastructureId, selectedInfrastructure, infraKind, infraRelocationId,
    readOnly, geometryRevision, roadRenderRevision, roadOverlayRevision, infrastructureRevision, roadStatusRevision, crosswalkRevision,
    roadAnalysis, roadAnalysisStale, roadAnalysisVisible, roadAnalysisRevision, runRoadAnalysis, clearRoadAnalysis,
    selectedId, selectedRoad, selectedGraphLane, graphView, tool, penMode, moveObjectMode, mode, projectName, importedCounts,
    notifications, dirty, history, future, bridgeCount, roadStatusById, roadStatusCounts, notify, selectRoad, selectGraphLane, setInfrastructureTool,
    selectInfrastructure, placeInfrastructure, changeInfrastructureDirection, assignInfrastructureRoad, changeInfrastructureLanes, toggleInfrastructureStopLine, removeInfrastructure,
    beginInfrastructureRelocation, cancelInfrastructureRelocation, setLaneTurns, setTool,
    undo, redo, addRoad, commitRoadPlan, prepareJunction, commitJunction, prepareRoundabout, preparePenRoundabout, commitRoundabout, createBridgeOnRoad, patchRoad, removeRoad, startVertexDrag, updateVertex,
    importFile, exportFile, workspaceXml, prepareSimulationExport, attachDraggedEndpoint, disconnectVertex, updateDraggedVertex, insertRoadVertex,
    moveRoadExact, startRoadDrag, updateRoadDrag,
  }
})
