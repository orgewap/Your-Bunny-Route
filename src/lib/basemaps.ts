/** Sources and visibility for a raster satellite overlay on the Liberty map. */
export type BasemapKind = 'map' | 'satellite'

export const SATELLITE_SOURCE_ID = 'editor-satellite-tiles'
export const SATELLITE_LAYER_ID = 'editor-satellite-imagery'

// Public imagery endpoint for local prototypes. Check Esri usage terms before
// deploying a public/commercial service; replace with VITE_SATELLITE_TILE_URL.
export const DEFAULT_SATELLITE_TILES =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'

export const SATELLITE_ATTRIBUTION =
  '<a href="https://www.esri.com/" target="_blank" rel="noopener noreferrer">Esri</a>, Vantor, Earthstar Geographics, GIS User Community'

export function satelliteVisibility(mode: BasemapKind): 'visible' | 'none' {
  return mode === 'satellite' ? 'visible' : 'none'
}
