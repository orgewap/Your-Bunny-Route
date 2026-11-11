import type { RoadFeature } from '../types/road'

/** Mutates only one selected way. Shared OSM node IDs are detached on demand. */
export function updateSelectedDraggedVertex(
  roads: RoadFeature[], roadId: string, vertexId: string,
  lng: number, lat: number,
  newId: () => string = () => crypto.randomUUID(),
): string {
  const road = roads.find(item => item.id === roadId)
  if (!road) throw new Error('Выбранная дорога больше не существует.')
  const indices = road.vertices.flatMap((v, i) => v.id === vertexId ? [i] : [])
  if (!indices.length) throw new Error('Точка дороги больше не существует.')
  const shared = roads.some(other => other.id !== roadId &&
    other.vertices.some(vertex => vertex.id === vertexId))
  // Imported OSM nodes may also be referenced by non-road ways or relations
  // that are not present in the editable road list.
  const id = shared || vertexId.startsWith('osm-node-') ? newId() : vertexId
  // Old lane entry/exit offsets belong to the previous junction, not the new.
  const wasStart = indices.includes(0)
  const wasEnd = indices.includes(road.vertices.length - 1)
  if (wasStart && road.visualApproach?.start && road.vertices.length > 2) {
    road.vertices.splice(1, 1)
    road.visualApproach = { ...road.visualApproach, start: false }
  }
  if (wasEnd && road.visualApproach?.end && road.vertices.length > 2) {
    road.vertices.splice(road.vertices.length - 2, 1)
    road.visualApproach = { ...road.visualApproach, end: false }
  }
  // Replace vertex objects rather than mutating them: imported and generated
  // ways can still share the *same object instance*, not merely the same ID.
  road.vertices = road.vertices.map(vertex => vertex.id === vertexId
    ? { id, lng, lat } : vertex)
  return id
}
