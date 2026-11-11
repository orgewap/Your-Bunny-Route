<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Map, NavigationControl, ScaleControl, GeoJSONSource, setWorkerUrl } from 'maplibre-gl'
import type { MapMouseEvent, MapLayerMouseEvent } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { useEditorStore } from '../stores/editor'
import { appendFreehandSample, previewPen, samplePenCurve, samplePenEllipse, simplifyFreehandSamples } from '../lib/pen'
import type { FreehandSample } from '../lib/pen'
import { RoadMeshLayer } from '../lib/roadMesh'
import { SATELLITE_ATTRIBUTION, SATELLITE_LAYER_ID, SATELLITE_SOURCE_ID, DEFAULT_SATELLITE_TILES, satelliteVisibility } from '../lib/basemaps'
import type { BasemapKind } from '../lib/basemaps'
import { distanceMetres, planRoad, snapToRoad, previewBridgeSpans } from '../lib/topology'
import { snapElevatedAtScreen } from '../lib/screenSnap'
import { cursorOffsetMetres } from '../lib/translate'
import { shouldCaptureMoveTab, canBeginObjectMove } from '../lib/moveShortcut'
import { laneVisualFeatures, LANE_WIDTH_METRES } from '../lib/lanes'
import { roadStatusEdges, ROAD_STATUS_COLORS } from '../lib/roadStatus'
import { surfaceNetwork } from '../lib/roadSurface'
import { buildLaneGraph } from '../lib/laneGraph'
import { indexRoadBounds, expandBounds, roadsWithin } from '../lib/viewport'
import type { RoadBounds } from '../lib/viewport'
import type { LaneGraph } from '../lib/laneGraph'
import { snapToLaneAtScreen } from '../lib/laneSnap'
import type { CrossingKind, RoadPlan, TargetLink } from '../lib/topology'
import { previewCircle, MIN_ROUNDABOUT_RADIUS, MAX_ROUNDABOUT_RADIUS } from '../lib/roundabout'
import type { RoundaboutPlan } from '../lib/roundabout'
import type { JunctionPlan } from '../lib/junction'
import type { RoadVertex } from '../types/road'
import { findRoadPlacement, infrastructureIconLocation, infrastructureMarkings, createInfrastructurePlacementIndex } from '../lib/infrastructure'
import type { InfrastructurePlacementIndex } from '../lib/infrastructure'
import { registerTrafficIcons } from '../lib/trafficIcons'
import { buildPedestrianGraph, pedestrianRoute, closestWalkNode, pedestrianVisualFeatures,
  isPedestrianWay, motorRoads, pedestrianWays, findPedestrianSnap, pedestrianSurfaceFeatures, pedestrianPortalFeatures } from '../lib/pedestrian'
import type { WalkGraph } from '../lib/pedestrian'
import { roadMarkingFeatures, turnArrowFeatures } from '../lib/roadMarkings'
import { roadMarkingSections } from '../lib/junctionMarkings'
import { crosswalkStripeFeatures } from '../lib/crosswalks'
import { mercatorPixelsPerMetre, METRIC_RENDER_ZOOM_STOPS } from '../lib/mapScale'
import { graphVisibility, isBackgroundTransportLine, applyNetworkLayerVisibility, networkSourceVisible, basemapTransportVisibility } from '../lib/networkLayers'
import type { NetworkMode } from '../lib/networkLayers'
import 'maplibre-gl/dist/maplibre-gl.css'


setWorkerUrl(workerUrl)
const store = useEditorStore()
const mapRoot = ref<HTMLElement | null>(null)
const draftPoints = ref<RoadVertex[]>([])
const cursor = ref<RoadVertex | null>(null)
const snapIndicator = ref<RoadVertex | null>(null)
const laneHoverLabel = ref('')
const pendingPlan = ref<RoadPlan | null>(null)
const planError = ref('')
const roundaboutCenter = ref<RoadVertex | null>(null)
const pendingRoundabout = ref<RoundaboutPlan | null>(null)
const pendingJunction = ref<JunctionPlan | null>(null)
const junctionError = ref('')
let junctionRevision = 0
const roundaboutError = ref('')
const draftSnapLinks = ref<[TargetLink | null, TargetLink | null]>([null, null])
const penCircle = ref(false)
let freehandSamples: FreehandSample[] = []
let freehandDistancePx = 0
let map: Map | null = null
const roadMesh = new RoadMeshLayer()
let dragId: string | null = null
let dragRoadId: string | null = null
let dragged = false
let dragIsEndpoint = false
let dragSnap: TargetLink | null = null
let lastDragRaw: RoadVertex | null = null
type ObjectDrag = {
  roadId: string
  startLng: number
  startLat: number
  startX: number
  startY: number
  original: RoadVertex[] | null
  lastEast: number
  lastNorth: number
  temporary: boolean
  frozen: boolean
}
let objectDrag: ObjectDrag | null = null
const tabMoveHeld = ref(false)
let pointerInsideMap = false
let suppressMoveClick = false
let sizeObserver: ResizeObserver | null = null
let laneGraph: LaneGraph = { edges: [], nodes: [], connections: [], junctionCount: 0 }
let surfaceCache: typeof store.roads = []
let borderSurfaceCache: typeof store.roads = []
let visibleMarkingSections = new globalThis.Map<string, RoadVertex[][]>()
let indexedRoads: RoadBounds[] = []
let indexedAllRoads: RoadBounds[] = []
let visibleRoads: typeof store.roads = []
let visibleAllRoads: typeof store.roads = []
let infrastructurePlacementIndex: InfrastructurePlacementIndex = createInfrastructurePlacementIndex([])
let visibleSurfaces: typeof store.roads = []
let visibleBorderSurfaces: typeof store.roads = []
let lastRoadRenderRevision = -1
let lastRoadOverlayRevision = -1
let lastInfrastructureRevision = -1
let lastRoadStatusRevision = -1
let lastAnalysisRevision = -1
let lastAnalysisMode = ''
let lastAnalysisVisible = false
let lastCrosswalkRevision = -1
let lastViewportKey = ''
// Keep a generous buffer around the last rendered viewport. Minor pans
// should not serialize the road mesh and thousands of GeoJSON features again.
let cachedViewport: { west: number; east: number; south: number; north: number } | null = null
let viewportEpoch = 0
let lastSelectionId: string | null = null
let lastInfraSelectionId: string | null = null
let lastViewMode = ''
let lastGraphEnabled = false
let lastGraphFocus = ''
let lastHandleKey = ''
let lastMeshRoadKey = ''
let lastMeshStatusKey = ''
let lastMeshRoadFurnitureKey = ''
let lastMeshInfrastructureKey = ''
let lastMeshPedestrianKey = ''
let lastNetworkMode = ''
// Liberty has its own vector transportation layers. If these are left on,
// the pedestrian network stays drawn in Auto mode (and roads appear in Walk).
// Hide only BASEMAP transportation geometry while an editable OSM is loaded;
// the chosen editor graph becomes the sole visible source of roads/paths.
const backgroundTransportLines = new globalThis.Map<string, 'visible' | 'none'>()
function syncBackgroundTransportation(): void {
  if (!map) return
  for (const [id, original] of backgroundTransportLines) {
    if (!map.getLayer(id)) continue
    const target = basemapTransportVisibility(store.roads.length > 0, original)
    if ((map.getLayoutProperty(id, 'visibility') ?? 'visible') !== target) {
      map.setLayoutProperty(id, 'visibility', target)
    }
  }
}

let walkGraph: WalkGraph = buildPedestrianGraph([])
let crosswalkCache: ReturnType<typeof crosswalkStripeFeatures> = []
let pedestrianPortalCache: ReturnType<typeof pedestrianPortalFeatures> = []
let visibleRoadMarkings: ReturnType<typeof roadMarkingFeatures> = []
let visibleTurnArrows: ReturnType<typeof turnArrowFeatures> = []
const walkStart = ref<string | null>(null)
const walkEnd = ref<string | null>(null)
const walkResult = ref<{ metres: number; reachable: boolean } | null>(null)
let previewFrame = 0
let drawFrame = 0
let drawTimer: number | null = null
let lastDrawAt = 0
let lastPenPointerAt = 0
let lastPreviewPlan: RoadPlan | null = null
let lastPreviewRoundabout: RoundaboutPlan | null = null
let lastPreviewJunction: JunctionPlan | null = null
let lastPreviewCentre: RoadVertex | null = null
let previewWasVisible = false
let snapWasVisible = false

const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty'
// This mode only affects map imagery. Editor roads, junctions, 3D meshes,
// traffic signs and OSM export stay in the same map/style.
const basemapMode = ref<BasemapKind>('map')
const satelliteTiles = import.meta.env.VITE_SATELLITE_TILE_URL?.trim() || DEFAULT_SATELLITE_TILES
const satelliteAttribution = import.meta.env.VITE_SATELLITE_ATTRIBUTION?.trim() || SATELLITE_ATTRIBUTION

function setBasemap(mode: BasemapKind): void {
  basemapMode.value = mode
  if (map?.getLayer(SATELLITE_LAYER_ID)) {
    map.setLayoutProperty(SATELLITE_LAYER_ID, 'visibility', satelliteVisibility(mode))
  }
}


function emptyCollection() { return { type: 'FeatureCollection' as const, features: [] } }
function infrastructurePointsCollection() {
  return { type: 'FeatureCollection' as const,
    features: store.infrastructure.filter(feature => {
      if (feature.element !== 'node' || feature.kind === 'stop_line') return false
      if (store.networkMode === 'all') return true
      if (store.networkMode === 'pedestrian') return feature.kind === 'crossing' ||
        (feature.kind === 'traffic_signal' && (feature.tags.crossing || feature.tags['traffic_signals:direction'] === 'pedestrian'))
      return feature.kind !== 'crossing'
    }).map(feature => {
      const at = infrastructureIconLocation(feature, store.roads, infrastructurePlacementIndex) ?? feature.vertices[0]!
      return {
        type: 'Feature' as const, id: feature.id,
        properties: { infraId: feature.id, kind: feature.kind,
          selected: feature.id === store.selectedInfrastructureId,
          icon: `editor-infra-${feature.kind}` },
        geometry: { type: 'Point' as const, coordinates: [at.lng, at.lat] },
      }
    }) }
}
function infrastructureLinesCollection() {
  const byId = new globalThis.Map(store.infrastructure.map(feature => [feature.id, feature]))
  return { type: 'FeatureCollection' as const,
    features: infrastructureMarkings(store.infrastructure, store.roads, store.selectedInfrastructureId, infrastructurePlacementIndex)
      .filter(line => {
        if (store.networkMode === 'all') return true
        const feature = byId.get(line.infraId)
        return store.networkMode === 'motor' ? feature?.kind !== 'crossing' : feature?.kind === 'crossing'
      })
      .map((line, index) => ({
        type: 'Feature' as const, id: `marking-${index}`,
        properties: { infraId: line.infraId, selected: line.selected,
          latitudeFactor: 1 / Math.max(0.02, Math.cos((line.coordinates[0]?.[1] ?? 0) * Math.PI / 180)) },
        geometry: { type: 'LineString' as const, coordinates: line.coordinates },
      })) }
}


function pedestrianEdgesCollection() {
  return { type: 'FeatureCollection' as const, features: pedestrianVisualFeatures(visibleAllRoads, store.selectedId) }
}
function pedestrianSurfacesCollection() {
  return { type: 'FeatureCollection' as const, features: pedestrianSurfaceFeatures(visibleAllRoads) }
}
function pedestrianPortalsCollection() {
  const bounds = cachedViewport
  const features = pedestrianPortalCache.filter(feature => {
    const [lng, lat] = feature.geometry.coordinates
    return !bounds || lng >= bounds.west && lng <= bounds.east && lat >= bounds.south && lat <= bounds.north
  })
  return { type: 'FeatureCollection' as const, features }
}
function pedestrianNodesCollection() {
  return { type: 'FeatureCollection' as const,
    features: [...walkGraph.junctions].flatMap(id => {
      const point = walkGraph.points.get(id)
      if (!point || cachedViewport && (point.lng < cachedViewport.west || point.lng > cachedViewport.east ||
          point.lat < cachedViewport.south || point.lat > cachedViewport.north)) return []
      return [{ type: 'Feature' as const, properties: { nodeId: id },
        geometry: { type: 'Point' as const, coordinates: [point.lng, point.lat] } }]
    }) }
}
function pedestrianRouteCollection() {
  const path = walkStart.value && walkEnd.value
    ? pedestrianRoute(walkGraph, walkStart.value, walkEnd.value) : null
  walkResult.value = walkStart.value && walkEnd.value
    ? { metres: path?.metres ?? 0, reachable: !!path } : null
  return { type: 'FeatureCollection' as const, features: path ? [{ type: 'Feature' as const,
    properties: {}, geometry: { type: 'LineString' as const,
      coordinates: path.vertices.map(v => [v.lng, v.lat]) },
  }] : [] }
}
function roadMarkingsCollection() {
  return { type: 'FeatureCollection' as const, features: visibleRoadMarkings }
}
function turnArrowsCollection() {
  return { type: 'FeatureCollection' as const, features: visibleTurnArrows }
}
function crosswalksCollection() {
  // Tags absent from OSM are NOT turned into painted crossings. Keep the
  // GeoJSON source local to the buffered viewport on large city extracts.
  const bounds = cachedViewport
  const features = bounds ? crosswalkCache.filter(feature => {
    const ring = feature.geometry.coordinates[0] ?? []
    return ring.some(point => point[0]! >= bounds.west && point[0]! <= bounds.east &&
      point[1]! >= bounds.south && point[1]! <= bounds.north)
  }) : crosswalkCache
  return { type: 'FeatureCollection' as const, features }
}
function roadCollection() {
  return {
    type: 'FeatureCollection' as const,
    features: (store.networkMode === 'pedestrian' ? [] : visibleSurfaces.filter(road => road.vertices.length >= 2)).map(road => ({
      type: 'Feature' as const,
      properties: { roadId: road.id, status: store.roadStatusById.get(road.id) ?? 'imported', selected: road.id === store.selectedId, level: road.level, bridge: road.bridge, name: road.name, lanes: road.lanes, latitudeFactor: 1 / Math.max(0.02, Math.cos(road.vertices[0]!.lat * Math.PI / 180)) },
      geometry: { type: 'LineString' as const, coordinates: road.vertices.map(vertex => [vertex.lng, vertex.lat]) },
    })),
  }
}


function editAxisCollection() {
  const road = store.graphView ? null : store.selectedRoad
  const visibleRoad = road
    ? (isPedestrianWay(road) ? road : surfaceCache.find(item => item.id === road.id))
    : null

  return {
    type: 'FeatureCollection' as const,
    features: road && road.vertices.length > 1 ? [{
      type: 'Feature' as const,
      properties: { roadId: road.id },
      geometry: {
        type: 'LineString' as const,
        coordinates: (visibleRoad?.vertices ?? road.vertices)
          .map(vertex => [vertex.lng, vertex.lat]),
      },
    }] : [],
  }
}


