
import type { RoadFeature } from '../types/road'

export function disconnectRoadVertex(
  roads: RoadFeature[],
  roadId: string,
  vertexId: string,
): RoadFeature[] | null {
  const selected = roads.find(road => road.id === roadId)

  if (!selected?.vertices.some(vertex => vertex.id === vertexId)) {
    return null
  }

  const owners = roads.filter(road =>
    road.vertices.some(vertex => vertex.id === vertexId),
  )

  if (owners.length < 2) return null

  const newVertexId = crypto.randomUUID()

  return roads.map(road => {
    if (road.id !== roadId) return road

    return {
      ...road,
      vertices: road.vertices.map(vertex =>
        vertex.id === vertexId
          ? { ...vertex, id: newVertexId }
          : vertex,
      ),
    }
  })
}
