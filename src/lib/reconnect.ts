
import type { RoadFeature, RoadVertex } from '../types/road'
import type { TargetLink } from './topology.ts'
import { distanceMetres } from './topology.ts'

export function reconnectDraggedEndpoint(
  roads: RoadFeature[],
  draggedVertexId: string,
  link: TargetLink,
): RoadFeature[] {
  const target = roads.find(road => road.id === link.roadId)

  if (
    !target ||
    link.segmentIndex < 0 ||
    link.segmentIndex >= target.vertices.length - 1
  ) {
    throw new Error('Целевая дорога больше недоступна.')
  }

  if (target.vertices.some(v => v.id === draggedVertexId)) {
    throw new Error('Нельзя соединить вершину с собственной дорогой.')
  }

  const owners = roads.filter(road =>
    road.vertices.some(v => v.id === draggedVertexId)
  )

  if (!owners.length) {
    throw new Error('Перемещаемая вершина не найдена.')
  }

  const a = target.vertices[link.segmentIndex]!
  const b = target.vertices[link.segmentIndex + 1]!
  const t = Math.max(0, Math.min(1, link.t))

  const snapped: RoadVertex =
    t <= 1e-7 ? { ...a } :
    t >= 1 - 1e-7 ? { ...b } :
    { ...link.vertex }

  // Запрещаем соединения, создающие отрезки нулевой длины.
  for (const road of owners) {
    for (let i = 0; i < road.vertices.length; i++) {
      if (road.vertices[i]!.id !== draggedVertexId) continue

      const neighbors = [
        road.vertices[i - 1],
        road.vertices[i + 1],
      ]

      if (neighbors.some(v => v && distanceMetres(v, snapped) < 0.5)) {
        throw new Error('После соединения участок станет слишком коротким.')
      }
    }
  }

  return roads.map(road => {
    const vertices = road.vertices.map(vertex =>
      vertex.id === draggedVertexId
        ? { id: snapped.id, lng: snapped.lng, lat: snapped.lat }
        : { ...vertex }
    )
    // A dragged endpoint can also meet the chosen lane/boundary instead of
    // visibly emerging from the target's middle stripe.
    const lateral = link.laneAttachment
    if (road.id !== target.id && lateral && Math.abs(lateral.offsetMetres) > 0.5) {
      if (road.vertices[0]?.id === draggedVertexId &&
          distanceMetres(vertices[1]!, lateral.visibleVertex) > 0.5) {
        vertices.splice(1, 0, { ...lateral.visibleVertex })
      } else if (road.vertices[road.vertices.length - 1]?.id === draggedVertexId &&
                 distanceMetres(vertices[vertices.length - 2]!, lateral.visibleVertex) > 0.5) {
        vertices.splice(vertices.length - 1, 0, { ...lateral.visibleVertex })
      }
    }

    // Прилипание к середине way: создаём общий OSM-узел.
    if (
      road.id === target.id &&
      t > 1e-7 &&
      t < 1 - 1e-7
    ) {
      vertices.splice(link.segmentIndex + 1, 0, { ...snapped })
    }

    const attachedAtStart = road.vertices[0]?.id === draggedVertexId
    const attachedAtEnd = road.vertices[road.vertices.length - 1]?.id === draggedVertexId
    const hasLaneOffset = !!lateral && Math.abs(lateral.offsetMetres) > 0.5
    return { ...road, vertices,
      visualApproach: road.id === target.id ? road.visualApproach : {
        start: attachedAtStart ? hasLaneOffset : road.visualApproach?.start,
        end: attachedAtEnd ? hasLaneOffset : road.visualApproach?.end,
      },
    }
  })
}
