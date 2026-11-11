export type EditorTool = 'select' | 'roundabout' | 'junction' | 'infrastructure' | 'delete' | 'pen' | 'walk-route'
export type PenMode = 'draw' | 'curve' | 'freehand' | 'ellipse'
export type ViewMode = '2d' | '3d'

export interface RoadVertex {
  id: string
  lng: number
  lat: number
}

export interface RoadFeature {
  id: string
  /** Original OSM way ID. New ways use negative IDs. */
  osmId: string
  name: string
  highway: string
  lanes: number
  oneway: boolean
  bridge: boolean
  level: number
  vertices: RoadVertex[]
  /** Internal editor-only surface styling. Never serialized as an OSM tag. */
  visualApproach?: { start?: boolean; end?: boolean }
  /** All original OSM tags, including unsupported ones. */
  tags: Record<string, string>
}

export type RoadPatch = Partial<Pick<RoadFeature, 'name' | 'highway' | 'lanes' | 'oneway' | 'bridge' | 'level'>>

export interface ImportedProject {
  xml: string
  roads: RoadFeature[]
  name: string
  allNodeCount: number
  allWayCount: number
  allWayIds: string[]
  relationCount: number
  warnings: string[]
}
