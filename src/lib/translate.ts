import type { RoadFeature, RoadVertex } from '../types/road'

const EARTH_RADIUS_METRES = 6_378_137
const RADIANS = Math.PI / 180

/** X is metres east, Y is metres north; coordinates remain WGS84. */
export function shiftVertices(
  vertices: readonly RoadVertex[],
  eastMetres: number,
  northMetres: number,
): RoadVertex[] {
  if (!Number.isFinite(eastMetres) || !Number.isFinite(northMetres)) {
    throw new Error('Введите корректное смещение в метрах.')
  }
  if (Math.hypot(eastMetres, northMetres) > 10_000) {
    throw new Error('За одно перемещение допускается не более 10 км.')
  }
  const latitudeOffset = northMetres / EARTH_RADIUS_METRES / RADIANS
  return vertices.map(vertex => {
    const middleLatitude = (vertex.lat + latitudeOffset / 2) * RADIANS
    const cosLatitude = Math.cos(middleLatitude)
    if (Math.abs(cosLatitude) < 0.000001) {
      throw new Error('Невозможно сместить объект у географического полюса.')
    }
    return {
      ...vertex,
      lat: vertex.lat + latitudeOffset,
      lng: vertex.lng + eastMetres / (EARTH_RADIUS_METRES * cosLatitude) / RADIANS,
    }
  })
}

/** Convert cursor displacement to metres, regardless of viewport zoom. */
export function cursorOffsetMetres(
  start: Pick<RoadVertex, 'lng' | 'lat'>,
  end: Pick<RoadVertex, 'lng' | 'lat'>,
): { east: number; north: number } {
  const avgLatitude = (start.lat + end.lat) / 2 * RADIANS
  return {
    east: (end.lng - start.lng) * RADIANS * EARTH_RADIUS_METRES * Math.cos(avgLatitude),
    north: (end.lat - start.lat) * RADIANS * EARTH_RADIUS_METRES,
  }
}

/**
 * A road moved as an independent object must not drag its junction neighbours.
 * Also clone source OSM node IDs: they may belong to non-road OSM entities.
 * Preserve repeated IDs (first/last of an ellipse/roundabout) for a valid closed way.
 */
export function isolatedMoveVertices(
  roads: readonly RoadFeature[],
  roadId: string,
  makeId: () => string = () => crypto.randomUUID(),
): RoadVertex[] | null {
  const selected = roads.find(road => road.id === roadId)
  if (!selected) return null
  const externalIds = new Set(
    roads.filter(road => road.id !== roadId)
      .flatMap(road => road.vertices.map(vertex => vertex.id)),
  )
  const replacements = new Map<string, string>()
  return selected.vertices.map(vertex => {
    const shouldClone = vertex.id.startsWith('osm-node-') || externalIds.has(vertex.id)
    if (!shouldClone) return { ...vertex }
    let id = replacements.get(vertex.id)
    if (!id) {
      id = makeId()
      replacements.set(vertex.id, id)
    }
    return { ...vertex, id }
  })
}
