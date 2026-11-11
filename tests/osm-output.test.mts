import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { serializeOsmDocument } from '../src/lib/xml.ts'

test('export keeps exactly one XML declaration when source already has one', () => {
  const result = serializeOsmDocument('<?xml version="1.0" encoding="UTF-8"?><osm version="0.6"/>')
  assert.equal((result.match(/<\?xml\b/g) ?? []).length, 1)
  assert.match(result, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<osm/)
})

test('export adds one XML declaration when source has none', () => {
  const result = serializeOsmDocument('<osm version="0.6"/>')
  assert.equal((result.match(/<\?xml\b/g) ?? []).length, 1)
  assert.ok(result.includes('<osm version="0.6"/>'))
})

test('export preserves other instructions and OSM root content', () => {
  const result = serializeOsmDocument('<?xml version="1.0"?>\n<?xml-stylesheet href="a.xsl"?><osm><node id="1"/></osm>')
  assert.match(result, /<\?xml-stylesheet href="a\.xsl"\?>/)
  assert.match(result, /<node id="1"\/>/)
})

test('2D road rendering has no junction-disc layer or rounded lane ends', () => {
  const source = readFileSync(new URL('../src/components/MapEditor.vue', import.meta.url), 'utf8')
  assert.ok(!source.includes('editor-lane-junctions-fill'))
  assert.ok(!source.includes("map.addSource('editor-lane-junctions'"))
  for (const id of ['editor-lane-borders', 'editor-lane-surfaces']) {
    const block = source.slice(source.indexOf(`id: '${id}'`))
    assert.match(block.slice(0, 180), /'line-cap': 'butt'/)
  }
})
