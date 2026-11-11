import type { ImportedProject, RoadFeature, RoadVertex } from '../types/road'
import { importedLaneCount } from './lanes'
import { isPedestrianWay } from './pedestrian'
import { serializeOsmDocument } from './xml'

function elementChildren(parent: Element, tag: string): Element[] {
  return Array.from(parent.children).filter((node) => node.tagName === tag)
}

function parseTags(element: Element): Record<string, string> {
  const tags: Record<string, string> = {}
  for (const tag of elementChildren(element, 'tag')) {
    const key = tag.getAttribute('k')
    if (key) tags[key] = tag.getAttribute('v') ?? ''
  }
  return tags
}

export function importOsm(xml: string, name: string): ImportedProject {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.querySelector('parsererror') || doc.documentElement.tagName !== 'osm') {
    throw new Error('Некорректный XML: ожидается корневой элемент <osm>.')
  }
  const nodes = new Map<string, RoadVertex>()
  const warnings: string[] = []
  const allNodes = elementChildren(doc.documentElement, 'node')
  const allWays = elementChildren(doc.documentElement, 'way')
  const relations = elementChildren(doc.documentElement, 'relation')
  for (const node of allNodes) {
    const id = node.getAttribute('id')
    const lng = Number(node.getAttribute('lon'))
    const lat = Number(node.getAttribute('lat'))
    if (id && Number.isFinite(lng) && Number.isFinite(lat)) {
      nodes.set(id, { id: `osm-node-${id}`, lng, lat })
    }
  }
  const roads: RoadFeature[] = []
  for (const way of allWays) {
    const tags = parseTags(way)
    if (!tags.highway) continue
    const wayId = way.getAttribute('id')
    if (!wayId) continue
    const refs = elementChildren(way, 'nd').map((nd) => nd.getAttribute('ref') ?? '')
    const vertices = refs.map((ref) => nodes.get(ref)).filter((point): point is RoadVertex => !!point)
    if (vertices.length < 2 || vertices.length !== refs.length) {
      warnings.push(`Дорога ${wayId}: отсутствуют узлы — объект сохранён в исходном XML без визуального редактирования.`)
      continue
    }
    const oneway = tags.oneway === 'yes' || tags.oneway === '1' || tags.oneway === '-1' || tags.junction === 'roundabout'
    const bridge = tags.bridge === 'yes' || (tags.bridge !== undefined && tags.bridge !== 'no')
    const level = Math.max(bridge ? 1 : 0, Math.max(0, Math.min(2, Number.parseInt(tags.layer ?? '0', 10) || 0)))
    roads.push({
      id: `way-${wayId}`, osmId: wayId, name: tags.name ?? '', highway: tags.highway,
      lanes: importedLaneCount(tags),
      oneway, bridge, level, vertices, tags,
    })
  }
  return { xml, roads, name, allNodeCount: allNodes.length, allWayCount: allWays.length, allWayIds: allWays.map(way => way.getAttribute('id') ?? '').filter(Boolean), relationCount: relations.length, warnings }
}

function setRoadTags(way: Element, road: RoadFeature, doc: Document, baseline?: RoadFeature): void {
  for (const child of elementChildren(way, 'tag')) way.removeChild(child)
  const tags: Record<string, string> = {
    ...road.tags,
    highway: road.highway,
  }
  // Never invent motor-vehicle lane or direction tags on a pedestrian way.
  if (!isPedestrianWay(road)) {
    tags.lanes = String(road.lanes)
    tags.oneway = road.oneway ? (road.tags.oneway === '-1' ? '-1' : 'yes') : 'no'
  }
  if (road.name.trim()) tags.name = road.name.trim()
  else delete tags.name
  if (road.bridge) {
    const originalBridge = road.tags.bridge
    tags.bridge = originalBridge && !['no', 'false', '0'].includes(originalBridge)
      ? originalBridge
      : 'yes'
  } else delete tags.bridge
  if (road.level !== 0) {
    // Keep a source layer outside the editor's display range (e.g. layer=3)
    // when the user changed another attribute but did not change the level.
    const originalLayer = road.tags.layer
    tags.layer = baseline && road.level === baseline.level && originalLayer !== undefined &&
      Number.isInteger(Number(originalLayer))
      ? originalLayer
      : String(road.level)
  }
  // Keep original negative OSM layers when editing an underground way. RoadFeature.level
  // represents an above-ground bridge level, not tunnel depth.
  else if (Number(road.tags.layer ?? 0) < 0) tags.layer = road.tags.layer!
  else delete tags.layer
  for (const [k, v] of Object.entries(tags)) {
    const tag = doc.createElement('tag')
    tag.setAttribute('k', k)
    tag.setAttribute('v', v)
    way.appendChild(tag)
  }
}

