import type { RoadFeature } from '../types/road'

/** A tiny spatial index: one box per OSM way, cached between geometry edits. */
export interface GeoBounds { west: number; east: number; south: number; north: number }
export interface RoadBounds { road: RoadFeature; west: number; east: number; south: number; north: number }

export function indexRoadBounds(roads: readonly RoadFeature[]): RoadBounds[] {
  return roads.map(road => {
    let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity
    for (const vertex of road.vertices) {
      west = Math.min(west, vertex.lng); east = Math.max(east, vertex.lng)
      south = Math.min(south, vertex.lat); north = Math.max(north, vertex.lat)
    }
    return { road, west, east, south, north }
  })
}

/** Meter padding prevents snapping and junction edges from disappearing at viewport borders. */
export function expandBounds(bounds: GeoBounds, paddingMetres = 250): GeoBounds {
  const middleLat = (bounds.north + bounds.south) / 2
  const y = paddingMetres / 111_320
  const x = paddingMetres / (111_320 * Math.max(0.2, Math.cos(middleLat * Math.PI / 180)))
  return { west: bounds.west - x, east: bounds.east + x, south: bounds.south - y, north: bounds.north + y }
}

export function roadsWithin(index: readonly RoadBounds[], bounds: GeoBounds): RoadFeature[] {
  return index.filter(box => box.east >= bounds.west && box.west <= bounds.east &&
    box.north >= bounds.south && box.south <= bounds.north).map(box => box.road)
}