function lanesCollection() {
  return { type: 'FeatureCollection' as const, features: store.networkMode === 'pedestrian' ? [] : laneVisualFeatures(visibleSurfaces, store.selectedId) }
}
function laneBordersCollection() {
  // Asphalt remains continuous, but lane seams end at each actual OSM junction.
  return { type: 'FeatureCollection' as const, features: store.networkMode === 'pedestrian' ? [] : laneVisualFeatures(visibleBorderSurfaces, store.selectedId) }
}
function roadStatusCollection() {
  return { type: 'FeatureCollection' as const,
    features: store.networkMode === 'pedestrian' ? [] : roadStatusEdges(visibleSurfaces, store.roadStatusById, visibleMarkingSections) }
}

function analysisIssuesCollection() {
  const analysis = store.roadAnalysis
  if (!analysis || store.roadAnalysisStale || !store.roadAnalysisVisible ||
      store.networkMode === 'pedestrian' || store.mode !== '2d') return emptyCollection()
  const roadFeatures = visibleRoads.flatMap(road => {
    const severity = analysis.severityByRoadId[road.id]
    if (!severity || road.vertices.length < 2) return []
    return [{ type: 'Feature' as const,
      properties: { roadId: road.id, severity },
      geometry: { type: 'LineString' as const,
        coordinates: road.vertices.map(vertex => [vertex.lng, vertex.lat]) },
    }]
  })
  const gapFeatures = analysis.gaps.map(gap => ({
    type: 'Feature' as const,
    properties: { issueId: gap.id, severity: gap.severity, role: 'near-connection-gap' },
    geometry: { type: 'LineString' as const, coordinates: gap.coordinates },
  }))
  const markerFeatures = analysis.markers.map(marker => ({
    type: 'Feature' as const,
    properties: { markerId: marker.id, severity: marker.severity, role: marker.role },
    geometry: { type: 'Point' as const, coordinates: marker.coordinates },
  }))
  return { type: 'FeatureCollection' as const, features: [...roadFeatures, ...gapFeatures, ...markerFeatures] }
}

/** Graph mode: editable way -> independent per-lane display graph. */
function graphEdgesCollection() {
  const focus = store.selectedGraphLane
  return { type: 'FeatureCollection' as const, features: laneGraph.edges.map(lane => ({
    type: 'Feature' as const,
    properties: { roadId: lane.roadId, laneIndex: lane.laneIndex,
      count: lane.count, flow: lane.flow,
      selected: lane.roadId === store.selectedId,
      focus: !!focus && lane.roadId === focus.roadId && lane.laneIndex === focus.laneIndex },
    geometry: { type: 'LineString' as const,
      coordinates: lane.coordinates.map(point => [point.lng, point.lat]) },
  })) }
}
function graphNodesCollection() {
  const focus = store.selectedGraphLane
  return { type: 'FeatureCollection' as const, features: laneGraph.nodes.map(node => ({
    type: 'Feature' as const,
    properties: { roadId: node.roadId, laneIndex: node.laneIndex,
      nodeId: node.nodeId, junction: node.junction,
      selected: !!focus && node.roadId === focus.roadId && node.laneIndex === focus.laneIndex },
    geometry: { type: 'Point' as const, coordinates: [node.point.lng, node.point.lat] },
  })) }
}

function graphConnectionsCollection() {
  const focus = store.selectedGraphLane

  const connections = focus
    ? laneGraph.connections.filter(link =>
        link.fromRoad === focus.roadId &&
        link.fromLane === focus.laneIndex
      )
    : []

  return {
    type: 'FeatureCollection' as const,
    features: connections.map(link => ({
      type: 'Feature' as const,
      properties: {
        fromRoad: link.fromRoad,
        fromLane: link.fromLane,
        toRoad: link.toRoad,
        toLane: link.toLane,
        turn: link.turn,
        selected: true,
      },
      geometry: {
        type: 'LineString' as const,
        coordinates: link.coordinates.map(point => [
          point.lng,
          point.lat,
        ]),
      },
    })),
  }
}


function bridgeEndsCollection() {
  const road = store.selectedRoad
  return {
    type: 'FeatureCollection' as const,
    features: road?.bridge && road.vertices.length >= 2 ? [
      { type: 'Feature' as const, properties: { vertexId: road.vertices[0]!.id, label: 'Начало моста' }, geometry: { type: 'Point' as const, coordinates: [road.vertices[0]!.lng, road.vertices[0]!.lat] } },
      { type: 'Feature' as const, properties: { vertexId: road.vertices[road.vertices.length - 1]!.id, label: 'Конец моста' }, geometry: { type: 'Point' as const, coordinates: [road.vertices[road.vertices.length - 1]!.lng, road.vertices[road.vertices.length - 1]!.lat] } },
    ] : [],
  }
}

function previewBridgeEndsCollection() {
  const spans = pendingPlan.value ? previewBridgeSpans(pendingPlan.value) : []
  return {
    type: 'FeatureCollection' as const,
    features: spans.flatMap(points => points.length >= 2 ? [
      { type: 'Feature' as const, properties: { label: 'Начало моста' }, geometry: { type: 'Point' as const, coordinates: [points[0]!.lng, points[0]!.lat] } },
      { type: 'Feature' as const, properties: { label: 'Конец моста' }, geometry: { type: 'Point' as const, coordinates: [points[points.length - 1]!.lng, points[points.length - 1]!.lat] } },
    ] : []),
  }
}

function handlesCollection() {
  const road = store.selectedRoad
  return {
    type: 'FeatureCollection' as const,
    features: road && !store.graphView && !store.moveObjectMode && !tabMoveHeld.value ? road.vertices.map((vertex, index) => ({
      type: 'Feature' as const,
      properties: { vertexId: vertex.id, index },
      geometry: { type: 'Point' as const, coordinates: [vertex.lng, vertex.lat] },
    })) : [],
  }
}

function previewCollection() {
  const points = pendingPlan.value?.path ?? [...draftPoints.value, ...(cursor.value ? [cursor.value] : [])]
  const line = pendingPlan.value ? points
    : store.tool === 'pen' ? previewPen(store.penMode, draftPoints.value, cursor.value, penCircle.value)
    : points
  return {
    type: 'FeatureCollection' as const,
    features: line.length > 1 ? [{
      type: 'Feature' as const,
      properties: {},
      geometry: { type: 'LineString' as const, coordinates: line.map(point => [point.lng, point.lat]) },
    }] : [],
  }
}

function bridgePreviewCollection() {
  return {
    type: 'FeatureCollection' as const,
    features: pendingPlan.value ? previewBridgeSpans(pendingPlan.value).map(points => ({
      type: 'Feature' as const,
      properties: {},
      geometry: { type: 'LineString' as const, coordinates: points.map(point => [point.lng, point.lat]) },
    })) : [],
  }
}

function crossingCollection() {
  return {
    type: 'FeatureCollection' as const,
    features: pendingPlan.value?.crossings.map(crossing => ({
      type: 'Feature' as const,
      properties: { kind: crossing.kind, level: crossing.bridgeLevel },
      geometry: { type: 'Point' as const, coordinates: [crossing.vertex.lng, crossing.vertex.lat] },
    })) ?? [],
  }
}

function roundaboutPreviewCollection() {
  const points = pendingRoundabout.value?.ring ?? (roundaboutCenter.value
    ? previewCircle(roundaboutCenter.value, cursor.value ? distanceMetres(roundaboutCenter.value, cursor.value) : 18)
    : [])
  return {
    type: 'FeatureCollection' as const,
    features: points.length > 2 ? [{
      type: 'Feature' as const, properties: {},
      geometry: { type: 'LineString' as const, coordinates: points.map(point => [point.lng, point.lat]) },
    }] : [],
  }
}
function roundaboutConnectionsCollection() {
  return {
    type: 'FeatureCollection' as const,
    features: pendingRoundabout.value?.attachmentVertices.map(vertex => ({
      type: 'Feature' as const, properties: {},
      geometry: { type: 'Point' as const, coordinates: [vertex.lng, vertex.lat] },
    })) ?? [],
  }
}

function junctionPreviewCollection() {
  const plan = pendingJunction.value
  return { type: 'FeatureCollection' as const, features: plan ? [{
    type: 'Feature' as const, properties: { armCount: plan.armCount },
    geometry: { type: 'Point' as const, coordinates: [plan.vertex.lng, plan.vertex.lat] },
  }] : [] }
}
function junctionArmsCollection() {
  return { type: 'FeatureCollection' as const,
    features: pendingJunction.value?.armSegments.map(([a, b]) => ({
      type: 'Feature' as const, properties: {},
      geometry: { type: 'LineString' as const, coordinates: [[a.lng, a.lat], [b.lng, b.lat]] },
    })) ?? [],
  }
}

function snapCollection() {
  return {
    type: 'FeatureCollection' as const,
    features: snapIndicator.value ? [{
      type: 'Feature' as const,
      properties: {},
      geometry: { type: 'Point' as const, coordinates: [snapIndicator.value.lng, snapIndicator.value.lat] },
    }] : [],
  }
}

function currentSnapTolerance(): number {
  if (!map) return 8
  const center = map.getCenter()
  const point = map.project(center)
  const other = map.unproject([point.x + 12, point.y])
  return Math.min(18, Math.max(1.5, distanceMetres({ id: '', lng: center.lng, lat: center.lat }, { id: '', lng: other.lng, lat: other.lat })))
}

function pointerVertex(lng: number, lat: number): RoadVertex {
  return { id: crypto.randomUUID(), lng, lat }
}

function elevatedScreenTarget(e: MapMouseEvent, roads: typeof store.roads): TargetLink | null {
  if (store.mode !== '3d' || e.originalEvent.shiftKey) return null
  return snapElevatedAtScreen(
    e.point, roads,
    (lng, lat, height) => roadMesh.projectToScreen(lng, lat, height),
    18,
  )
}

function laneTargetAtPointer(e: MapMouseEvent, roads: typeof store.roads,
  preferredLevel?: number | null): TargetLink | null {
  if (!map) return null
  // The road geometry uses ONE OSM way, but all rendered lane centres and
  // boundaries may be picked. Keep the chosen lane in the TargetLink.
  const base = visibleRoads.length ? (roads === store.roads
    ? visibleRoads
    : (() => { const ids = new Set(roads.map(road => road.id)); return visibleRoads.filter(road => ids.has(road.id)) })())
    : roads
  const visible = e.originalEvent.shiftKey
    ? base.filter(road => road.level === 0)
    : base
  const result = snapToLaneAtScreen(
    e.point, visible,
    (lng, lat, height) => {
      if (!map) return null
      if (store.mode === '3d') {
        const deckPoint = roadMesh.projectToScreen(lng, lat, height)
        if (deckPoint) return deckPoint
      }
      const point = map.project({ lng, lat })
      return { x: point.x, y: point.y }
    },
    map.getZoom(), store.mode, 17,
    preferredLevel === undefined ? (e.originalEvent.shiftKey ? 0 : null) : preferredLevel,
  )
  return result?.link ?? null
}

function snappingCandidate(
  lng: number,
  lat: number,
  ignoreSnap = false,
  e?: MapMouseEvent,
): { vertex: RoadVertex; snapped: boolean; link: TargetLink | null } {
  if (ignoreSnap) return { vertex: pointerVertex(lng, lat), snapped: false, link: null }

  const laneLink = e ? laneTargetAtPointer(e, store.roads) : null
  if (laneLink) {
    return {
      vertex: laneLink.laneAttachment?.visibleVertex ?? laneLink.vertex,
      snapped: true,
      link: laneLink,
    }
  }
  // In pitched 3D maps e.lngLat refers to GROUND, not the bridge deck.
  const candidates = visibleRoads.length ? visibleRoads : motorRoads(store.roads)
  const screenLink = e ? elevatedScreenTarget(e, candidates) : null
  // A missed pixel-level stripe must NOT turn off snapping altogether.
  // Use the centreline only after a visible lane/edge has failed to match.
  // Ground lngLat is not sufficient for a raised deck in 3D.
  if (!screenLink && e && store.mode === '3d') {
    return { vertex: pointerVertex(lng, lat), snapped: false, link: null }
  }
  const result = screenLink
    ? { vertex: screenLink.vertex, link: screenLink }
    : snapToRoad(
        pointerVertex(lng, lat),
        candidates,
        currentSnapTolerance(),
        null,
        e?.originalEvent.shiftKey ? 0 : null,
      )
  return { vertex: result.vertex, snapped: !!result.link, link: result.link }
}

function penCandidate(lng: number, lat: number, noSnap: boolean, event?: MapMouseEvent):
  { vertex: RoadVertex; snapped: boolean; link: TargetLink | null } {
  if (store.networkMode !== 'pedestrian') return snappingCandidate(lng, lat, noSnap, event)
  const raw = pointerVertex(lng, lat)
  const hit = noSnap ? null : findPedestrianSnap(raw, store.roads, currentSnapTolerance())
  return hit
    ? { vertex: { ...hit.vertex }, snapped: true, link: { roadId: hit.roadId,
        segmentIndex: hit.segmentIndex, t: hit.t, vertex: hit.vertex } }
    : { vertex: raw, snapped: false, link: null }
}

function draggedEndpointSnap(raw: RoadVertex, e: MapMouseEvent): TargetLink | null {
  if (!dragId) return null
  if (store.selectedRoad && isPedestrianWay(store.selectedRoad)) {
    const other = store.roads.filter(road => road.id !== dragRoadId &&
      !road.vertices.some(vertex => vertex.id === dragId))
    const nearest = findPedestrianSnap(raw, other, currentSnapTolerance())
    return nearest ? { roadId: nearest.roadId, segmentIndex: nearest.segmentIndex,
      t: nearest.t, vertex: nearest.vertex } : null
  }
  const otherRoads = (visibleRoads.length ? visibleRoads : store.roads).filter(
    road => road.id !== dragRoadId && !road.vertices.some(vertex => vertex.id === dragId),
  )
  const laneLink = laneTargetAtPointer(e, otherRoads)
  if (laneLink) return laneLink
  const screenLink = elevatedScreenTarget(e, otherRoads)
  if (screenLink) return screenLink
  if (store.mode === '3d') return null
  return snapToRoad(
    raw, otherRoads, currentSnapTolerance(), null,
    e.originalEvent.shiftKey ? 0 : null,
  ).link
}

function setCrossingKind(id: string, kind: CrossingKind): void {
  const crossing = pendingPlan.value?.crossings.find(item => item.id === id)
  if (!crossing) return
  crossing.kind = kind
  planError.value = ''
  redrawPreview()
}

