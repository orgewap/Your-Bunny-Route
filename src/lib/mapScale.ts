/** The default MapLibre tile world is 512px at zoom 0. */
export const MERCATOR_CIRCUMFERENCE_METRES = 40_075_016.686
export const METRIC_RENDER_ZOOM_STOPS: readonly number[] = [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]
/** One metre in the Mercator map plane in screen pixels at a given zoom. */
export function mercatorPixelsPerMetre(zoom: number, latitudeDegrees = 0): number {
  const latitude = Math.max(-85, Math.min(85, latitudeDegrees))
  return (512 * 2 ** zoom) / (MERCATOR_CIRCUMFERENCE_METRES * Math.cos(latitude * Math.PI / 180))
}
