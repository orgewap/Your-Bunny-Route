import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MOTOR_SOURCE_IDS, WALK_SOURCE_IDS,
  networkSourceVisible, basemapTransportVisibility,
} from '../src/lib/networkLayers.ts'

// Unlike only changing MapLibre's layout.visibility, sources must be emptied.
// This keeps disabled networks gone after zoom, pan, or a style refresh.
test('Auto contains NO pedestrian source data, even while the motor graph is shown', () => {
  for (const id of MOTOR_SOURCE_IDS) assert.equal(networkSourceVisible(id, 'motor'), true, id)
  for (const id of WALK_SOURCE_IDS) assert.equal(networkSourceVisible(id, 'motor'), false, id)
})

test('Pedestrian contains NO motor source data, even if map layers become visible again', () => {
  for (const id of MOTOR_SOURCE_IDS) assert.equal(networkSourceVisible(id, 'pedestrian'), false, id)
  for (const id of WALK_SOURCE_IDS) assert.equal(networkSourceVisible(id, 'pedestrian'), true, id)
})

test('Both networks contains both source groups', () => {
  for (const id of [...MOTOR_SOURCE_IDS, ...WALK_SOURCE_IDS]) {
    assert.equal(networkSourceVisible(id, 'all'), true, id)
  }
})

test('Edit/preview sources are not wrongly disabled', () => {
  for (const mode of ['motor', 'pedestrian', 'all'] as const) {
    assert.equal(networkSourceVisible('editor-handles', mode), true)
    assert.equal(networkSourceVisible('editor-preview', mode), true)
    assert.equal(networkSourceVisible('editor-infrastructure-points', mode), true)
  }
})

test('MapLibre basemap transportation lines never fake an editable network', () => {
  for (const original of ['visible', 'none'] as const) {
    for (const mode of ['motor', 'pedestrian', 'all'] as const) {
      // Mode does not affect base transport, only loading an OSM does.
      assert.equal(basemapTransportVisibility(true, original), 'none', mode)
      assert.equal(basemapTransportVisibility(false, original), original, mode)
    }
  }
})

test('road-analysis overlay belongs only to the automotive source group', () => {
  assert.equal(MOTOR_SOURCE_IDS.includes('editor-analysis-issues' as never), true)
  assert.equal(networkSourceVisible('editor-analysis-issues', 'motor'), true)
  assert.equal(networkSourceVisible('editor-analysis-issues', 'pedestrian'), false)
  assert.equal(networkSourceVisible('editor-analysis-issues', 'all'), true)
})