function setBridgeBoundary(id: string, field: 'bridgeFrom' | 'bridgeTo', value: number): void {
  const crossing = pendingPlan.value?.crossings.find(item => item.id === id)
  if (!crossing || !Number.isFinite(value)) return
  crossing[field] = value
  planError.value = ''
  redrawPreview()
}

function updateRoundaboutRadius(event: Event): void {
  if (!pendingRoundabout.value) return
  const radius = Number((event.target as HTMLInputElement).value)
  try {
    const plan = store.prepareRoundabout(pendingRoundabout.value.center, radius)
    pendingRoundabout.value = plan
    roundaboutError.value = ''
  } catch (error) {
    roundaboutError.value = error instanceof Error ? error.message : 'Некорректный радиус.'
  }
  redrawPreview()
}
function confirmRoundabout(): void {
  if (!pendingRoundabout.value || roundaboutError.value) return
  try {
    store.commitRoundabout(pendingRoundabout.value)
    cancelPending()
  } catch (error) {
    roundaboutError.value = error instanceof Error ? error.message : 'Не удалось создать круговое движение.'
  }
}

function confirmJunction(): void {
  if (!pendingJunction.value) return
  try {
    store.commitJunction(pendingJunction.value, junctionRevision)
    cancelPending()
  } catch (error) {
    junctionError.value = error instanceof Error ? error.message : 'Не удалось соединить дороги.'
  }
}

function cancelPending(): void {
  pendingPlan.value = null
  pendingRoundabout.value = null
  pendingJunction.value = null
  junctionError.value = ''
  roundaboutCenter.value = null
  planError.value = ''
  roundaboutError.value = ''
  clearPenDraft()
  redrawPreview()
}
function confirmPending(): void {
  if (!pendingPlan.value) return
  try {
    store.commitRoadPlan(pendingPlan.value)
    cancelPending()
  } catch (error) {
    planError.value = error instanceof Error ? error.message : 'Не удалось создать соединение.'
  }
}

function updateSource(id: string, data: ReturnType<typeof pedestrianEdgesCollection> | ReturnType<typeof pedestrianSurfacesCollection> | ReturnType<typeof pedestrianNodesCollection> | ReturnType<typeof pedestrianRouteCollection> | ReturnType<typeof roadMarkingsCollection> | ReturnType<typeof crosswalksCollection> | ReturnType<typeof turnArrowsCollection> | ReturnType<typeof roadCollection> | ReturnType<typeof bridgeEndsCollection> | ReturnType<typeof previewBridgeEndsCollection> | ReturnType<typeof handlesCollection> | ReturnType<typeof previewCollection> | ReturnType<typeof crossingCollection> | ReturnType<typeof snapCollection> | ReturnType<typeof bridgePreviewCollection> | ReturnType<typeof roundaboutPreviewCollection> | ReturnType<typeof roundaboutConnectionsCollection> | ReturnType<typeof lanesCollection> | ReturnType<typeof graphEdgesCollection> | ReturnType<typeof graphNodesCollection> | ReturnType<typeof graphConnectionsCollection> | ReturnType<typeof editAxisCollection> | ReturnType<typeof junctionPreviewCollection> | ReturnType<typeof junctionArmsCollection> | ReturnType<typeof infrastructurePointsCollection> | ReturnType<typeof infrastructureLinesCollection> | ReturnType<typeof roadStatusCollection> | ReturnType<typeof analysisIssuesCollection>): void {
  const source = map?.getSource(id) as GeoJSONSource | undefined
  if (!source) return
  // Hard separation: even if MapLibre restores a layout visibility flag,
  // hidden graphs contain zero features (including their hit-test layers).
  source.setData(networkSourceVisible(id, store.networkMode) ? data : emptyCollection())
}

/** Frame-coalesced preview: MapLibre workers should receive at most one update
 * per frame, not seven GeoJSON setData calls for every pointer event. */
function redrawPreview(): void {
  if (previewFrame) return
  previewFrame = requestAnimationFrame(() => {
    previewFrame = 0
    if (!map || !map.getSource('editor-preview')) return
    const hasLine = !!pendingPlan.value || (store.tool === 'pen' && (draftPoints.value.length > 0 || !!cursor.value))
    if (hasLine || previewWasVisible) updateSource('editor-preview', previewCollection())
    previewWasVisible = hasLine
    if (snapIndicator.value || snapWasVisible) updateSource('editor-snap', snapCollection())
    snapWasVisible = !!snapIndicator.value

    if (pendingPlan.value !== lastPreviewPlan) {
      updateSource('editor-preview-bridge', bridgePreviewCollection())
      updateSource('editor-preview-bridge-ends', previewBridgeEndsCollection())
      updateSource('editor-crossings', crossingCollection())
      lastPreviewPlan = pendingPlan.value
    }
    if (pendingRoundabout.value !== lastPreviewRoundabout) {
      updateSource('editor-roundabout-connections', roundaboutConnectionsCollection())
      lastPreviewRoundabout = pendingRoundabout.value
    }
    if (pendingJunction.value !== lastPreviewJunction) {
      updateSource('editor-junction-preview', junctionPreviewCollection())
      updateSource('editor-junction-arms', junctionArmsCollection())
      lastPreviewJunction = pendingJunction.value
    }
    if (roundaboutCenter.value || pendingRoundabout.value || lastPreviewCentre) {
      updateSource('editor-preview-roundabout', roundaboutPreviewCollection())
    }
    lastPreviewCentre = roundaboutCenter.value
  })
}

/** Always show the complete directed lane graph. An earlier UI-only filter
 * could hide every connection when no lane was selected. Keep individual
 * lane highlighting without deleting available turns from the display. */
function allGraphConnectionsCollection() {
  const focus = store.selectedGraphLane
  return { type: 'FeatureCollection' as const, features: laneGraph.connections.map(link => ({
    type: 'Feature' as const,
    properties: {
      fromRoad: link.fromRoad, fromLane: link.fromLane,
      toRoad: link.toRoad, toLane: link.toLane, turn: link.turn,
      selected: !!focus && (
        (link.fromRoad === focus.roadId && link.fromLane === focus.laneIndex) ||
        (link.toRoad === focus.roadId && link.toLane === focus.laneIndex)
      ),
    },
    geometry: { type: 'LineString' as const,
      coordinates: link.coordinates.map(point => [point.lng, point.lat]) },
  })) }
}

/** Versioned rendering: pan, selection, graph focus and OSM edits invalidate
 * independent subsets of the rendering pipeline. They must not rebuild the
 * entire 3D city mesh and lane graph together on every input event. */
function redraw(): void {
  if (!map || !map.getSource('editor-roads')) return
  const roadRevision = store.roadRenderRevision
  const roadChanged = roadRevision !== lastRoadRenderRevision
  const roadOverlayRevision = store.roadOverlayRevision
  const roadOverlayChanged = roadOverlayRevision !== lastRoadOverlayRevision
  const infraRevision = store.infrastructureRevision
  const infrastructureChanged = infraRevision !== lastInfrastructureRevision
  const statusRevision = store.roadStatusRevision
  const statusChanged = statusRevision !== lastRoadStatusRevision
  const analysisRevision = store.roadAnalysisRevision
  const analysisChanged = analysisRevision !== lastAnalysisRevision
  const analysisModeChanged = store.mode !== lastAnalysisMode
  const analysisVisibilityChanged = store.roadAnalysisVisible !== lastAnalysisVisible
  const crosswalkRevision = store.crosswalkRevision
  const crosswalkChanged = crosswalkRevision !== lastCrosswalkRevision

  // Expensive road/pedestrian topology caches are invalidated ONLY by road
  // edits. Placing or editing a traffic sign must not rebuild the whole city.
  if (roadChanged) {
    const motor = motorRoads(store.roads)
    surfaceCache = surfaceNetwork(motor)
    const paintable = roadMarkingSections(motor, surfaceCache)
    visibleMarkingSections = paintable
    borderSurfaceCache = surfaceCache.flatMap(road => (paintable.get(road.id) ?? [road.vertices])
      .filter(vertices => vertices.length > 1)
      .map(vertices => ({ ...road, vertices })))
    indexedRoads = indexRoadBounds(motor)
    indexedAllRoads = indexRoadBounds(store.roads)
    walkGraph = buildPedestrianGraph(store.roads)
    pedestrianPortalCache = pedestrianPortalFeatures(store.roads)
    infrastructurePlacementIndex = createInfrastructurePlacementIndex(store.roads)
    lastRoadRenderRevision = roadRevision
  }
  if (roadChanged || roadOverlayChanged || crosswalkChanged) {
    crosswalkCache = crosswalkStripeFeatures(store.roads, store.infrastructure)
    lastCrosswalkRevision = crosswalkRevision
  }
  if (roadOverlayChanged) lastRoadOverlayRevision = roadOverlayRevision
  if (infrastructureChanged) lastInfrastructureRevision = infraRevision

  const networkChanged = store.networkMode !== lastNetworkMode
  const { motor: motorVisible, pedestrian: pedestrianVisible } = graphVisibility(store.networkMode)
  const bounds = map.getBounds()
  const boundsNow = { west: bounds.getWest(), east: bounds.getEast(),
    south: bounds.getSouth(), north: bounds.getNorth() }
  const zoom = map.getZoom()
  const zoomClass = zoom >= 18 ? 'near' : zoom >= 16 ? 'detail'
    : zoom >= 14 ? 'local' : 'overview'
  const withinCache = cachedViewport &&
    boundsNow.west >= cachedViewport.west && boundsNow.east <= cachedViewport.east &&
    boundsNow.south >= cachedViewport.south && boundsNow.north <= cachedViewport.north
  if (!withinCache || roadChanged) {
    const xMetres = (boundsNow.east - boundsNow.west) * 111_320 *
      Math.max(0.1, Math.cos((boundsNow.north + boundsNow.south) / 2 * Math.PI / 180))
    const yMetres = (boundsNow.north - boundsNow.south) * 111_320
    const padMetres = Math.max(250, Math.min(2500, Math.max(xMetres, yMetres) * 0.5))
    cachedViewport = expandBounds(boundsNow, padMetres)
    viewportEpoch++
    visibleRoads = roadsWithin(indexedRoads, cachedViewport)
    visibleAllRoads = roadsWithin(indexedAllRoads, cachedViewport)
    const ids = new Set(visibleRoads.map(road => road.id))
    visibleSurfaces = surfaceCache.filter(road => ids.has(road.id))
    visibleBorderSurfaces = borderSurfaceCache.filter(road => ids.has(road.id))
  }
  const viewportKey = `${viewportEpoch}|${zoomClass}`
  const viewChanged = roadChanged || viewportKey !== lastViewportKey
  if (viewChanged || roadOverlayChanged) {
    lastViewportKey = viewportKey
    visibleRoadMarkings = roadMarkingFeatures(visibleRoads)
    visibleTurnArrows = turnArrowFeatures(visibleRoads)
  }

  const selectionChanged = roadChanged || networkChanged || lastSelectionId !== store.selectedId
  if (selectionChanged || viewChanged || statusChanged) {
    updateSource('editor-roads', roadCollection())
    updateSource('editor-lanes', lanesCollection())
    updateSource('editor-lane-border-lines', laneBordersCollection())
    lastSelectionId = store.selectedId
  }
  if (viewChanged || roadOverlayChanged || networkChanged || statusChanged) {
    updateSource('editor-road-status', roadStatusCollection())
    updateSource('editor-road-markings', roadMarkingsCollection())
    updateSource('editor-turn-arrows', turnArrowsCollection())
    lastRoadStatusRevision = statusRevision
  }
  if (roadChanged || viewChanged || networkChanged || analysisChanged || analysisModeChanged || analysisVisibilityChanged) {
    updateSource('editor-analysis-issues', analysisIssuesCollection())
    lastAnalysisRevision = analysisRevision
    lastAnalysisMode = store.mode
    lastAnalysisVisible = store.roadAnalysisVisible
  }
  if (roadChanged || roadOverlayChanged || selectionChanged || networkChanged || viewChanged) {
    updateSource('editor-pedestrian-edges', pedestrianEdgesCollection())
  }
  if (roadChanged || roadOverlayChanged || networkChanged || viewChanged) {
    updateSource('editor-pedestrian-surfaces', pedestrianSurfacesCollection())
    updateSource('editor-pedestrian-nodes', pedestrianNodesCollection())
    updateSource('editor-pedestrian-portals', pedestrianPortalsCollection())
  }
  if (roadChanged || networkChanged) updateSource('editor-pedestrian-route', pedestrianRouteCollection())
  if (roadChanged || crosswalkChanged || networkChanged || viewChanged) {
    updateSource('editor-crosswalk-stripes', crosswalksCollection())
  }

  const selectedInfraId = store.selectedInfrastructureId
  if (roadChanged || infrastructureChanged || networkChanged || selectedInfraId !== lastInfraSelectionId) {
    updateSource('editor-infrastructure-points', infrastructurePointsCollection())
    updateSource('editor-infrastructure-lines', infrastructureLinesCollection())
    lastInfraSelectionId = selectedInfraId
  }

  const graphVisible = store.graphView && store.mode === '2d' && motorVisible
  const graphChanged = graphVisible !== lastGraphEnabled
  const focus = store.selectedGraphLane
  const focusKey = focus ? `${focus.roadId}:${focus.laneIndex}` : ''
  const focusChanged = focusKey !== lastGraphFocus || selectionChanged
  if (graphVisible && (viewChanged || graphChanged)) {
    laneGraph = map.getZoom() >= 14 ? buildLaneGraph(visibleRoads, {
      viewport: { west: bounds.getWest(), east: bounds.getEast(), south: bounds.getSouth(), north: bounds.getNorth() },
      maxConnections: map.getZoom() >= 16 ? 1300 : 0,
    }) : { edges: [], nodes: [], connections: [], junctionCount: 0 }
  } else if (!graphVisible && lastGraphEnabled) {
    laneGraph = { edges: [], nodes: [], connections: [], junctionCount: 0 }
  }
  if (graphChanged || viewChanged && graphVisible || graphVisible && focusChanged) {
    updateSource('editor-graph-edges', graphEdgesCollection())
    updateSource('editor-graph-nodes', graphNodesCollection())
    updateSource('editor-graph-connections', allGraphConnectionsCollection())
  }
  lastGraphEnabled = graphVisible
  lastGraphFocus = focusKey

  const handleKey = `${store.geometryRevision}:${store.selectedId ?? ''}:${store.tool}:${store.graphView}:${store.moveObjectMode}:${tabMoveHeld.value}:${store.networkMode}`
  if (handleKey !== lastHandleKey) {
    updateSource('editor-handles', handlesCollection())
    updateSource('editor-edit-axis', editAxisCollection())
    updateSource('editor-bridge-ends', bridgeEndsCollection())
    lastHandleKey = handleKey
  }

  syncBackgroundTransportation()
  const is3d = store.mode === '3d'
  const meshEnabled = is3d && (motorVisible || pedestrianVisible)
  roadMesh.setEnabled(meshEnabled)
  const sceneDetail = zoom >= 18 ? 2 : zoom >= 16 ? 1 : 0
  const meshRoadKey = `${roadRevision}:${viewportKey}:${sceneDetail}:${is3d}`
  if (is3d && (meshRoadKey !== lastMeshRoadKey || networkChanged || lastViewMode !== store.mode)) {
    // Road surface is a dedicated buffer. Status changes rebuild it only
    // when the actual imported/modified color state changes.
    roadMesh.setRoads(motorVisible ? visibleSurfaces : [], null, visibleAllRoads)
    lastMeshRoadKey = meshRoadKey
  }
  const meshStatusKey = `${roadRevision}:${statusRevision}:${viewportKey}:${store.networkMode}:${is3d}`
  if (is3d && (meshStatusKey !== lastMeshStatusKey || networkChanged || lastViewMode !== store.mode)) {
    roadMesh.setStatuses(store.roadStatusById)
    roadMesh.setRoadStatusSurface(motorVisible ? visibleSurfaces : [])
    lastMeshStatusKey = meshStatusKey
  }
  const meshRoadFurnitureKey = `${roadRevision}:${roadOverlayRevision}:${viewportKey}:${sceneDetail}:${store.networkMode}:${is3d}`
  if (is3d && (meshRoadFurnitureKey !== lastMeshRoadFurnitureKey || networkChanged || lastViewMode !== store.mode)) {
    const furnitureBounds = cachedViewport ?? boundsNow
    const near3d = (lng: number, lat: number) =>
      lng >= furnitureBounds.west && lng <= furnitureBounds.east &&
      lat >= furnitureBounds.south && lat <= furnitureBounds.north
    const barriers = sceneDetail === 2 && motorVisible
      ? store.sceneBarriers.filter(item => item.vertices.some(point => near3d(point.lng, point.lat))) : []
    const lanePaint = sceneDetail === 2 && motorVisible ? visibleRoadMarkings : []
    roadMesh.setRoadInfrastructure(motorVisible ? visibleSurfaces : [], barriers, lanePaint,
      sceneDetail, infrastructurePlacementIndex)
    lastMeshRoadFurnitureKey = meshRoadFurnitureKey
  }
  const meshInfrastructureKey = `${roadRevision}:${infraRevision}:${viewportKey}:${sceneDetail}:${store.networkMode}:${is3d}`
  if (is3d && (meshInfrastructureKey !== lastMeshInfrastructureKey || networkChanged || lastViewMode !== store.mode)) {
    const furnitureBounds = cachedViewport ?? boundsNow
    const near3d = (lng: number, lat: number) =>
      lng >= furnitureBounds.west && lng <= furnitureBounds.east &&
      lat >= furnitureBounds.south && lat <= furnitureBounds.north
    const furniture = sceneDetail > 0
      ? store.infrastructure.filter(feature => {
          if (!feature.vertices.some(v => near3d(v.lng, v.lat))) return false
          if (store.networkMode === 'pedestrian') return feature.kind === 'crossing' ||
            (feature.kind === 'traffic_signal' && (feature.tags.crossing || feature.tags['traffic_signals:direction'] === 'pedestrian'))
          return store.networkMode === 'all' || feature.kind !== 'crossing'
        }) : []
    roadMesh.setInfrastructure(motorVisible ? visibleSurfaces : [], furniture, [], [], [],
      sceneDetail, infrastructurePlacementIndex)
    lastMeshInfrastructureKey = meshInfrastructureKey
  }
  const pedestrianDetail = zoom >= 18 ? 2 : zoom >= 15 ? 1 : 0
  const meshPedestrianKey = `${roadRevision}:${roadOverlayRevision}:${crosswalkRevision}:${viewportKey}:${pedestrianDetail}:${pedestrianVisible}:${is3d}`
  if (is3d && (meshPedestrianKey !== lastMeshPedestrianKey || networkChanged || lastViewMode !== store.mode)) {
    const pedestrianPaint = pedestrianVisible
      ? crosswalkCache.filter(item => item.geometry.coordinates[0]?.some(point =>
          point[0]! >= (cachedViewport?.west ?? boundsNow.west) && point[0]! <= (cachedViewport?.east ?? boundsNow.east) &&
          point[1]! >= (cachedViewport?.south ?? boundsNow.south) && point[1]! <= (cachedViewport?.north ?? boundsNow.north)))
      : []
    roadMesh.setPedestrianSurfaces(pedestrianVisible ? visibleAllRoads : [], pedestrianDetail, pedestrianPaint)
    lastMeshPedestrianKey = meshPedestrianKey
  }
  lastViewMode = store.mode

  applyNetworkLayerVisibility(map, store.networkMode, store.mode, store.graphView)
  const surfaceOpacity = graphVisible ? 0.14 : 0.99
  if (map.getLayer('editor-lane-surfaces') && map.getPaintProperty('editor-lane-surfaces', 'line-opacity') !== surfaceOpacity) {
    map.setPaintProperty('editor-lane-surfaces', 'line-opacity', surfaceOpacity)
  }
  const outlineOpacity = !motorVisible ? 0 : is3d ? 0.24 : 0.68
  const roadOpacity = !motorVisible ? 0 : is3d ? (store.selectedId ? 0.82 : 0.30) : graphVisible ? 0.18 : 0.90
  if (map.getLayer('editor-road-outline') && map.getPaintProperty('editor-road-outline', 'line-opacity') !== outlineOpacity) {
    map.setPaintProperty('editor-road-outline', 'line-opacity', outlineOpacity)
  }
  if (map.getLayer('editor-road-line') && map.getPaintProperty('editor-road-line', 'line-opacity') !== roadOpacity) {
    map.setPaintProperty('editor-road-line', 'line-opacity', roadOpacity)
  }
  lastNetworkMode = store.networkMode
}
/** Coalesce bursts of reactive changes and cap heavy geometry edits to 20 FPS.
 * Camera movement itself stays GPU-smooth: only OSM rebuilds are rate-limited. */
