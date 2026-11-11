import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SATELLITE_TILES, SATELLITE_ATTRIBUTION, SATELLITE_LAYER_ID, SATELLITE_SOURCE_ID, satelliteVisibility } from '../src/lib/basemaps.ts'

test('switching to satellite shows raster and returning to map hides it', () => {
  assert.equal(satelliteVisibility('map'), 'none')
  assert.equal(satelliteVisibility('satellite'), 'visible')
  assert.equal(satelliteVisibility('map'), 'none')
})

test('satellite uses a raster tile template with source attribution', () => {
  assert.match(DEFAULT_SATELLITE_TILES, /^https:\/\//)
  assert.match(DEFAULT_SATELLITE_TILES, /\{z\}\/\{y\}\/\{x\}/)
  assert.ok(SATELLITE_LAYER_ID !== SATELLITE_SOURCE_ID)
  assert.match(SATELLITE_ATTRIBUTION, /Esri/)
})
