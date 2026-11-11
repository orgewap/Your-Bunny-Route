export interface SimulatorExportReport {
  ok: boolean
  nodes: number
  ways: number
  relations: number
  highwayWays: number
  motorRoadWays: number
  pedestrianWays: number
  bridgeWays: number
  tunnelWays: number
  restrictedWays: number
  motorWaysWithoutLaneTags: number
  trafficControls: number
  outOfZoneNodes: number
  invalidCoordinates: number
  duplicateIds: number
  invalidHighwayWays: number
  newMissingWayNodeRefs: number
  newMissingRelationMembers: number
  errors: string[]
  warnings: string[]
}

const PEDESTRIAN_HIGHWAYS = new Set([
  'footway', 'steps', 'path', 'pedestrian', 'cycleway',
  'bridleway', 'corridor', 'platform',
])
const CONTROL_HIGHWAYS = new Set([
  'traffic_signals', 'stop', 'give_way', 'crossing',
])

function children(parent: Element, tag: string): Element[] {
  return Array.from(parent.children).filter((element) => element.tagName === tag)
}

function readTags(element: Element): Record<string, string> {
  const tags: Record<string, string> = {}
  for (const tag of children(element, 'tag')) {
    const key = tag.getAttribute('k')
    if (key) tags[key] = tag.getAttribute('v') ?? ''
  }
  return tags
}

function parseOsm(xml: string, label: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.querySelector('parsererror') || doc.documentElement.tagName !== 'osm') {
    throw new Error(`${label}: ожидается корректный XML с корневым элементом <osm>.`)
  }
  return doc
}

function missingWayNodeKeys(doc: Document, nodeIds: Set<string>): Set<string> {
  const missing = new Set<string>()
  for (const way of children(doc.documentElement, 'way')) {
    const wayId = way.getAttribute('id') ?? ''
    for (const nd of children(way, 'nd')) {
      const ref = nd.getAttribute('ref') ?? ''
      if (!nodeIds.has(ref)) missing.add(`${wayId}\u0000${ref}`)
    }
  }
  return missing
}

function missingRelationMemberKeys(
  doc: Document,
  nodeIds: Set<string>,
  wayIds: Set<string>,
  relationIds: Set<string>,
): Set<string> {
  const missing = new Set<string>()
  const targets: Record<string, Set<string>> = {
    node: nodeIds,
    way: wayIds,
    relation: relationIds,
  }
  for (const relation of children(doc.documentElement, 'relation')) {
    const relationId = relation.getAttribute('id') ?? ''
    for (const member of children(relation, 'member')) {
      const type = member.getAttribute('type') ?? ''
      const ref = member.getAttribute('ref') ?? ''
      const target = targets[type]
      if (target && !target.has(ref)) missing.add(`${relationId}\u0000${type}\u0000${ref}`)
    }
  }
  return missing
}

/**
 * Preflight for the unchanged MATSim → SUMO → Webots converter contract.
 * MATSim and SUMO consume the same OSM XML; Webots receives SUMO's scenario.zip
 * and fcd.xml, so this validates the single shared OSM export.
 */