function scheduleRedraw(): void {
  if (drawFrame || drawTimer !== null) return
  const elapsed = performance.now() - lastDrawAt
  const minimum = dragId || objectDrag ? 48 : 0
  const remaining = minimum - elapsed
  if (remaining > 0) {
    drawTimer = window.setTimeout(() => {
      drawTimer = null
      scheduleRedraw()
    }, remaining)
    return
  }
  drawFrame = requestAnimationFrame(() => {
    drawFrame = 0
    lastDrawAt = performance.now()
    redraw()
  })
}

function installLayers(): void {
  if (!map || map.getSource('editor-roads')) return
  backgroundTransportLines.clear()
  for (const layer of map.getStyle().layers ?? []) {
    if (isBackgroundTransportLine(layer)) {
      backgroundTransportLines.set(layer.id,
        map.getLayoutProperty(layer.id, 'visibility') === 'none' ? 'none' : 'visible')
    }
  }
  map.addSource('editor-roads', { type: 'geojson', data: emptyCollection() })
  map.addSource('editor-pedestrian-edges', { type: 'geojson', data: emptyCollection() })
  map.addSource('editor-pedestrian-surfaces', { type: 'geojson', data: emptyCollection() })
  map.addSource('editor-pedestrian-nodes', { type: 'geojson', data: emptyCollection() })
  map.addSource('editor-pedestrian-portals', { type: 'geojson', data: emptyCollection() })
  map.addSource('editor-pedestrian-route', { type: 'geojson', data: emptyCollection() })
  map.addSource('editor-road-markings', { type: 'geojson', data: emptyCollection() })
  map.addSource('editor-turn-arrows', { type: 'geojson', data: emptyCollection() })
  map.addSource('editor-crosswalk-stripes', { type: 'geojson', data: emptyCollection() })
  map.addSource('editor-lanes', { type: 'geojson', data: emptyCollection() })
  map.addSource('editor-lane-border-lines', { type: 'geojson', data: emptyCollection() })
  map.addSource('editor-road-status', { type: 'geojson', data: emptyCollection() })
  map.addSource('editor-analysis-issues', { type: 'geojson', data: emptyCollection() })
  map.addSource('editor-edit-axis', { type: 'geojson', data: emptyCollection() })
  map.addSource('editor-graph-edges', { type: 'geojson', data: emptyCollection() })
  map.addSource('editor-graph-nodes', { type: 'geojson', data: emptyCollection() })
  map.addSource('editor-graph-connections', { type: 'geojson', data: emptyCollection() })
  map.addSource('editor-bridge-ends', { type: 'geojson', data: emptyCollection() })
  map.addSource('editor-preview-bridge-ends', { type: 'geojson', data: emptyCollection() })
  map.addSource('editor-handles', { type: 'geojson', data: emptyCollection() })
  map.addSource('editor-preview', { type: 'geojson', data: emptyCollection() })
  map.addSource('editor-crossings', { type: 'geojson', data: emptyCollection() })
  map.addSource('editor-preview-bridge', { type: 'geojson', data: emptyCollection() })
  map.addSource('editor-snap', { type: 'geojson', data: emptyCollection() })
  map.addSource('editor-preview-roundabout', { type: 'geojson', data: emptyCollection() })
  map.addSource('editor-roundabout-connections', { type: 'geojson', data: emptyCollection() })
  map.addSource('editor-junction-preview', { type: 'geojson', data: emptyCollection() })
  map.addSource('editor-junction-arms', { type: 'geojson', data: emptyCollection() })
  map.addSource('editor-infrastructure-points', { type: 'geojson', data: emptyCollection() })
  map.addSource('editor-infrastructure-lines', { type: 'geojson', data: emptyCollection() })
  registerTrafficIcons(map)
  map.addLayer(roadMesh)
  // A satellite raster is inserted BELOW every editor layer. It covers only
  // the original vector basemap, so switching never destroys editor sources.
  map.addSource(SATELLITE_SOURCE_ID, {
    type: 'raster',
    tiles: [satelliteTiles],
    tileSize: 256,
    maxzoom: 19,
    attribution: satelliteAttribution,
  })
  map.addLayer({
    id: SATELLITE_LAYER_ID,
    type: 'raster',
    source: SATELLITE_SOURCE_ID,
    layout: { visibility: satelliteVisibility(basemapMode.value) },
    paint: { 'raster-opacity': 1, 'raster-fade-duration': 0 },
  }, roadMesh.id)
  map.addLayer({ id: 'editor-road-outline', type: 'line', source: 'editor-roads', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: {
    'line-color': ['match', ['get', 'status'],
      'imported', ROAD_STATUS_COLORS.imported,
      'created', ROAD_STATUS_COLORS.created,
      'modified', ROAD_STATUS_COLORS.modified, ROAD_STATUS_COLORS.imported],
    'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 13, 2.1, 15, 3.2, 17, 7], 'line-opacity': 0.68,
  } })
  map.addLayer({ id: 'editor-road-line', type: 'line', source: 'editor-roads', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: {
    'line-color': ['case', ['get', 'selected'], '#13a89d', ['get', 'bridge'], '#c19056', '#5588ad'],
    'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 13, 1.1, 15, 2.5, 17, 5.5], 'line-opacity': 0.9,
  } })
  // In 2D, draw individual offset lanes, not one centreline regardless of lane count.
  // A zoom expression must be the ROOT interpolate/step node in MapLibre style spec.
  // Metre-based widths must continue scaling after zoom 20; the old stop
  // table ended there, making the painted roads shrink relative to the map.
  // 2D widths represent exactly the same physical 3.2m lanes as 3D and OSM.
  const atZoom = (make: (px: number) => unknown): any => [
    'interpolate', ['exponential', 2], ['zoom'],
    ...METRIC_RENDER_ZOOM_STOPS.flatMap(zoom => [zoom,
      make(LANE_WIDTH_METRES * mercatorPixelsPerMetre(zoom))]),
  ]
  const laneWidthPx = (px: number) => ['*', px, ['get', 'latitudeFactor']]
  const laneOffsetPx = atZoom(px => ['*', ['get', 'laneOffset'], laneWidthPx(px)])
  // Pedestrian surfaces and painted stop bars use metres, not fixed UI pixels.
  const pedestrianWidthPx = atZoom(px => ['max', 2.4, ['*', ['get', 'width'], ['get', 'latitudeFactor'], px / LANE_WIDTH_METRES]])
  // No circular junction fill: it produced oversized discs over crossings and bridges.
  // Keep road nodes topological; paint the lane lines with flat ends instead.
  map.addLayer({ id: 'editor-lane-borders', type: 'line', source: 'editor-lane-border-lines', minzoom: 14,
    layout: { 'line-join': 'round', 'line-cap': 'butt' },
    paint: {
      'line-offset': laneOffsetPx,
      'line-color': ['case', ['get', 'selected'], '#075f61', ['get', 'bridge'], '#624a30', '#213c4e'],
      'line-width': atZoom(px => ['+', 1.0, laneWidthPx(px)]),
      'line-opacity': 0.98,
    },
  })
  map.addLayer({ id: 'editor-lane-surfaces', type: 'line', source: 'editor-lanes', minzoom: 14,
    layout: { 'line-join': 'round', 'line-cap': 'butt' },
    paint: {
      'line-offset': laneOffsetPx,
      'line-color': ['case', ['get', 'selected'], '#2fbbb0', ['get', 'bridge'], '#bc996c', '#5e91ad'],
      'line-width': atZoom(px => ['max', 0.8, ['-', laneWidthPx(px), 0.8]]),
      'line-opacity': 0.99,
    },
  })
  // OSM-mapped / explicitly edited road markings: solid, double solid and dashed.
  const markWidth = atZoom(px => ['max', 0.8, ['*', 0.15, px]])
  map.addLayer({ id: 'editor-road-marking-solid', type: 'line', source: 'editor-road-markings', minzoom: 15,
    filter: ['in', ['get', 'kind'], ['literal', ['solid', 'edge']]],
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: { 'line-color': ['case', ['get', 'inferred'], '#b6c8cd', '#f5f4e8'],
      'line-width': markWidth, 'line-opacity': ['case', ['get', 'inferred'], 0.65, 0.95] },
  })
  map.addLayer({ id: 'editor-road-marking-dashed', type: 'line', source: 'editor-road-markings', minzoom: 15,
    filter: ['==', ['get', 'kind'], 'dashed'],
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: { 'line-color': '#f5f4e8', 'line-width': markWidth, 'line-opacity': 0.92,
      'line-dasharray': [6, 5] },
  })
  map.addLayer({ id: 'editor-pedestrian-curbs', type: 'fill-extrusion', source: 'editor-pedestrian-surfaces',
    minzoom: 15, layout: { visibility: 'none' },
    paint: { 'fill-extrusion-color': ['case', ['get', 'inferred'], '#b0c5b6',
        ['==', ['get', 'kind'], 'steps'], '#b8a68c', '#a9c9b8'],
      'fill-extrusion-height': 0.16, 'fill-extrusion-base': 0,
      'fill-extrusion-opacity': 0.85 },
  })
  // Real pedestrian OSM ways and inferred sidewalk tags are visually different.
  // Bridges/roads are never visually attached to a crossing just by XY overlap.
  map.addLayer({ id: 'editor-pedestrian-path-halo', type: 'line', source: 'editor-pedestrian-edges', minzoom: 10,
    filter: ['all', ['==', ['get', 'inferred'], false], ['!=', ['get', 'underground'], true]],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#143b38', 'line-width': atZoom(px => ['+', 2, ['max', 2.4, ['*', ['get', 'width'], ['get', 'latitudeFactor'], px / LANE_WIDTH_METRES]]]), 'line-opacity': 0.91 },
  })
  map.addLayer({ id: 'editor-pedestrian-paths', type: 'line', source: 'editor-pedestrian-edges', minzoom: 10,
    filter: ['all', ['==', ['get', 'inferred'], false], ['!=', ['get', 'underground'], true]],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['case', ['get', 'selected'], '#edff8b',
      ['==', ['get', 'kind'], 'steps'], '#e3aa5b',
      ['==', ['get', 'kind'], 'cycleway'], '#4bc6dc', '#42e0a9'],
      'line-width': pedestrianWidthPx, 'line-opacity': 0.99 },
  })
  map.addLayer({ id: 'editor-pedestrian-inferred', type: 'line', source: 'editor-pedestrian-edges', minzoom: 12,
    filter: ['all', ['==', ['get', 'inferred'], true], ['!=', ['get', 'underground'], true]],
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: { 'line-color': '#81d7a7', 'line-width': pedestrianWidthPx, 'line-opacity': 0.8,
      'line-dasharray': [2, 2] },
  })
  // Below-ground OSM walkways use a separate, dashed violet visual language.
  // These remain routeable by their original IDs, but receive NO fake elevated 3D curb.
  map.addLayer({ id: 'editor-pedestrian-tunnel-halo', type: 'line', source: 'editor-pedestrian-edges', minzoom: 10,
    filter: ['==', ['get', 'underground'], true],
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: { 'line-color': '#352a50', 'line-width': atZoom(px => ['+', 2.3, ['max', 2.5, ['*', ['get', 'width'], ['get', 'latitudeFactor'], px / LANE_WIDTH_METRES]]]),
      'line-opacity': 0.65, 'line-dasharray': [2.8, 1.6] },
  })
  map.addLayer({ id: 'editor-pedestrian-tunnels', type: 'line', source: 'editor-pedestrian-edges', minzoom: 10,
    filter: ['==', ['get', 'underground'], true],
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: { 'line-color': ['case', ['get', 'selected'], '#f4e3ff', '#c99aff'],
      'line-width': pedestrianWidthPx, 'line-opacity': 0.92, 'line-dasharray': [2.8, 1.6] },
  })
  map.addLayer({ id: 'editor-pedestrian-portals-layer', type: 'symbol', source: 'editor-pedestrian-portals', minzoom: 15,
    layout: { 'text-field': '↓', 'text-font': ['Noto Sans Regular'], 'text-size': 17,
      'text-allow-overlap': true },
    paint: { 'text-color': '#f0d9ff', 'text-halo-color': '#47345f', 'text-halo-width': 2.5 },
  })
  map.addLayer({ id: 'editor-pedestrian-junctions', type: 'circle', source: 'editor-pedestrian-nodes', minzoom: 17,
    paint: { 'circle-radius': 3, 'circle-color': '#cbffdf', 'circle-stroke-color': '#267e6d', 'circle-stroke-width': 1 },
  })
  map.addLayer({ id: 'editor-pedestrian-route-line', type: 'line', source: 'editor-pedestrian-route', minzoom: 10,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffe475', 'line-width': 6, 'line-opacity': 1 },
  })
  map.addLayer({ id: 'editor-pedestrian-hit', type: 'line', source: 'editor-pedestrian-edges', minzoom: 10,
    filter: ['==', ['get', 'inferred'], false], paint: { 'line-width': 14, 'line-opacity': 0 },
  })
  // Zebra bars are real metre-sized polygons, never fixed-width screen lines.
  // Their long edge follows traffic direction; the bars are spaced across it.
  map.addLayer({ id: 'editor-zebra-stripes', type: 'fill', source: 'editor-crosswalk-stripes', minzoom: 15.5,
    paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.97 },
  })
  // OSM turn:lanes arrows, located in their own physical lanes.
  map.addLayer({ id: 'editor-turn-arrows-layer', type: 'symbol', source: 'editor-turn-arrows', minzoom: 16.5,
    layout: { 'text-field': ['get', 'glyph'], 'text-font': ['Noto Sans Regular'],
      'text-size': 18, 'text-allow-overlap': true, 'text-rotation-alignment': 'map',
      'text-rotate': ['get', 'rotation'] },
    paint: { 'text-color': '#ffffff', 'text-halo-color': '#26404d', 'text-halo-width': 1 },
  })
  // Thin contours on BOTH outer edges, outside the actual lane surfaces.
  // Never tint the asphalt or lane separators and never draw junction discs.
  map.addLayer({ id: 'editor-road-status-edges', type: 'line', source: 'editor-road-status', minzoom: 14,
    layout: { 'line-join': 'round', 'line-cap': 'butt' },
    paint: {
      'line-offset': atZoom(px => ['*', ['get', 'side'],
        ['+', ['*', ['get', 'lanes'], 0.5, laneWidthPx(px)], ['max', 0.8, ['*', 0.08, laneWidthPx(px)]]]]),
      'line-color': ['match', ['get', 'status'],
        'imported', ROAD_STATUS_COLORS.imported,
        'created', ROAD_STATUS_COLORS.created,
        'modified', ROAD_STATUS_COLORS.modified, ROAD_STATUS_COLORS.imported],
      'line-width': atZoom(px => ['min', 3.5, ['max', 1.8, ['*', 0.18, laneWidthPx(px)]]]),
      'line-opacity': 0.98,
    },
  })
  // Quality analysis is a view-only overlay; it never changes road geometry or OSM.
  map.addLayer({ id: 'editor-analysis-issues-halo', type: 'line', source: 'editor-analysis-issues',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#18232b', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 5, 15, 9, 18, 13],
      'line-opacity': 0.88, 'line-blur': 1.1 },
  })
  map.addLayer({ id: 'editor-analysis-issues', type: 'line', source: 'editor-analysis-issues',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['match', ['get', 'severity'], 'critical', '#ef4444', 'warning', '#f59e0b', '#a78bfa'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2.2, 14, 3.5, 17, 5.5],
      'line-opacity': 0.98, 'line-dasharray': [1.2, 0.8] },
  })
  map.addLayer({ id: 'editor-analysis-issue-points-halo', type: 'circle', source: 'editor-analysis-issues',
    filter: ['==', '$type', 'Point'],
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4.5, 15, 7.5, 18, 9],
      'circle-color': '#17232c', 'circle-opacity': 0.98,
      'circle-stroke-color': '#f4f7f8', 'circle-stroke-width': 1.5 },
  })
  map.addLayer({ id: 'editor-analysis-issue-points', type: 'circle', source: 'editor-analysis-issues',
    filter: ['==', '$type', 'Point'],
    paint: { 'circle-radius': ['case', ['==', ['get', 'role'], 'near-target'], 3.8, 5.8],
      'circle-color': ['match', ['get', 'severity'], 'critical', '#ef4444', 'warning', '#f59e0b', '#a78bfa'],
      'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.4 },
  })
  // Dedicated lane graph, inspired by the supplied traffic editor recording:
  // one cyan line per traffic lane, individual endpoint/junction nodes and
  // automatically inferred (non-exported) lane-to-lane connector curves.
  map.addLayer({ id: 'editor-graph-links', type: 'line', source: 'editor-graph-connections',
    minzoom: 14, layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
    paint: { 'line-color': ['case', ['get', 'selected'], '#b6ef62', '#30b49e'],
      'line-width': ['case', ['get', 'selected'], 3.0, 1.5],
      'line-opacity': ['case', ['get', 'selected'], 0.98, 0.48] },
  })
  map.addLayer({ id: 'editor-graph-lanes', type: 'line', source: 'editor-graph-edges',
    minzoom: 13.5, layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
    paint: { 'line-color': ['case', ['get', 'focus'], '#c2ff64', ['get', 'selected'], '#58e6b4', '#4bd1d3'],
      'line-width': ['case', ['get', 'focus'], 4, ['get', 'selected'], 2.9, 1.5],
      'line-opacity': ['case', ['get', 'focus'], 1, 0.86] },
  })
  map.addLayer({ id: 'editor-graph-nodes', type: 'circle', source: 'editor-graph-nodes',
    minzoom: 15, layout: { visibility: 'none' },
    paint: { 'circle-radius': ['case', ['get', 'selected'], 5, ['get', 'junction'], 3.8, 2.6],
      'circle-color': ['case', ['get', 'selected'], '#c2ff64', '#183745'],
      'circle-stroke-color': '#50d9d8', 'circle-stroke-width': 1.6,
      'circle-opacity': 0.98 },
  })
  map.addLayer({ id: 'editor-graph-lane-labels', type: 'symbol', source: 'editor-graph-edges',
    minzoom: 17, layout: { 'symbol-placement': 'line', 'text-field': ['concat', '№', ['to-string', ['+', ['get', 'laneIndex'], 1]]],
      'text-size': 10, 'text-font': ['Noto Sans Regular'], visibility: 'none',
      'text-allow-overlap': false },
    paint: { 'text-color': '#cdeff2', 'text-halo-color': '#152833', 'text-halo-width': 1 },
  })
  // Hit-testing encompasses the full carriageway even for ten offset lanes.
  map.addLayer({ id: 'editor-road-hit', type: 'line', source: 'editor-roads', paint: {
    'line-width': atZoom(px => ['max', 22, ['+', 15, ['*', ['get', 'lanes'], laneWidthPx(px)]]]),
    'line-opacity': 0,
  } })
  map.addLayer({ id: 'editor-preview-line', type: 'line', source: 'editor-preview', layout: { 'line-cap': 'round' }, paint: {
    'line-color': '#048d83', 'line-width': 4, 'line-dasharray': [2, 1],
  } })
  map.addLayer({ id: 'editor-preview-bridge-line', type: 'line', source: 'editor-preview-bridge', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: {
    'line-color': '#d59552', 'line-width': 5, 'line-opacity': 0.95, 'line-dasharray': [2, 1],
  } })
  map.addLayer({ id: 'editor-crossing-markers', type: 'circle', source: 'editor-crossings', paint: {
    'circle-radius': 8, 'circle-color': ['case', ['==', ['get', 'kind'], 'junction'], '#32a878', '#cd995c'],
    'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2,
  } })
  map.addLayer({ id: 'editor-roundabout-outline', type: 'line', source: 'editor-preview-roundabout', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: {
    'line-color': '#13a89d', 'line-width': 4, 'line-dasharray': [2, 1],
  } })
  map.addLayer({ id: 'editor-roundabout-junctions', type: 'circle', source: 'editor-roundabout-connections', paint: {
    'circle-radius': 6.5, 'circle-color': '#54cb8c', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2,
  } })
  map.addLayer({ id: 'editor-snap-indicator', type: 'circle', source: 'editor-snap', paint: {
    'circle-radius': 5.5, 'circle-color': '#e9fff6', 'circle-stroke-color': '#12847b', 'circle-stroke-width': 2.5,
  } })
  map.addLayer({ id: 'editor-bridge-ends', type: 'circle', source: 'editor-bridge-ends', paint: {
    'circle-radius': 8, 'circle-color': '#ffc66e', 'circle-stroke-color': '#1d2a30', 'circle-stroke-width': 2,
  } })
  map.addLayer({ id: 'editor-junction-arms-line', type: 'line', source: 'editor-junction-arms',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#54d6c9', 'line-width': 4, 'line-opacity': 0.88, 'line-dasharray': [2, 1.3] },
  })
  map.addLayer({ id: 'editor-junction-point', type: 'circle', source: 'editor-junction-preview',
    paint: { 'circle-radius': 7, 'circle-color': '#dffdf3', 'circle-stroke-color': '#168f86', 'circle-stroke-width': 3 },
  })
  map.addLayer({ id: 'editor-preview-bridge-endpoints', type: 'circle', source: 'editor-preview-bridge-ends', paint: {
    'circle-radius': 7, 'circle-color': '#e9b567', 'circle-stroke-color': '#23333d', 'circle-stroke-width': 2,
  } })
  map.addLayer({ id: 'editor-bridge-labels', type: 'symbol', source: 'editor-bridge-ends', layout: {
    'text-field': ['get', 'label'], 'text-size': 11, 'text-offset': [0, -1.8], 'text-anchor': 'bottom', 'text-allow-overlap': true,
  }, paint: { 'text-color': '#fff0d4', 'text-halo-color': '#21313b', 'text-halo-width': 1.5 } })
  // Only the selected road exposes its true editable OSM axis. Lanes and
  // road surfaces may be clipped for display but controls must never be.
  map.addLayer({ id: 'editor-edit-axis', type: 'line', source: 'editor-edit-axis',
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: { 'line-color': '#e7f9ed', 'line-width': 1.6,
      'line-dasharray': [2, 2], 'line-opacity': 0.78 },
  })
  map.addLayer({ id: 'editor-handles-halo', type: 'circle', source: 'editor-handles', paint: {
    'circle-radius': 7, 'circle-color': '#f4faf9', 'circle-stroke-color': '#0f807a', 'circle-stroke-width': 2,
  } })
  // Physical road infrastructure is independent of lane graph visibility.
  map.addLayer({ id: 'editor-infrastructure-line', type: 'line', source: 'editor-infrastructure-lines', minzoom: 14.5,
    layout: { 'line-cap': 'square' },
    paint: { 'line-width': atZoom(px => ['max', 1.2, ['*', ['case', ['get', 'selected'], 0.65, 0.42], px / LANE_WIDTH_METRES, ['get', 'latitudeFactor']]]),
      'line-color': ['case', ['get', 'selected'], '#5ce6d5', '#f9fbfa'],
      'line-opacity': 0.98 },
  })
  map.addLayer({ id: 'editor-infrastructure-line-hit', type: 'line', source: 'editor-infrastructure-lines', minzoom: 14.5,
    paint: { 'line-width': 19, 'line-opacity': 0 },
  })
  map.addLayer({ id: 'editor-infrastructure-point', type: 'symbol', source: 'editor-infrastructure-points', minzoom: 14.5,
    layout: { 'icon-image': ['get', 'icon'],
      'icon-size': ['case', ['get', 'selected'], 1.15, 1],
      'icon-allow-overlap': true, 'icon-ignore-placement': true },
    paint: { 'icon-halo-color': '#6debd6', 'icon-halo-width': ['case', ['get', 'selected'], 3, 0],
      'icon-halo-blur': ['case', ['get', 'selected'], 0.5, 0] },
  })
  redraw()
}