/**
 * MVP client export. Unmodified unsupported elements and relations remain intact.
 * The backend must validate dangling relations and lane topology before final delivery.
 */
export function exportOsm(sourceXml: string, roads: RoadFeature[], originalRoadIds: string[], baselineRoads: RoadFeature[] = []): string {
  const doc = sourceXml
    ? new DOMParser().parseFromString(sourceXml, 'application/xml')
    : document.implementation.createDocument('', 'osm', null)
  const root = doc.documentElement
  root.setAttribute('version', '0.6')
  root.setAttribute('generator', 'Road Network Editor MVP')
  root.setAttribute('upload', 'false')
  const originalNodes = new Map<string, Element>()
  const originalWays = new Map<string, Element>()
  for (const node of elementChildren(root, 'node')) {
    const id = node.getAttribute('id')
    if (id) originalNodes.set(id, node)
  }
  for (const way of elementChildren(root, 'way')) {
    const id = way.getAttribute('id')
    if (id) originalWays.set(id, way)
  }
  const unchanged = new Map(baselineRoads.map((road) => [road.osmId, JSON.stringify(road)]))
  const baselineById = new Map(baselineRoads.map((road) => [road.osmId, road]))
  const finalWayIds = new Set(roads.map((road) => road.osmId))
  for (const id of originalRoadIds) {
    if (!finalWayIds.has(id)) {
      const way = originalWays.get(id)
      if (way) root.removeChild(way)
    }
  }
  // Reserved explicit numeric IDs used by new traffic infrastructure must
  // never be stolen by unrelated UUID-based road vertices during export.
  const reservedNodeIds = new Set(originalNodes.keys())
  for (const road of roads) for (const vertex of road.vertices) {
    if (vertex.id.startsWith('osm-node-')) reservedNodeIds.add(vertex.id.slice('osm-node-'.length))
  }
  let nextNodeId = -1
  while (reservedNodeIds.has(String(nextNodeId))) nextNodeId--
  const addedNodes = new Map<string, string>()
  function resolveNodeId(vertex: RoadVertex): string {
    if (vertex.id.startsWith('osm-node-')) return vertex.id.slice('osm-node-'.length)
    const known = addedNodes.get(vertex.id)
    if (known) return known
    while (reservedNodeIds.has(String(nextNodeId))) nextNodeId--
    const id = String(nextNodeId--)
    reservedNodeIds.add(id)
    addedNodes.set(vertex.id, id)
    return id
  }
  for (const road of roads) {
    // Original untouched ways stay untouched, including tags and node attributes.
    if (unchanged.get(road.osmId) === JSON.stringify(road)) continue
    for (const vertex of road.vertices) {
      const id = resolveNodeId(vertex)
      let node = originalNodes.get(id)
      if (!node) {
        node = doc.createElement('node')
        node.setAttribute('id', id)
        node.setAttribute('visible', 'true')
        const firstWayOrRelation = Array.from(root.children).find(el => el.tagName === 'way' || el.tagName === 'relation')
        if (firstWayOrRelation) root.insertBefore(node, firstWayOrRelation)
        else root.appendChild(node)
        originalNodes.set(id, node)
      }
      if (Number(node.getAttribute('lat')) !== vertex.lat) node.setAttribute('lat', vertex.lat.toFixed(8))
      if (Number(node.getAttribute('lon')) !== vertex.lng) node.setAttribute('lon', vertex.lng.toFixed(8))
      // Altered OSM elements are marked as local, non-uploadable draft data.
      if (id.startsWith('-')) node.setAttribute('version', '1')
    }
    let way = originalWays.get(road.osmId)
    if (!way) {
      way = doc.createElement('way')
      way.setAttribute('id', road.osmId)
      way.setAttribute('version', '1')
      way.setAttribute('visible', 'true')
      const firstRelation = Array.from(root.children).find(el => el.tagName === 'relation')
      if (firstRelation) root.insertBefore(way, firstRelation)
      else root.appendChild(way)
    }
    for (const nd of elementChildren(way, 'nd')) way.removeChild(nd)
    for (const vertex of road.vertices) {
      const nd = doc.createElement('nd')
      nd.setAttribute('ref', resolveNodeId(vertex))
      const firstTag = elementChildren(way, 'tag')[0]
      if (firstTag) way.insertBefore(nd, firstTag)
      else way.appendChild(nd)
    }
    setRoadTags(way, road, doc, baselineById.get(road.osmId))
  }
  return serializeOsmDocument(new XMLSerializer().serializeToString(doc))
}

export function downloadOsm(xml: string, filename = 'edited.osm'): void {
  const url = URL.createObjectURL(new Blob([xml], { type: 'application/xml;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
