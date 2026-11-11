/** Keep editor graphs distinct from OpenFreeMap's background road lines. */
export type NetworkMode = 'motor' | 'pedestrian' | 'all'
export type StyleLayerDescriptor = { id: string; type: string; 'source-layer'?: string }

/** Basemap transport geometry (lines and road polygons), never buildings or labels. */
export function isBackgroundTransportLine(layer: StyleLayerDescriptor): boolean {
  if (layer.id.startsWith('editor-') || (layer.type !== 'line' && layer.type !== 'fill')) return false
  const sourceLayer = layer['source-layer'] ?? ''
  if (sourceLayer === 'transportation' || sourceLayer === 'transportation_line') return true
  return /(?:road|street|highway|motorway|trunk|path|footway|transportation)/i.test(layer.id) &&
    !/(?:label|name|text|boundary|admin)/i.test(layer.id)
}

export function graphVisibility(mode: NetworkMode): { motor: boolean; pedestrian: boolean } {
  return { motor: mode !== 'pedestrian', pedestrian: mode !== 'motor' }
}


/** All MapLibre overlays belonging to each editable graph. Keep this list
 * centralized: toggling the mode must not leave behind road fills, zebra
 * stripes, hidden hit targets or selected lane-graph decorations. */
export const MOTOR_LAYER_IDS = [
  'editor-road-outline', 'editor-road-line', 'editor-road-hit',
  'editor-analysis-issues-halo', 'editor-analysis-issues',
  'editor-analysis-issue-points-halo', 'editor-analysis-issue-points',
  'editor-lane-borders', 'editor-lane-surfaces', 'editor-road-status-edges',
  'editor-road-marking-solid', 'editor-road-marking-dashed',
  'editor-turn-arrows-layer', 'editor-bridge-ends', 'editor-bridge-labels',
] as const

export const WALK_LAYER_IDS = [
  'editor-pedestrian-curbs', 'editor-pedestrian-path-halo',
  'editor-pedestrian-paths', 'editor-pedestrian-inferred',
  'editor-pedestrian-tunnel-halo', 'editor-pedestrian-tunnels',
  'editor-pedestrian-portals-layer', 'editor-pedestrian-junctions',
  'editor-pedestrian-hit', 'editor-pedestrian-route-line',
  'editor-zebra-stripes',
] as const

export const LANE_GRAPH_LAYER_IDS = [
  'editor-graph-lanes', 'editor-graph-nodes', 'editor-graph-links',
  'editor-graph-lane-labels',
] as const

/** A layer visibility flag alone is not enough: MapLibre can restore a style
 * after tiles/styles reload, and invisible hit layers must not contain stale
 * data. These groups gate the actual GeoJSON source content as well. */
export const MOTOR_SOURCE_IDS = [
  'editor-roads', 'editor-lanes', 'editor-lane-border-lines',
  'editor-road-status', 'editor-road-markings', 'editor-turn-arrows', 'editor-analysis-issues',
  'editor-graph-edges', 'editor-graph-nodes', 'editor-graph-connections',
  'editor-bridge-ends',
] as const

export const WALK_SOURCE_IDS = [
  'editor-pedestrian-edges', 'editor-pedestrian-surfaces',
  'editor-pedestrian-nodes', 'editor-pedestrian-portals',
  'editor-pedestrian-route', 'editor-crosswalk-stripes',
] as const

/** Return false when a GeoJSON source must be *empty*, not merely hidden. */
export function networkSourceVisible(id: string, mode: NetworkMode): boolean {
  const visible = graphVisibility(mode)
  if ((MOTOR_SOURCE_IDS as readonly string[]).includes(id)) return visible.motor
  if ((WALK_SOURCE_IDS as readonly string[]).includes(id)) return visible.pedestrian
  return true // shared edit/previews and filtered sign/STOP data
}

/** Once an OSM project is loaded, the basemap must not add a duplicate road
 * or path graph. This applies to ALL three modes (not only pedestrians).
 * Cartographic buildings, parks, labels, and the imagery stay visible. */
export function basemapTransportVisibility(
  osmLoaded: boolean,
  original: 'visible' | 'none',
): 'visible' | 'none' {
  return osmLoaded ? 'none' : original
}

/** A tiny map facade allows unit tests without constructing a WebGL map. */
export interface LayerVisibilityMap {
  getLayer(id: string): unknown
  getLayoutProperty(id: string, property: string): unknown
  setLayoutProperty(id: string, property: string, value: string): unknown
}

export function networkLayerVisibility(
  id: string,
  mode: NetworkMode,
  viewMode: '2d' | '3d',
  showLaneGraph: boolean,
): 'visible' | 'none' {
  const { motor, pedestrian } = graphVisibility(mode)
  const is3d = viewMode === '3d'
  if ((MOTOR_LAYER_IDS as readonly string[]).includes(id)) {
    if (!motor) return 'none'
    // The solid lane surfaces and status outlines are drawn in the 3D mesh.
    if (is3d && ['editor-lane-borders', 'editor-lane-surfaces', 'editor-road-status-edges',
      'editor-analysis-issues-halo', 'editor-analysis-issues',
      'editor-analysis-issue-points-halo', 'editor-analysis-issue-points'].includes(id)) return 'none'
    return 'visible'
  }
  if ((WALK_LAYER_IDS as readonly string[]).includes(id)) {
    if (!pedestrian) return 'none'
    if (id === 'editor-pedestrian-curbs' && !is3d) return 'none'
    return 'visible'
  }
  if ((LANE_GRAPH_LAYER_IDS as readonly string[]).includes(id)) {
    return showLaneGraph && mode === 'motor' && !is3d ? 'visible' : 'none'
  }
  return 'visible'
}

/** Idempotent: call on every switch even when neither OSM nor camera changed. */
export function applyNetworkLayerVisibility(
  map: LayerVisibilityMap,
  mode: NetworkMode,
  viewMode: '2d' | '3d',
  showLaneGraph: boolean,
): void {
  const ids = [...MOTOR_LAYER_IDS, ...WALK_LAYER_IDS, ...LANE_GRAPH_LAYER_IDS]
  for (const id of ids) {
    if (!map.getLayer(id)) continue
    const target = networkLayerVisibility(id, mode, viewMode, showLaneGraph)
    if ((map.getLayoutProperty(id, 'visibility') ?? 'visible') !== target) {
      map.setLayoutProperty(id, 'visibility', target)
    }
  }
}