function clearPenDraft(): void {
  draftPoints.value = []
  draftSnapLinks.value = [null, null]
  cursor.value = null
  snapIndicator.value = null
  laneHoverLabel.value = ''
  penCircle.value = false
  freehandSamples = []
  freehandDistancePx = 0
}

function removePenPoint(): void {
  if (!draftPoints.value.length || store.tool !== 'pen') return
  if (store.penMode === 'freehand') {
    // Undo one short stroke, not a single 3px sample.
    freehandSamples = freehandSamples.length <= 2
      ? []
      : freehandSamples.slice(0, Math.max(1, freehandSamples.length - 12))
    draftPoints.value = freehandSamples.map(sample => ({ ...sample.vertex }))
    freehandDistancePx = freehandSamples.reduce((sum, sample, i) => {
      const prev = freehandSamples[i - 1]
      return prev ? sum + Math.hypot(sample.screen.x - prev.screen.x, sample.screen.y - prev.screen.y) : sum
    }, 0)
  } else {
    draftPoints.value.pop()
  }
  draftSnapLinks.value[1] = null
  if (!draftPoints.value.length) draftSnapLinks.value[0] = null
  redrawPreview()
}

function addFreehandPoint(vertex: RoadVertex, screen: { x: number; y: number }, force = false): void {
  const previous = freehandSamples[freehandSamples.length - 1]
  const next = appendFreehandSample(freehandSamples, vertex, screen, 3, force)
  if (next.length === freehandSamples.length && !force) return
  if (previous && next.length > freehandSamples.length) {
    freehandDistancePx += Math.hypot(previous.screen.x - screen.x, previous.screen.y - screen.y)
  }
  freehandSamples = next
  // Bound the number of temporary OSM vertices on a very long stroke.
  if (freehandSamples.length > 1400) {
    freehandSamples = simplifyFreehandSamples(freehandSamples, 2.1)
    if (freehandSamples.length > 1400) {
      freehandSamples = freehandSamples.filter((_, i) => i === 0 || i === freehandSamples.length - 1 || i % 2 === 0)
    }
  }
  draftPoints.value = freehandSamples.map(sample => ({ ...sample.vertex }))
}