export function inspectSimulatorOsm(xml: string, baselineXml = ''): SimulatorExportReport {
  const doc = parseOsm(xml, 'Экспорт')
  const root = doc.documentElement
  const nodeElements = children(root, 'node')
  const wayElements = children(root, 'way')
  const relationElements = children(root, 'relation')

  const nodeIds = new Set<string>()
  const wayIds = new Set<string>()
  const relationIds = new Set<string>()
  const duplicateNodeIds = new Set<string>()
  const duplicateWayIds = new Set<string>()
  const duplicateRelationIds = new Set<string>()
  const coordinates: Array<{ lon: number; lat: number }> = []
  let invalidCoordinates = 0
  let outOfZoneNodes = 0
  let highwayWays = 0
  let motorRoadWays = 0
  let pedestrianWays = 0
  let bridgeWays = 0
  let tunnelWays = 0
  let restrictedWays = 0
  let motorWaysWithoutLaneTags = 0
  let trafficControls = 0
  let invalidHighwayWays = 0
  const errors: string[] = []
  const warnings: string[] = []

  for (const node of nodeElements) {
    const id = node.getAttribute('id') ?? ''
    if (!id) errors.push('В OSM есть узел без id.')
    else if (nodeIds.has(id)) duplicateNodeIds.add(id)
    else nodeIds.add(id)

    const lonText = node.getAttribute('lon')
    const latText = node.getAttribute('lat')
    const lon = lonText === null || lonText.trim() === '' ? Number.NaN : Number(lonText)
    const lat = latText === null || latText.trim() === '' ? Number.NaN : Number(latText)
    if (!Number.isFinite(lon) || !Number.isFinite(lat) ||
        lon < -180 || lon > 180 || lat < -90 || lat > 90) {
      invalidCoordinates++
      continue
    }
    coordinates.push({ lon, lat })
    // The supplied MATSim converter projects every OSM coordinate to EPSG:32648.
    // This is UTM zone 48N: longitude 102°E–108°E, latitude 0°–84°N.
    if (lon < 102 || lon >= 108 || lat <= 0 || lat >= 84) outOfZoneNodes++
    const nodeTags = readTags(node)
    if (nodeTags.highway && CONTROL_HIGHWAYS.has(nodeTags.highway)) trafficControls++
  }

  for (const way of wayElements) {
    const id = way.getAttribute('id') ?? ''
    if (!id) errors.push('В OSM есть way без id.')
    else if (wayIds.has(id)) duplicateWayIds.add(id)
    else wayIds.add(id)

    const tags = readTags(way)
    const highway = tags.highway
    const refs = children(way, 'nd')
    if (highway) {
      highwayWays++
      if (refs.length < 2) invalidHighwayWays++
      if (PEDESTRIAN_HIGHWAYS.has(highway)) pedestrianWays++
      else {
        motorRoadWays++
        if (!tags.lanes && !tags['lanes:forward'] && !tags['lanes:backward']) {
          motorWaysWithoutLaneTags++
        }
      }
      if (tags.bridge && !['no', 'false', '0'].includes(tags.bridge)) bridgeWays++
      if (tags.tunnel && !['no', 'false', '0'].includes(tags.tunnel)) tunnelWays++
    }
    if (tags.motor_vehicle === 'no' || tags.motorcar === 'no') restrictedWays++
    if (tags.road_marking === 'stop_line') trafficControls++
  }

  for (const relation of relationElements) {
    const id = relation.getAttribute('id') ?? ''
    if (!id) errors.push('В OSM есть relation без id.')
    else if (relationIds.has(id)) duplicateRelationIds.add(id)
    else relationIds.add(id)
  }

  const duplicateIds = duplicateNodeIds.size + duplicateWayIds.size + duplicateRelationIds.size
  if (duplicateIds) errors.push(`Найдены повторяющиеся OSM ID: ${duplicateIds}.`)
  if (invalidCoordinates) errors.push(`У ${invalidCoordinates} узлов отсутствуют или некорректны координаты WGS84.`)
  if (outOfZoneNodes) {
    errors.push(`${outOfZoneNodes} узлов вне зоны EPSG:32648. Конвертер MATSim использует именно эту проекцию.`)
  }
  if (!coordinates.length) errors.push('В OSM нет узлов с координатами.')
  if (!highwayWays) errors.push('В OSM нет дорог с тегом highway.')
  if (!motorRoadWays) errors.push('В OSM нет автомобильных дорог для MATSim и SUMO.')
  if (invalidHighwayWays) errors.push(`${invalidHighwayWays} highway ways содержат меньше двух узлов.`)

  let newMissingWayNodeRefs = 0
  let newMissingRelationMembers = 0
  const finalMissingWayNodes = missingWayNodeKeys(doc, nodeIds)
  const finalMissingRelations = missingRelationMemberKeys(doc, nodeIds, wayIds, relationIds)
  if (baselineXml) {
    const baseline = parseOsm(baselineXml, 'Исходный проект')
    const baseNodes = new Set(children(baseline.documentElement, 'node')
      .map((node) => node.getAttribute('id') ?? '').filter(Boolean))
    const baseWays = new Set(children(baseline.documentElement, 'way')
      .map((way) => way.getAttribute('id') ?? '').filter(Boolean))
    const baseRelations = new Set(children(baseline.documentElement, 'relation')
      .map((relation) => relation.getAttribute('id') ?? '').filter(Boolean))
    const baselineMissingWayNodes = missingWayNodeKeys(baseline, baseNodes)
    const baselineMissingRelations = missingRelationMemberKeys(baseline, baseNodes, baseWays, baseRelations)
    newMissingWayNodeRefs = [...finalMissingWayNodes].filter((key) => !baselineMissingWayNodes.has(key)).length
    newMissingRelationMembers = [...finalMissingRelations].filter((key) => !baselineMissingRelations.has(key)).length
  } else {
    newMissingWayNodeRefs = finalMissingWayNodes.size
    newMissingRelationMembers = finalMissingRelations.size
  }
  if (newMissingWayNodeRefs) errors.push(`Экспорт создаёт ${newMissingWayNodeRefs} новых ссылок way → node на отсутствующие узлы.`)
  if (newMissingRelationMembers) {
    errors.push(`Экспорт создаёт ${newMissingRelationMembers} новых ссылок OSM-отношений на удалённые объекты.`)
  }

  if (motorWaysWithoutLaneTags) {
    warnings.push(`${motorWaysWithoutLaneTags} автомобильных дорог не имеют явного lanes / lanes:forward / lanes:backward. Они оставлены без искусственных значений; конвертеры используют собственные правила по умолчанию.`)
  }
  if (restrictedWays) {
    warnings.push(`${restrictedWays} дорог содержат motor_vehicle=no или motorcar=no. Эти ограничения сохранены в OSM.`)
  }

  return {
    ok: errors.length === 0,
    nodes: nodeElements.length,
    ways: wayElements.length,
    relations: relationElements.length,
    highwayWays,
    motorRoadWays,
    pedestrianWays,
    bridgeWays,
    tunnelWays,
    restrictedWays,
    motorWaysWithoutLaneTags,
    trafficControls,
    outOfZoneNodes,
    invalidCoordinates,
    duplicateIds,
    invalidHighwayWays,
    newMissingWayNodeRefs,
    newMissingRelationMembers,
    errors,
    warnings,
  }
}
