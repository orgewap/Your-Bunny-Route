import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyNetworkLayerVisibility, networkLayerVisibility,
  MOTOR_LAYER_IDS, WALK_LAYER_IDS, LANE_GRAPH_LAYER_IDS,
  isBackgroundTransportLine,
} from '../src/lib/networkLayers.ts'

function fakeMap() {
  const ids = [...MOTOR_LAYER_IDS, ...WALK_LAYER_IDS, ...LANE_GRAPH_LAYER_IDS]
  const visibility = new Map<string, string>(ids.map(id => [id, 'visible']))
  const changes: string[] = []
  return {
    visibility, changes,
    getLayer: (id: string) => visibility.has(id) ? { id } : undefined,
    getLayoutProperty: (id: string) => visibility.get(id),
    setLayoutProperty(id: string, key: string, value: string) {
      assert.equal(key, 'visibility')
      assert.ok(visibility.has(id))
      visibility.set(id, value)
      changes.push(`${id}:${value}`)
    },
  }
}

test('clicking Auto -> Pedestrian -> Both -> Auto updates every layer even with unchanged OSM', () => {
  const map = fakeMap()
  const sequences = [
    { mode: 'motor' as const, motor: 'visible', walk: 'none' },
    { mode: 'pedestrian' as const, motor: 'none', walk: 'visible' },
    { mode: 'all' as const, motor: 'visible', walk: 'visible' },
    { mode: 'motor' as const, motor: 'visible', walk: 'none' },
  ]
  for (const { mode, motor, walk } of sequences) {
    applyNetworkLayerVisibility(map, mode, '2d', false)
    for (const id of MOTOR_LAYER_IDS) assert.equal(map.visibility.get(id), motor, `${mode}: ${id}`)
    for (const id of WALK_LAYER_IDS) assert.equal(map.visibility.get(id), id === 'editor-pedestrian-curbs' ? 'none' : walk, `${mode}: ${id}`)
    for (const id of LANE_GRAPH_LAYER_IDS) assert.equal(map.visibility.get(id), 'none', `${mode}: ${id}`)
  }
  const count = map.changes.length
  applyNetworkLayerVisibility(map, 'motor', '2d', false)
  assert.equal(map.changes.length, count, 'repeated sync must not cause MapLibre style churn')
})

test('in 3D the mesh owns motor surfaces while pedestrian curbs appear', () => {
  const map = fakeMap()
  applyNetworkLayerVisibility(map, 'all', '3d', false)
  assert.equal(map.visibility.get('editor-lane-surfaces'), 'none')
  assert.equal(map.visibility.get('editor-lane-borders'), 'none')
  assert.equal(map.visibility.get('editor-pedestrian-curbs'), 'visible')
  assert.equal(map.visibility.get('editor-pedestrian-tunnels'), 'visible')
  applyNetworkLayerVisibility(map, 'pedestrian', '3d', false)
  assert.equal(map.visibility.get('editor-road-hit'), 'none')
  assert.equal(map.visibility.get('editor-bridge-labels'), 'none')
  // Editable handles are shared by motor and pedestrian geometry: do not hide.
  assert.equal(networkLayerVisibility('editor-handles-halo', 'pedestrian', '2d', false), 'visible')
  assert.equal(networkLayerVisibility('editor-edit-axis', 'pedestrian', '2d', false), 'visible')
})

test('lane graph display is restricted to automotive 2D mode', () => {
  for (const mode of ['motor', 'pedestrian', 'all'] as const) {
    const expected = mode === 'motor' ? 'visible' : 'none'
    for (const id of LANE_GRAPH_LAYER_IDS) {
      assert.equal(networkLayerVisibility(id, mode, '2d', true), expected)
      assert.equal(networkLayerVisibility(id, mode, '3d', true), 'none')
    }
  }
})

test('missing map layers are ignored when switch happens before style.load', () => {
  const map = fakeMap()
  map.visibility.delete('editor-pedestrian-tunnels')
  assert.doesNotThrow(() => applyNetworkLayerVisibility(map, 'pedestrian', '2d', true))
})


test('pedestrian mode can hide basemap road polygons as well as centerlines', () => {
  assert.equal(isBackgroundTransportLine({ id: 'highway-area', type: 'fill', 'source-layer': 'transportation' }), true)
  assert.equal(isBackgroundTransportLine({ id: 'road-name', type: 'symbol', 'source-layer': 'transportation_name' }), false)
  assert.equal(isBackgroundTransportLine({ id: 'building-area', type: 'fill', 'source-layer': 'building' }), false)
})

test('road-analysis overlay is visible only in automotive 2D mode', () => {
  for (const id of ['editor-analysis-issues-halo', 'editor-analysis-issues']) {
    assert.equal(networkLayerVisibility(id, 'motor', '2d', false), 'visible')
    assert.equal(networkLayerVisibility(id, 'pedestrian', '2d', false), 'none')
    assert.equal(networkLayerVisibility(id, 'all', '3d', false), 'none')
  }
})