function commitPenPath(path: RoadVertex[], links: readonly [TargetLink | null, TargetLink | null]): void {
  try {
    if (store.networkMode === 'pedestrian') {
      store.addPedestrianWay(path, 'footway')
      clearPenDraft()
      redrawPreview()
      return
    }
    const plan = planRoad(
      path, motorRoads(store.roads), currentSnapTolerance(), null,
      [!!links[0], !!links[1]], links,
    )
    if (plan.crossings.length) {
      pendingPlan.value = plan
      planError.value = ''
    } else {
      store.commitRoadPlan(plan)
    }
    clearPenDraft()
    redrawPreview()
  } catch (error) {
    store.notify(error instanceof Error ? error.message : 'Не удалось построить дорогу.')
  }
}

function finishPen(): void {
  if (store.tool !== 'pen' || store.penMode === 'ellipse' || draftPoints.value.length < 2) return
  const path = store.penMode === 'freehand'
    ? simplifyFreehandSamples(freehandSamples).map(sample => ({ ...sample.vertex }))
    : store.penMode === 'curve'
      ? samplePenCurve(draftPoints.value)
      : draftPoints.value.map(point => ({ ...point }))
  commitPenPath(path, draftSnapLinks.value)
}

function onDoubleClickJoint(e: MapMouseEvent): void {
  if (!map || store.tool !== 'select' || store.graphView || !store.selectedRoad) return
  const handle = map.queryRenderedFeatures(e.point, {
    layers: ['editor-handles-halo', 'editor-bridge-ends'],
  })[0]
  const vertexId = handle?.properties?.vertexId
  if (typeof vertexId === 'string') {
    const connectedWays = store.roads.filter(road =>
      road.vertices.some(vertex => vertex.id === vertexId)).length
    if (connectedWays >= 2) {
      e.preventDefault()
      store.disconnectVertex(store.selectedRoad.id, vertexId)
    }
    return
  }
  // Double-click any existing segment of the selected road to add a new
  // draggable control vertex. The road graph is unchanged until it is moved.
  if (store.mode === '3d') return
  const selected = store.selectedRoad
  const candidate = snapToRoad(pointerVertex(e.lngLat.lng, e.lngLat.lat),
    [selected], currentSnapTolerance(), selected.level, selected.level).link
  if (!candidate || candidate.t < 0.02 || candidate.t > 0.98 ||
      distanceMetres(selected.vertices[candidate.segmentIndex]!, candidate.vertex) < 1 ||
      distanceMetres(selected.vertices[candidate.segmentIndex + 1]!, candidate.vertex) < 1) return
  e.preventDefault()
  store.insertRoadVertex(selected.id, candidate.segmentIndex, candidate.vertex)
}

/** Find an object under a visible elevated deck or the normal 2D hit line. */
function roadAtPointer(e: MapMouseEvent): string | null {
  if (!map) return null
  if (store.networkMode !== 'motor' && map.getLayer('editor-pedestrian-hit')) {
    const hits = map.queryRenderedFeatures(e.point, { layers: ['editor-pedestrian-hit'] })
    const id = hits[0]?.properties?.roadId
    if (typeof id === 'string') return id
    if (store.networkMode === 'pedestrian') return null
  }
  if (store.mode === '3d') {
    const elevated = snapElevatedAtScreen(
      e.point, store.roads,
      (lng, lat, height) => roadMesh.projectToScreen(lng, lat, height),
      12,
    )
    if (elevated) return elevated.roadId
  }
  // Hit actual visible stripes first, not the underlying centreline. The
  // latter may be several metres away on 4–10 lane roads. Prefer the current
  // selection in overlapping corridors so Tab never grabs the wrong street.
  const layers = (store.mode === '2d' && map.getLayer('editor-lane-surfaces')
    ? ['editor-lane-surfaces', 'editor-road-hit']
    : ['editor-road-hit'])
  const hits = map.queryRenderedFeatures(e.point, { layers })
  const ids = hits.map(hit => hit.properties?.roadId).filter((id): id is string => typeof id === 'string')
  return ids.includes(store.selectedId ?? '') ? store.selectedId : ids[0] ?? null
}

/** Tab is temporary: it never changes the persistent move-mode toggle. */
function updateMoveCursor(): void {
  if (!map) return
  map.getCanvas().style.cursor = objectDrag?.original && !objectDrag.frozen
    ? 'grabbing'
    : store.tool === 'select' && (store.moveObjectMode || tabMoveHeld.value)
      ? 'grab'
      : store.tool === 'select' ? '' : 'crosshair'
}

function onMoveTabDown(event: KeyboardEvent): void {
  const element = event.target instanceof Element ? event.target : null
  const textEntry = !!element?.closest('input, textarea, select, [contenteditable="true"]')
  const shouldCapture = shouldCaptureMoveTab(event.key, {
    selected: !!store.selectedId,
    tool: store.tool,
    pointerInsideMap,
    textEntry,
    otherModifier: event.shiftKey || event.ctrlKey || event.altKey || event.metaKey,
  })
  if (!shouldCapture) return
  event.preventDefault() // prevents the browser from changing keyboard focus
  if (tabMoveHeld.value) return
  tabMoveHeld.value = true
  scheduleRedraw()
  updateMoveCursor()
}

function onMoveTabUp(event: KeyboardEvent): void {
  if (event.key !== 'Tab' || !tabMoveHeld.value) return
  tabMoveHeld.value = false
  // Freeze motion immediately but leave mouseup responsible for ending the gesture.
  if (objectDrag?.temporary) objectDrag.frozen = true
  scheduleRedraw()
  updateMoveCursor()
}

function onWindowBlur(): void {
  tabMoveHeld.value = false
  if (objectDrag?.temporary) endObjectDrag()
  scheduleRedraw()
  updateMoveCursor()
}

function onMapPointerEnter(): void { pointerInsideMap = true }
function onMapPointerLeave(): void { pointerInsideMap = false }

/** A selected line can be dragged as ONE object; vertex handles retain their own gesture. */
function onMouseDownOnObject(e: MapMouseEvent): void {
  if (!map || store.tool !== 'select' || store.graphView || dragId || objectDrag) return
  if (e.originalEvent.button !== 0) return
  // Ordinary clicks and handle drags remain normal when Tab is not held.
  if (!canBeginObjectMove(store.moveObjectMode, tabMoveHeld.value)) return
  const onHandle = map.queryRenderedFeatures(e.point, { layers: ['editor-handles-halo', 'editor-bridge-ends'] }).length > 0
  const hitId = roadAtPointer(e)
  if (!store.selectedId && !hitId) return
  if (store.selectedId && hitId !== store.selectedId && !onHandle) return
  // Tab + drag can pick a road directly, without a preliminary select click.
  if (!store.selectedId && hitId) store.selectRoad(hitId)
  if (!store.selectedId) return
  objectDrag = {
    roadId: store.selectedId, startLng: e.lngLat.lng, startLat: e.lngLat.lat,
    startX: e.point.x, startY: e.point.y,
    original: null, lastEast: 0, lastNorth: 0,
    temporary: tabMoveHeld.value && !store.moveObjectMode,
    frozen: false,
  }
  e.preventDefault()
  map.dragPan.disable()
  updateMoveCursor()
}

function endObjectDrag(cancelled = false): void {
  if (!objectDrag || !map) return
  if (objectDrag.original && !cancelled) {
    const metres = Math.hypot(objectDrag.lastEast, objectDrag.lastNorth)
    store.notify(`Объект перемещён на ${metres.toFixed(2)} м.`)
    suppressMoveClick = true
    window.setTimeout(() => { suppressMoveClick = false }, 100)
  }
  objectDrag = null
  map.dragPan.enable()
  updateMoveCursor()
}

function onClick(e: MapMouseEvent): void {
  if (!map || dragId || pendingPlan.value || pendingRoundabout.value || pendingJunction.value) return
  if (suppressMoveClick) { suppressMoveClick = false; return }
  // Infrastructure receives clicks before the broad line hit boxes. Editing
  // existing traffic controls must never accidentally select/delete the road.
  if (store.tool === 'select' || store.tool === 'delete') {
    const hits = map.queryRenderedFeatures(e.point, {
      layers: ['editor-infrastructure-point', 'editor-infrastructure-line-hit'],
    })
    const infraId = hits[0]?.properties?.infraId
    if (typeof infraId === 'string') {
      if (store.tool === 'delete') {
        try { store.removeInfrastructure(infraId) } catch (error) { store.notify(String(error)) }
      } else store.selectInfrastructure(infraId)
      return
    }
  }
  if (store.tool === 'walk-route') {
    const nodeId = closestWalkNode(walkGraph, pointerVertex(e.lngLat.lng, e.lngLat.lat), Math.max(10, currentSnapTolerance() * 1.8))
    if (!nodeId) { store.notify('Нет узла пешеходного графа рядом с курсором.'); return }
    if (!walkStart.value || walkEnd.value) {
      walkStart.value = nodeId
      walkEnd.value = null
      walkResult.value = null
      store.notify('Начало маршрута выбрано. Укажите конечный узел.')
    } else {
      walkEnd.value = nodeId
      const route = pedestrianRoute(walkGraph, walkStart.value, nodeId)
      store.notify(route ? `Пешеходный маршрут: ${Math.round(route.metres)} м.` : 'Разрыв пешеходного графа: узлы не соединены.')
    }
    updateSource('editor-pedestrian-route', pedestrianRouteCollection())
    return
  }
  if (store.tool === 'infrastructure') {
    try {
      // Prefer the exact rendered lane under the cursor. This works in 2D and
      // 3D, including raised bridge decks, and avoids snapping to a parallel
      // carriageway at junctions. In 2D prefer the ground level explicitly.
      const laneTarget = laneTargetAtPointer(e, store.roads, store.mode === '2d' ? 0 : null)
      const screenTarget = laneTarget ?? (store.mode === '3d'
        ? elevatedScreenTarget(e, visibleRoads.length ? visibleRoads : store.roads)
        : null)
      const preferredRoadId = screenTarget?.roadId ?? roadAtPointer(e) ?? undefined
      const at = screenTarget?.vertex ?? pointerVertex(e.lngLat.lng, e.lngLat.lat)
      store.placeInfrastructure(at, Math.max(12, currentSnapTolerance()), screenTarget ?? undefined, preferredRoadId)
    } catch (error) {
      store.notify(error instanceof Error ? error.message : 'Нельзя разместить объект здесь.')
    }
    return
  }
  if (
    store.tool === 'select' &&
    map.getLayer('editor-handles-halo') &&
    map.queryRenderedFeatures(e.point, {
      layers: ['editor-handles-halo', 'editor-bridge-ends'],
    }).length > 0
  ) {
    return
  }
  if (store.tool === 'select' && store.graphView && store.mode === '2d') {
    const features = map.queryRenderedFeatures(e.point, { layers: ['editor-graph-nodes', 'editor-graph-lanes'] })
    const selected = features[0]?.properties
    if (selected && typeof selected.roadId === 'string' && Number.isInteger(Number(selected.laneIndex))) {
      store.selectGraphLane(selected.roadId, Number(selected.laneIndex))
      return
    }
  }
  if (store.tool === 'delete' || store.tool === 'select') {
    const roadId = roadAtPointer(e) ?? undefined
    if (store.tool === 'delete' && roadId) store.removeRoad(roadId)
    else if (store.tool === 'select') store.selectRoad(roadId ?? null)
    return
  }
  if (store.tool === 'junction') {
    if (store.mode !== '2d') {
      store.notify('Перекрёстки создаются в 2D. Переключитесь на 2D для выбора точного пересечения.')
      return
    }
    try {
      const at = pointerVertex(e.lngLat.lng, e.lngLat.lat)
      const nearby = visibleRoads.length ? visibleRoads : store.roads
      const preview = store.prepareJunction(at, nearby, Math.min(18, currentSnapTolerance()))
      pendingJunction.value = preview
      junctionRevision = store.geometryRevision
      junctionError.value = ''
      redrawPreview()
    } catch (error) {
      store.notify(error instanceof Error ? error.message : 'Здесь нельзя создать перекрёсток.')
    }
    return
  }
  if (store.tool === 'pen') {
    if (store.penMode === 'ellipse' && store.networkMode !== 'pedestrian') {
      // Original pen ellipse: centre -> major axis -> minor axis; Shift => exact circle.
      const point = pointerVertex(e.lngLat.lng, e.lngLat.lat)
      if (draftPoints.value.length < 2) {
        draftPoints.value.push(point)
      } else {
        try {
          const ring = samplePenEllipse(
            draftPoints.value[0]!, draftPoints.value[1]!, point, e.originalEvent.shiftKey,
          )
          // Restore the original roundabout topology when the pen circle / oval
          // is drawn across an existing ground intersection. An isolated ring
          // remains an ordinary, editable closed road.
          const center = draftPoints.value[0]!
          const axisPoint = draftPoints.value[1]!
          const roundabout = store.preparePenRoundabout(
            center, axisPoint, point, e.originalEvent.shiftKey,
          )
          if (roundabout) {
            pendingRoundabout.value = roundabout
            roundaboutError.value = ''
            clearPenDraft()
          } else {
            commitPenPath(ring, [null, null])
          }
        } catch (error) {
          store.notify(error instanceof Error ? error.message : 'Не удалось создать овал.')
        }
      }
      redrawPreview()
      return
    }

    if (store.penMode === 'freehand') {
      const candidate = penCandidate(
        e.lngLat.lng, e.lngLat.lat, e.originalEvent.altKey, e,
      )
      if (!freehandSamples.length) {
        // One click begins tracing. No need to hold down the mouse button.
        draftSnapLinks.value = [candidate.link, null]
        addFreehandPoint(candidate.vertex, e.point)
      } else {
        // The second click closes the stroke at its exact position/snap target.
        addFreehandPoint(candidate.vertex, e.point, true)
        if (freehandSamples.length > 1) {
          draftSnapLinks.value[1] = candidate.link
          finishPen()
        }
      }
      cursor.value = candidate.vertex
      snapIndicator.value = candidate.snapped ? candidate.vertex : null
      redrawPreview()
      return
    }

    const candidate = penCandidate(
      e.lngLat.lng, e.lngLat.lat, e.originalEvent.altKey, e,
    )
    const first = draftPoints.value.length === 0
    if (first) draftSnapLinks.value[0] = candidate.link
    draftPoints.value.push(candidate.vertex)
    draftSnapLinks.value[1] = candidate.link

    // Clicking an existing road closes the pen path, not merely the current segment.
    if (!first && candidate.link) finishPen()
    redrawPreview()
    return
  }

  if (store.tool === 'roundabout') {
    if (!roundaboutCenter.value) {
      roundaboutCenter.value = pointerVertex(e.lngLat.lng, e.lngLat.lat)
      cursor.value = null
      roundaboutError.value = ''
    } else {
      const radius = distanceMetres(roundaboutCenter.value, pointerVertex(e.lngLat.lng, e.lngLat.lat))
      try {
        pendingRoundabout.value = store.prepareRoundabout(roundaboutCenter.value, radius)
        roundaboutError.value = ''
      } catch (error) {
        roundaboutError.value = error instanceof Error ? error.message : 'Нельзя создать круговое движение.'
        store.notify(roundaboutError.value)
      }
    }
    redrawPreview()
    return
  }
}

function onMove(e: MapMouseEvent): void {
  if (pendingPlan.value || pendingRoundabout.value || pendingJunction.value) return

  if (objectDrag) {
    const drag = objectDrag
    // Releasing Tab immediately freezes a temporary move, even if the mouse
    // keeps moving before mouseup. The next mouseup ends the transaction.
    if (drag.frozen) return
    const distancePx = Math.hypot(e.point.x - drag.startX, e.point.y - drag.startY)
    if (!drag.original && distancePx < 3) return
    if (!drag.original) {
      drag.original = store.startRoadDrag(drag.roadId)
      if (!drag.original) { endObjectDrag(); return }
    }
    try {
      const delta = cursorOffsetMetres(
        { lng: drag.startLng, lat: drag.startLat },
        { lng: e.lngLat.lng, lat: e.lngLat.lat },
      )
      store.updateRoadDrag(drag.roadId, drag.original, delta.east, delta.north)
      drag.lastEast = delta.east
      drag.lastNorth = delta.north
      map?.getCanvas().style.setProperty('cursor', 'grabbing')
    } catch (error) {
      store.notify(error instanceof Error ? error.message : 'Ошибка перемещения.')
      store.undo()
      endObjectDrag(true)
    }
    return
  }

  if (dragId) {
    if (!dragged) store.startVertexDrag()
    dragged = true

    lastDragRaw = pointerVertex(
      e.lngLat.lng,
      e.lngLat.lat,
    )

    // Alt отключает автопривязку.
    dragSnap = e.originalEvent.altKey
      ? null
      : draggedEndpointSnap(lastDragRaw, e)

    const position = dragSnap?.laneAttachment?.visibleVertex ?? dragSnap?.vertex ?? lastDragRaw

    if (dragRoadId) {
      dragId = store.updateDraggedVertex(dragRoadId, dragId, position.lng, position.lat)
    }

    snapIndicator.value = dragSnap?.laneAttachment?.visibleVertex ?? dragSnap?.vertex ?? null
    redrawPreview()
    return
  }

  if (store.tool === 'pen') {
    penCircle.value = e.originalEvent.shiftKey
    const candidate = store.penMode === 'ellipse'
      ? { vertex: pointerVertex(e.lngLat.lng, e.lngLat.lat), snapped: false, link: null }
      : penCandidate(e.lngLat.lng, e.lngLat.lat, e.originalEvent.altKey, e)
    cursor.value = candidate.vertex
    snapIndicator.value = candidate.snapped ? candidate.vertex : null
    const lane = candidate.link?.laneAttachment
    laneHoverLabel.value = lane
      ? `${lane.boundary ? 'Граница' : 'Полоса'} ${lane.laneIndex + 1}/${lane.laneCount} · стыковка с дорогой`
      : ''

    if (store.penMode === 'freehand' && freehandSamples.length) {
      if (candidate.link && freehandDistancePx >= 30 && freehandSamples.length >= 3) {
        // Reaching an existing road automatically finishes the freehand stroke.
        addFreehandPoint(candidate.vertex, e.point, true)
        draftSnapLinks.value[1] = candidate.link
        finishPen()
      } else {
        // Real cursor trajectory: sample movement, do not snap intermediate nodes.
        addFreehandPoint(pointerVertex(e.lngLat.lng, e.lngLat.lat), e.point)
      }
    }
    redrawPreview()
    return
  }

  if (store.tool === 'roundabout' && roundaboutCenter.value) {
    cursor.value = pointerVertex(e.lngLat.lng, e.lngLat.lat)
    redrawPreview()
    return
  }


}

function onMouseDownOnHandle(e: MapLayerMouseEvent): void {
  if (!map || store.tool !== 'select' || store.graphView || objectDrag || store.moveObjectMode || tabMoveHeld.value) return

  const id = e.features?.[0]?.properties?.vertexId
  if (typeof id !== 'string') return

  e.preventDefault()

  dragId = id
  dragRoadId = store.selectedId
  dragged = false

  dragIsEndpoint =
    store.selectedRoad?.vertices[0]?.id === id ||
    store.selectedRoad?.vertices[
      store.selectedRoad.vertices.length - 1
    ]?.id === id

  dragSnap = null
  lastDragRaw = null

  map.dragPan.disable()
  map.getCanvas().style.cursor = 'grabbing'
}

/** Resolve the final release position, including a release delivered by window.
 * Do not trust a snap calculated for the previous mousemove event. */
function releasedMapPointer(event?: MapMouseEvent | MouseEvent): MapMouseEvent | null {
  if (!map || !event) return null
  if ('originalEvent' in event) return event
  const canvas = map.getCanvas()
  const bounds = canvas.getBoundingClientRect()
  const x = event.clientX - bounds.left
  const y = event.clientY - bounds.top
  if (x < 0 || y < 0 || x > bounds.width || y > bounds.height) return null
  const lngLat = map.unproject([x, y])
  return { point: { x, y }, lngLat, originalEvent: event } as MapMouseEvent
}

function onMouseUp(event?: MapMouseEvent | MouseEvent): void {
  if (objectDrag) { endObjectDrag(); return }
  if (!dragId || !map) return

  const id = dragId

  const released = dragged ? releasedMapPointer(event) : null
  if (released) {
    lastDragRaw = pointerVertex(released.lngLat.lng, released.lngLat.lat)
    dragSnap = released.originalEvent.altKey
      ? null
      : draggedEndpointSnap(lastDragRaw, released)
  }

  const altHeld = event
    ? ('originalEvent' in event
        ? event.originalEvent.altKey
        : event.altKey)
    : false

  if (dragged) {
    if (altHeld && lastDragRaw) {
      // Свободное перемещение без соединения.
      store.updateVertex(
        id,
        lastDragRaw.lng,
        lastDragRaw.lat,
      )
    } else if (dragSnap) {
      try {
        // Присваиваем общий OSM ID и вставляем узел в целевую дорогу.
        store.attachDraggedEndpoint(id, dragSnap)
      } catch (error) {
        if (lastDragRaw) {
          store.updateVertex(
            id,
            lastDragRaw.lng,
            lastDragRaw.lat,
          )
        }

        store.notify(
          error instanceof Error
            ? error.message
            : 'Не удалось соединить дороги.',
        )
      }
    } else {
      // Last pointer position may differ from the previous mousemove. Do not
      // leave the endpoint visually over a lane unless a connection was made.
      if (lastDragRaw) store.updateVertex(id, lastDragRaw.lng, lastDragRaw.lat)
      store.notify('Геометрия дороги обновлена.')
    }
  }

  dragId = null
  dragRoadId = null
  dragIsEndpoint = false
  dragSnap = null
  lastDragRaw = null
  snapIndicator.value = null

  map.dragPan.enable()
  updateMoveCursor()
  redrawPreview()
}

function onEscape(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  if (target?.closest('input, select, textarea, [contenteditable="true"]')) return
  if (store.tool === 'pen' && event.key === 'Enter') {
    event.preventDefault()
    finishPen()
    return
  }
  if (store.tool === 'pen' && event.key === 'Backspace') {
    event.preventDefault()
    removePenPoint()
    return
  }
  if (event.key !== 'Escape') return
  if (store.tool === 'infrastructure') {
    event.preventDefault()
    store.setTool('select')
    store.notify('Режим размещения инфраструктуры завершён.')
    return
  }
  if (objectDrag) {
    event.preventDefault()
    const wasMoved = !!objectDrag.original
    endObjectDrag(true)
    if (wasMoved) store.undo()
    return
  }
  if (pendingPlan.value || pendingRoundabout.value || pendingJunction.value || roundaboutCenter.value || draftPoints.value.length > 0) {
    event.preventDefault()
    cancelPending()
  }
}

function fitToRoads(): void {
  if (!map) return
  // Linear pass; never spread thousands of coordinate arguments into Math.min.
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity
  for (const road of store.roads) for (const point of road.vertices) {
    west = Math.min(west, point.lng)
    east = Math.max(east, point.lng)
    south = Math.min(south, point.lat)
    north = Math.max(north, point.lat)
  }
  if (!Number.isFinite(west)) return
  map.fitBounds([[west, south], [east, north]], { padding: 70, maxZoom: 17, duration: 0 })
  if (map.getZoom() < 13.1) map.setZoom(13.1)
}

function focusRoad(roadId: string): void {
  const road = store.roads.find(item => item.id === roadId)
  if (!road || !map || road.vertices.length < 2) return
  if (store.networkMode === 'pedestrian') store.setNetworkMode('motor')
  if (store.mode !== '2d') store.mode = '2d'
  if (store.graphView) store.graphView = false
  store.selectRoad(roadId)
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity
  for (const vertex of road.vertices) {
    west = Math.min(west, vertex.lng); east = Math.max(east, vertex.lng)
    south = Math.min(south, vertex.lat); north = Math.max(north, vertex.lat)
  }
  const centre: [number, number] = [(west + east) / 2, (south + north) / 2]
  if (east - west < 0.000025 && north - south < 0.000025) {
    map.easeTo({ center: centre, zoom: 17.2, duration: 550 })
  } else {
    map.fitBounds([[west, south], [east, north]], { padding: 100, maxZoom: 17.5, duration: 650 })
  }
}

defineExpose({ focusRoad })

function activateNetwork(mode: NetworkMode): void {
  store.setNetworkMode(mode)
  // Do not depend solely on watchers or MapLibre's cached layout state.
  // The current click empties the other graph's sources immediately.
  if (map?.getSource('editor-roads')) {
    for (const sourceId of [
      'editor-roads', 'editor-lanes', 'editor-lane-border-lines',
      'editor-road-status', 'editor-road-markings', 'editor-turn-arrows', 'editor-analysis-issues',
      'editor-graph-edges', 'editor-graph-nodes', 'editor-graph-connections',
      'editor-bridge-ends', 'editor-pedestrian-edges',
      'editor-pedestrian-surfaces', 'editor-pedestrian-nodes',
      'editor-pedestrian-portals', 'editor-pedestrian-route',
      'editor-crosswalk-stripes',
    ]) {
      if (!networkSourceVisible(sourceId, mode)) {
        const source = map.getSource(sourceId) as GeoJSONSource | undefined
        source?.setData(emptyCollection())
      }
    }
    redraw()
    map.triggerRepaint()
  }
}

onMounted(() => {
  if (!mapRoot.value) return
  map = new Map({ container: mapRoot.value, style: MAP_STYLE, center: [104.2882, 52.2847], zoom: 15.6, maxPitch: 80, pixelRatio: Math.min(window.devicePixelRatio || 1, 1.5), fadeDuration: 0, canvasContextAttributes: { antialias: false } })
  sizeObserver = new ResizeObserver(() => map?.resize())
  sizeObserver.observe(mapRoot.value)
  if (store.tool === 'pen') map.doubleClickZoom.disable()
  map.getCanvas().addEventListener('mouseenter', onMapPointerEnter)
  map.getCanvas().addEventListener('mouseleave', onMapPointerLeave)
  map.addControl(new NavigationControl({ visualizePitch: true }), 'bottom-right')
  map.addControl(new ScaleControl({ maxWidth: 130, unit: 'metric' }), 'bottom-left')
  map.on('style.load', installLayers)
  map.on('click', onClick)
  map.on('dblclick', onDoubleClickJoint)
  map.on('mousemove', onMove)
  map.on('moveend', scheduleRedraw)
  map.on('mousedown', onMouseDownOnObject)
  map.on('mouseup', onMouseUp)
  map.on('mousedown', 'editor-handles-halo', onMouseDownOnHandle)
  map.on('mousedown', 'editor-bridge-ends', onMouseDownOnHandle)
  window.addEventListener('keydown', onMoveTabDown, true)
  window.addEventListener('keyup', onMoveTabUp, true)
  window.addEventListener('blur', onWindowBlur)
  window.addEventListener('keydown', onEscape)
  window.addEventListener('mouseup', onMouseUp)
})

watch(() => store.roadRenderRevision, scheduleRedraw)
watch(() => store.roadAnalysisRevision, scheduleRedraw)
watch(() => store.roadAnalysisVisible, scheduleRedraw)
watch(() => store.roadOverlayRevision, scheduleRedraw)
watch(() => store.infrastructureRevision, scheduleRedraw)
watch(() => store.geometryRevision, scheduleRedraw)
watch(() => store.selectedInfrastructureId, scheduleRedraw)
watch(() => store.graphView, scheduleRedraw)
watch(() => store.networkMode, () => {
  walkStart.value = null
  walkEnd.value = null
  walkResult.value = null
  clearPenDraft()
  if (store.penMode === 'ellipse' && store.networkMode === 'pedestrian') store.penMode = 'draw'
  scheduleRedraw()
})
watch(() => store.selectedGraphLane, scheduleRedraw)
watch(() => store.selectedId, () => {
  if (objectDrag && objectDrag.roadId !== store.selectedId) endObjectDrag()
  scheduleRedraw()
  updateMoveCursor()
})
watch(() => store.moveObjectMode, () => {
  scheduleRedraw()
  updateMoveCursor()
})
watch(() => store.mode, (mode) => {
  map?.easeTo({ pitch: mode === '3d' ? 62 : 0, bearing: mode === '3d' ? -19 : 0, duration: 600 })
  scheduleRedraw()
})
watch(() => store.tool, () => {
  if (objectDrag) endObjectDrag()
  tabMoveHeld.value = false
  clearPenDraft()
  roundaboutCenter.value = null
  pendingRoundabout.value = null
  pendingJunction.value = null
  junctionError.value = ''
  roundaboutError.value = ''
  redrawPreview()
  if (map) {
    updateMoveCursor()
    if (store.tool === 'pen') map.doubleClickZoom.disable()
    else map.doubleClickZoom.enable()
  }
  scheduleRedraw()
})
watch(() => store.penMode, () => {
  if (store.tool !== 'pen') return
  clearPenDraft()
  redrawPreview()
})
watch(() => store.projectName, () => { window.setTimeout(fitToRoads, 100) })
onBeforeUnmount(() => {
  if (objectDrag) endObjectDrag()
  tabMoveHeld.value = false
  if (map) {
    map.getCanvas().removeEventListener('mouseenter', onMapPointerEnter)
    map.getCanvas().removeEventListener('mouseleave', onMapPointerLeave)
  }
  window.removeEventListener('keydown', onMoveTabDown, true)
  window.removeEventListener('keyup', onMoveTabUp, true)
  window.removeEventListener('blur', onWindowBlur)
  window.removeEventListener('keydown', onEscape)
  window.removeEventListener('mouseup', onMouseUp)
  backgroundTransportLines.clear()
  sizeObserver?.disconnect()
  sizeObserver = null
  if (previewFrame) cancelAnimationFrame(previewFrame)
  if (drawFrame) cancelAnimationFrame(drawFrame)
  if (drawTimer !== null) window.clearTimeout(drawTimer)
  map?.remove()
  map = null
})
</script>

<template>
  <div class="map-root" ref="mapRoot"></div>
  <div class="basemap-switcher" role="group" aria-label="Подложка карты">
    <button type="button" :class="{ active: basemapMode === 'map' }" :aria-pressed="basemapMode === 'map'" @click="setBasemap('map')">Карта</button>
    <button type="button" :class="{ active: basemapMode === 'satellite' }" :aria-pressed="basemapMode === 'satellite'" @click="setBasemap('satellite')">Спутник</button>
  </div>
  <div class="network-switcher" role="group" aria-label="Активный граф сети" :data-active-mode="store.networkMode" @pointerdown.stop @mousedown.stop @dblclick.stop>
    <span class="network-title" aria-live="polite">{{ store.networkMode === 'motor' ? 'АВТО' : store.networkMode === 'pedestrian' ? 'ПЕШЕХОДЫ' : 'ОБЕ СЕТИ' }}</span>
    <button type="button" :class="{ active: store.networkMode === 'motor' }" :aria-pressed="store.networkMode === 'motor'" @click.stop="activateNetwork('motor')">Авто <small>{{ store.motorRoadCount }}</small></button>
    <button type="button" :class="{ active: store.networkMode === 'pedestrian' }" :aria-pressed="store.networkMode === 'pedestrian'" @click.stop="activateNetwork('pedestrian')">Пешеходы <small>{{ store.walkWayCount }}</small></button>
    <button type="button" :class="{ active: store.networkMode === 'all' }" :aria-pressed="store.networkMode === 'all'" @click.stop="activateNetwork('all')">Обе сети</button>
  </div>
  <div v-if="store.networkMode !== 'pedestrian'" class="road-status-legend" aria-label="Статус дорог">
    <span class="road-status-legend-title">СТАТУС ДОРОГ</span>
    <span class="road-status-legend-item"><i class="status-swatch imported"></i> Из OSM <b>{{ store.roadStatusCounts.imported }}</b></span>
    <span class="road-status-legend-item"><i class="status-swatch created"></i> Новые <b>{{ store.roadStatusCounts.created }}</b></span>
    <span class="road-status-legend-item"><i class="status-swatch modified"></i> Изменены <b>{{ store.roadStatusCounts.modified }}</b></span>
    <span v-if="store.bridgeCount" class="road-status-legend-item" title="Дороги с тегом bridge=yes">
      <i class="status-swatch bridge"></i> Мосты (bridge=yes) <b>{{ store.bridgeCount }}</b>
    </span>
  </div>
  <div v-if="store.networkMode !== 'motor'" class="pedestrian-legend" aria-label="Пешеходный граф">
    <strong>ПЕШЕХОДНАЯ СЕТЬ</strong>
    <span><i class="walk-key walk-key-real"></i> Дорожка из OSM</span>
    <span><i class="walk-key walk-key-inferred"></i> Тротуар (тег sidewalk)</span>
    <span><i class="walk-key walk-key-tunnel"></i> Подземный переход (OSM tunnel / layer=-1)</span>
    <span><i class="walk-key walk-key-zebra"></i> Переход из OSM*</span>
    <small>↧ — вход в подземный участок. Подземные пути показаны условно и не создают новых соединений.</small>
    <small>* Без тега разметки — условное отображение</small>
  </div>
  <div v-if="store.tool === 'walk-route'" class="walk-route-overlay">
    <strong>Пешеходный маршрут</strong>
    <span>{{ !walkStart ? 'Укажите начало на пешеходной дорожке' : !walkEnd ? 'Укажите конец маршрута' :
      walkResult?.reachable ? `Маршрут найден: ${Math.round(walkResult.metres)} м` : 'Нет связи между выбранными узлами' }}</span>
    <button type="button" @click="walkStart = null; walkEnd = null; walkResult = null; updateSource('editor-pedestrian-route', pedestrianRouteCollection())">Сбросить</button>
  </div>
  <div v-if="store.graphView && store.mode === '2d' && store.networkMode === 'motor'" class="graph-legend" aria-label="Граф полос">
    <span class="graph-legend-title">ГРАФ ПОЛОС</span>
    <span><i class="graph-line-key"></i> Полосы</span>
    <span><i class="graph-node-key"></i> Узлы</span>
    <span><i class="graph-link-key"></i> Связи</span>
  </div>
  <div v-if="store.tool === 'select' && store.selectedId" class="move-key-overlay" :class="{ active: tabMoveHeld || store.moveObjectMode }">
    <kbd>Tab</kbd> {{ tabMoveHeld ? 'Перемещайте объект мышью · отпустите Tab для выхода' : store.moveObjectMode ? 'Режим перемещения включён' : 'Удерживайте Tab и тяните объект целиком' }}
  </div>
  <div v-if="store.tool === 'infrastructure'" class="junction-mode-label">
    {{ store.infraRelocationId ? 'Перенос дорожного объекта · выберите новую точку дороги' :
       store.infraKind === 'traffic_signal' ? 'Светофор · кликните по дороге' :
       store.infraKind === 'stop' ? 'STOP · кликните по дороге' :
       store.infraKind === 'give_way' ? 'Уступи дорогу · кликните по дороге' :
       store.infraKind === 'crossing' ? 'Пешеходный переход · кликните по дороге' :
       'Стоп-линия · кликните поперёк дороги' }} · Esc — завершить
  </div>
  <div v-if="store.tool === 'junction' && !pendingJunction" class="junction-mode-label">
    Перекрёсток · клик по пересечению наземных дорог
  </div>
  <div v-if="store.tool === 'pen'" class="pen-overlay">
    <span v-if="store.penMode === 'ellipse' && store.networkMode !== 'pedestrian'" class="pen-help">
      {{ draftPoints.length === 0 ? 'Клик: центр круга / овала' : draftPoints.length === 1 ? 'Клик: радиус и направление' : 'Клик: ширина овала · Shift — точный круг' }}
    </span>
    <span v-else-if="store.penMode === 'freehand'" class="pen-help">
      {{ !draftPoints.length ? 'Один клик — начать свободную руку' : `Ведите мышь · ${draftPoints.length} точек · второй клик или дорога — завершить` }}
    </span>
    <span v-else class="pen-help">
      {{ !draftPoints.length ? 'Кликните на карте, чтобы начать' : `Точек: ${draftPoints.length} · клик — продолжить · дорога — завершить` }}
    </span>
    <span v-if="laneHoverLabel" class="pen-help">{{ laneHoverLabel }}</span>
    <button v-if="draftPoints.length" type="button" class="pen-action subtle" @click="removePenPoint">{{ store.penMode === 'freehand' ? 'Шаг назад' : 'Назад' }}</button>
    <button v-if="draftPoints.length" type="button" class="pen-action subtle" @click="cancelPending">Отмена</button>
    <button v-if="store.penMode !== 'ellipse'" type="button" class="pen-action primary" :disabled="draftPoints.length < 2" @click="finishPen">
      Конец ↵
    </button>
  </div>
  <div v-if="pendingPlan" class="crossing-panel" role="dialog" aria-label="Подтверждение пересечений">
    <div class="crossing-panel-header">
      <strong>Пересечения дорог</strong>
      <span>{{ pendingPlan.crossings.length }}</span>
    </div>
    <div class="crossing-panel-content">
      <div v-for="(crossing, index) in pendingPlan.crossings" :key="crossing.id" class="crossing-row">
        <div class="crossing-label"><span>{{ index + 1 }}. {{ crossing.targetName }}</span><small>Уровень существующей дороги: {{ crossing.targetLevel > 0 ? '+' : '' }}{{ crossing.targetLevel }}</small></div>
        <select :value="crossing.kind" :aria-label="`Тип пересечения ${index + 1}`" @change="setCrossingKind(crossing.id, ($event.target as HTMLSelectElement).value as CrossingKind)">
          <option value="bridge">Мост +{{ crossing.bridgeLevel }}</option>
          <option value="junction" :disabled="crossing.targetLevel !== 0">Перекрёсток</option>
        </select>
        <div v-if="crossing.kind === 'bridge'" class="bridge-boundary-edit">
          <label>Начало моста, м
            <input type="number" step="1" min="0" :max="pendingPlan.totalLength" :value="Math.round(crossing.bridgeFrom)" @input="setBridgeBoundary(crossing.id, 'bridgeFrom', Number(($event.target as HTMLInputElement).value))" />
          </label>
          <label>Конец моста, м
            <input type="number" step="1" min="0" :max="pendingPlan.totalLength" :value="Math.round(crossing.bridgeTo)" @input="setBridgeBoundary(crossing.id, 'bridgeTo', Number(($event.target as HTMLInputElement).value))" />
          </label>
        </div>
      </div>
      <p v-if="planError" class="crossing-error">{{ planError }}</p>
    </div>
    <div class="crossing-panel-actions">
      <button type="button" class="crossing-cancel" @click="cancelPending">Отмена</button>
      <button type="button" class="crossing-confirm" @click="confirmPending">Создать дорогу</button>
    </div>
  </div>
  <div v-if="pendingJunction" class="crossing-panel" role="dialog" aria-label="Создание перекрёстка">
    <div class="crossing-panel-header">
      <strong>Перекрёсток</strong>
      <span>{{ pendingJunction.armCount }} подхода</span>
    </div>
    <div class="crossing-panel-content">
      <div class="roundabout-fields">
        <div class="roundabout-stats"><span>Соединяемых дорог</span><strong>{{ pendingJunction.roadIds.length }}</strong></div>
        <div v-for="id in pendingJunction.roadIds" :key="id" class="junction-road-name">
          {{ store.roads.find(road => road.id === id)?.name || store.roads.find(road => road.id === id)?.highway || id }}
        </div>
        <p v-if="junctionError" class="crossing-error">{{ junctionError }}</p>
      </div>
    </div>
    <div class="crossing-panel-actions">
      <button type="button" @click="cancelPending">Отмена</button>
      <button type="button" class="crossing-confirm" :disabled="!!junctionError" @click="confirmJunction">Соединить</button>
    </div>
  </div>
  <div v-if="pendingRoundabout" class="crossing-panel" role="dialog" aria-label="Круговое движение">
    <div class="crossing-panel-header">
      <strong>Круговое движение</strong>
      <span>{{ pendingRoundabout.connectionCount }} примыканий</span>
    </div>
    <div class="crossing-panel-content">
      <div class="roundabout-fields">
        <template v-if="pendingRoundabout.ellipse">
          <span>Овальное круговое движение</span>
          <strong>{{ Math.round(pendingRoundabout.ellipse.majorMetres * 2) }} × {{ Math.round(pendingRoundabout.ellipse.minorMetres * 2) }} м</strong>
        </template>
        <template v-else>
          <label for="roundabout-radius">Радиус, м</label>
          <input id="roundabout-radius" type="number" :min="MIN_ROUNDABOUT_RADIUS" :max="MAX_ROUNDABOUT_RADIUS" step="1"
            :value="Math.round(pendingRoundabout.radiusMetres)" @change="updateRoundaboutRadius" />
        </template>
        <div class="roundabout-stats"><span>Изменяемых улиц</span><strong>{{ pendingRoundabout.affectedRoadIds.length }}</strong></div>
      </div>
      <p v-if="roundaboutError" class="crossing-error">{{ roundaboutError }}</p>
    </div>
    <div class="crossing-panel-actions">
      <button type="button" class="crossing-cancel" @click="cancelPending">Отмена</button>
      <button type="button" class="crossing-confirm" :disabled="!!roundaboutError" @click="confirmRoundabout">Создать</button>
    </div>
  </div>
</template>
