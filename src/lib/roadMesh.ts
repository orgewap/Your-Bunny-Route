import { appendSceneInfrastructure, appendScenePedestrianSurfaces } from './scene3d'
import type { SceneBarrier, SceneDetailLevel } from './scene3d'
import type { InfrastructureFeature, InfrastructurePlacementIndex } from './infrastructure'
import type { CrosswalkFeature } from './crosswalks'
import type { RoadMarkingFeature } from './roadMarkings'
import { MercatorCoordinate } from 'maplibre-gl'
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl'
import type { RoadFeature } from '../types/road'
import { LEVEL_HEIGHT_METRES, bridgeNodeHeights, sampleElevatedRoad } from './bridges'
import { clampRoadLanes, LANE_WIDTH_METRES } from './lanes'
import { ROAD_STATUS_COLORS } from './roadStatus'
import type { RoadStatus } from './roadStatus'

/** Road surface, furniture and pedestrian pavement use separate GPU buffers.
 * Updating a traffic light must not rebuild the full road mesh. */
export class RoadMeshLayer implements CustomLayerInterface {
  readonly id = 'editor-road-mesh'
  readonly type = 'custom' as const
  readonly renderingMode = '3d' as const

  private map: MapLibreMap | null = null
  private gl: WebGLRenderingContext | null = null
  private program: WebGLProgram | null = null
  private roadBuffer: WebGLBuffer | null = null
  private statusBuffer: WebGLBuffer | null = null
  private roadFurnitureBuffer: WebGLBuffer | null = null
  private infrastructureBuffer: WebGLBuffer | null = null
  private pedestrianBuffer: WebGLBuffer | null = null
  private positionIndex = -1
  private colorIndex = -1
  private projectionUniform: WebGLUniformLocation | null = null
  private origin: [number, number] = [0, 0]
  private roadMesh = new Float32Array(0)
  private statusMesh = new Float32Array(0)
  private roadFurnitureMesh = new Float32Array(0)
  private infrastructureMesh = new Float32Array(0)
  private pedestrianMesh = new Float32Array(0)
  private lastCameraMatrix: number[] | null = null
  private roadDirty = false
  private statusDirty = false
  private roadFurnitureDirty = false
  private infrastructureDirty = false
  private pedestrianDirty = false
  private enabled = false
  private roadStatuses: ReadonlyMap<string, RoadStatus> = new Map()

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return
    this.enabled = enabled
    this.map?.triggerRepaint()
  }

  projectToScreen(lng: number, lat: number, height: number): { x: number; y: number } | null {
    const m = this.lastCameraMatrix
    const canvas = this.map?.getCanvas()
    if (!m || !canvas) return null
    const p = MercatorCoordinate.fromLngLat([lng, lat], height)
    const x = m[0]! * p.x + m[4]! * p.y + m[8]! * p.z + m[12]!
    const y = m[1]! * p.x + m[5]! * p.y + m[9]! * p.z + m[13]!
    const w = m[3]! * p.x + m[7]! * p.y + m[11]! * p.z + m[15]!
    if (w <= 0.000001) return null
    return { x: (x / w + 1) * canvas.clientWidth / 2, y: (1 - y / w) * canvas.clientHeight / 2 }
  }

  setStatuses(statuses: ReadonlyMap<string, RoadStatus>): void {
    this.roadStatuses = statuses
  }

  private sceneEmitter(data: number[]) {
    return (lng: number, lat: number, height: number, rgb: number[]) => {
      const coord = MercatorCoordinate.fromLngLat([lng, lat], height)
      data.push(coord.x - this.origin[0], coord.y - this.origin[1], coord.z, rgb[0]!, rgb[1]!, rgb[2]!)
    }
  }

  setRoads(roads: readonly RoadFeature[], selectedId: string | null,
    originRoads: readonly RoadFeature[] = roads): void {
    const heights = bridgeNodeHeights(roads)
    const data: number[] = []
    const first = originRoads.find(road => road.vertices.length >= 2)?.vertices[0]
    const origin = first ? MercatorCoordinate.fromLngLat([first.lng, first.lat]) : null
    this.origin = origin ? [origin.x, origin.y] : [0, 0]
    const emit = this.sceneEmitter(data)
    const triangle = (a: [number, number, number], b: [number, number, number],
      c: [number, number, number], rgb: number[]) => {
      emit(a[0], a[1], a[2], rgb)
      emit(b[0], b[1], b[2], rgb)
      emit(c[0], c[1], c[2], rgb)
    }
    for (const road of roads) {
      if (road.vertices.length < 2) continue
      const ramps = road.level === 0 && road.vertices.some(vertex => heights.has(vertex.id))
      const coords = ramps ? sampleElevatedRoad(road, heights, 7)
        : road.vertices.map(vertex => ({ lng: vertex.lng, lat: vertex.lat,
          height: road.level * LEVEL_HEIGHT_METRES }))
      if (coords.length < 2) continue
      const width = Math.max(3.5, clampRoadLanes(road.lanes) * LANE_WIDTH_METRES) / 2
      const rgb = road.id === selectedId ? [0.23, 0.80, 0.73] : road.level > 0 ? [0.67, 0.54, 0.37] : [0.33, 0.42, 0.49]
      const sideColor = road.level > 0 ? [0.34, 0.28, 0.22] : [0.20, 0.27, 0.33]
      const rails: Array<{ left: [number, number, number]; right: [number, number, number] }> = []
      for (let i = 0; i < coords.length; i++) {
        const current = coords[i]!
        const prev = coords[Math.max(0, i - 1)]!
        const next = coords[Math.min(coords.length - 1, i + 1)]!
        const lngScale = 111_320 * Math.max(0.01, Math.cos(current.lat * Math.PI / 180))
        const dx = (next.lng - prev.lng) * lngScale
        const dy = (next.lat - prev.lat) * 111_320
        const magnitude = Math.hypot(dx, dy)
        if (magnitude < 0.001) continue
        const dxNorm = -dy / magnitude * width / lngScale
        const dyNorm = dx / magnitude * width / 111_320
        const z = current.height + 0.18
        rails.push({ left: [current.lng + dxNorm, current.lat + dyNorm, z], right: [current.lng - dxNorm, current.lat - dyNorm, z] })
      }
      for (let i = 1; i < rails.length; i++) {
        const a = rails[i - 1]!, b = rails[i]!
        triangle(a.left, a.right, b.left, rgb)
        triangle(b.left, a.right, b.right, rgb)
        if (road.bridge) {
          const aLow: [number, number, number] = [a.left[0], a.left[1], Math.max(0, a.left[2] - 0.40)]
          const bLow: [number, number, number] = [b.left[0], b.left[1], Math.max(0, b.left[2] - 0.40)]
          const aRightLow: [number, number, number] = [a.right[0], a.right[1], Math.max(0, a.right[2] - 0.40)]
          const bRightLow: [number, number, number] = [b.right[0], b.right[1], Math.max(0, b.right[2] - 0.40)]
          triangle(a.left, b.left, aLow, sideColor)
          triangle(b.left, bLow, aLow, sideColor)
          triangle(a.right, aRightLow, b.right, sideColor)
          triangle(b.right, aRightLow, bRightLow, sideColor)
        }
      }
    }
    this.roadMesh = new Float32Array(data)
    this.roadDirty = true
    this.map?.triggerRepaint()
  }

  setRoadStatusSurface(roads: readonly RoadFeature[]): void {
    const heights = bridgeNodeHeights(roads)
    const data: number[] = []
    const emit = this.sceneEmitter(data)
    const triangle = (a: [number, number, number], b: [number, number, number],
      c: [number, number, number], color: [number, number, number]) => {
      emit(a[0], a[1], a[2], color)
      emit(b[0], b[1], b[2], color)
      emit(c[0], c[1], c[2], color)
    }
    for (const road of roads) {
      if (road.vertices.length < 2) continue
      const ramps = road.level === 0 && road.vertices.some(vertex => heights.has(vertex.id))
      const coords = ramps ? sampleElevatedRoad(road, heights, 7)
        : road.vertices.map(vertex => ({ lng: vertex.lng, lat: vertex.lat,
          height: road.level * LEVEL_HEIGHT_METRES }))
      if (coords.length < 2) continue
      const width = Math.max(3.5, clampRoadLanes(road.lanes) * LANE_WIDTH_METRES) / 2
      const statusHex = ROAD_STATUS_COLORS[this.roadStatuses.get(road.id) ?? 'imported']
      const statusColor = [1, 3, 5].map(offset => parseInt(statusHex.slice(offset, offset + 2), 16) / 255) as [number, number, number]
      const rails: Array<{ left: [number, number, number]; right: [number, number, number] }> = []
      for (let i = 0; i < coords.length; i++) {
        const current = coords[i]!
        const prev = coords[Math.max(0, i - 1)]!
        const next = coords[Math.min(coords.length - 1, i + 1)]!
        const lngScale = 111_320 * Math.max(0.01, Math.cos(current.lat * Math.PI / 180))
        const dx = (next.lng - prev.lng) * lngScale
        const dy = (next.lat - prev.lat) * 111_320
        const magnitude = Math.hypot(dx, dy)
        if (magnitude < 0.001) continue
        const dxNorm = -dy / magnitude * width / lngScale
        const dyNorm = dx / magnitude * width / 111_320
        const z = current.height + 0.18
        rails.push({ left: [current.lng + dxNorm, current.lat + dyNorm, z],
          right: [current.lng - dxNorm, current.lat - dyNorm, z] })
      }
      for (let i = 1; i < rails.length; i++) {
        const a = rails[i - 1]!, b = rails[i]!
        const fraction = Math.min(0.25, 0.20 / (2 * width))
        const inner = (edge: [number, number, number], other: [number, number, number]): [number, number, number] => [
          edge[0] + (other[0] - edge[0]) * fraction,
          edge[1] + (other[1] - edge[1]) * fraction,
          edge[2] + 0.025,
        ]
        const high = (edge: [number, number, number]): [number, number, number] => [edge[0], edge[1], edge[2] + 0.025]
        const aLeft = high(a.left), bLeft = high(b.left)
        const aRight = high(a.right), bRight = high(b.right)
        const aLeftInner = inner(a.left, a.right), bLeftInner = inner(b.left, b.right)
        const aRightInner = inner(a.right, a.left), bRightInner = inner(b.right, b.left)
        triangle(aLeft, aLeftInner, bLeft, statusColor)
        triangle(bLeft, aLeftInner, bLeftInner, statusColor)
        triangle(aRightInner, aRight, bRightInner, statusColor)
        triangle(bRightInner, aRight, bRight, statusColor)
      }
    }
    this.statusMesh = new Float32Array(data)
    this.statusDirty = true
    this.map?.triggerRepaint()
  }

  setRoadInfrastructure(roads: readonly RoadFeature[], barriers: readonly SceneBarrier[] = [],
    markingLines: readonly RoadMarkingFeature[] = [], detail: SceneDetailLevel = 2,
    placementIndex?: InfrastructurePlacementIndex): void {
    const data: number[] = []
    const emit = this.sceneEmitter(data)
    const triangle = (a: [number, number, number], b: [number, number, number],
      c: [number, number, number], color: [number, number, number]) => {
      emit(a[0], a[1], a[2], color)
      emit(b[0], b[1], b[2], color)
      emit(c[0], c[1], c[2], color)
    }
    appendSceneInfrastructure(triangle, roads, [], [], barriers, markingLines, detail, placementIndex,
      { roadFurniture: true, controls: false })
    this.roadFurnitureMesh = new Float32Array(data)
    this.roadFurnitureDirty = true
    this.map?.triggerRepaint()
  }

  setInfrastructure(roads: readonly RoadFeature[], features: readonly InfrastructureFeature[] = [],
    crossings: readonly CrosswalkFeature[] = [], barriers: readonly SceneBarrier[] = [],
    markingLines: readonly RoadMarkingFeature[] = [], detail: SceneDetailLevel = 2,
    placementIndex?: InfrastructurePlacementIndex): void {
    const data: number[] = []
    const emit = this.sceneEmitter(data)
    const triangle = (a: [number, number, number], b: [number, number, number],
      c: [number, number, number], color: [number, number, number]) => {
      emit(a[0], a[1], a[2], color)
      emit(b[0], b[1], b[2], color)
      emit(c[0], c[1], c[2], color)
    }
    appendSceneInfrastructure(triangle, roads, features, crossings, barriers, markingLines, detail, placementIndex,
      { roadFurniture: false, controls: true })
    this.infrastructureMesh = new Float32Array(data)
    this.infrastructureDirty = true
    this.map?.triggerRepaint()
  }

  setPedestrianSurfaces(roads: readonly RoadFeature[], detail: SceneDetailLevel = 2, crossings: readonly CrosswalkFeature[] = []): void {
    const data: number[] = []
    const emit = this.sceneEmitter(data)
    const triangle = (a: [number, number, number], b: [number, number, number],
      c: [number, number, number], color: [number, number, number]) => {
      emit(a[0], a[1], a[2], color)
      emit(b[0], b[1], b[2], color)
      emit(c[0], c[1], c[2], color)
    }
    appendScenePedestrianSurfaces(triangle, roads, detail, crossings)
    this.pedestrianMesh = new Float32Array(data)
    this.pedestrianDirty = true
    this.map?.triggerRepaint()
  }

  onAdd(map: MapLibreMap, gl: WebGLRenderingContext): void {
    this.map = map
    this.gl = gl
    try {
      const compile = (kind: number, source: string) => {
        const shader = gl.createShader(kind)
        if (!shader) throw new Error('WebGL shader creation failed')
        gl.shaderSource(shader, source)
        gl.compileShader(shader)
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'WebGL shader compilation failed')
        return shader
      }
      const vertex = compile(gl.VERTEX_SHADER, `
        precision highp float;
        attribute vec3 a_position;
        attribute vec3 a_color;
        uniform mat4 u_matrix;
        varying vec3 v_color;
        void main() {
          gl_Position = u_matrix * vec4(a_position, 1.0);
          v_color = a_color;
        }
      `)
      const fragment = compile(gl.FRAGMENT_SHADER, `
        precision mediump float;
        varying vec3 v_color;
        void main() { gl_FragColor = vec4(v_color, 0.98); }
      `)
      const program = gl.createProgram()
      if (!program) throw new Error('WebGL program creation failed')
      gl.attachShader(program, vertex)
      gl.attachShader(program, fragment)
      gl.linkProgram(program)
      gl.deleteShader(vertex)
      gl.deleteShader(fragment)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'WebGL program link failed')
      this.program = program
      this.positionIndex = gl.getAttribLocation(program, 'a_position')
      this.colorIndex = gl.getAttribLocation(program, 'a_color')
      this.projectionUniform = gl.getUniformLocation(program, 'u_matrix')
      this.roadBuffer = gl.createBuffer()
      this.statusBuffer = gl.createBuffer()
      this.roadFurnitureBuffer = gl.createBuffer()
      this.infrastructureBuffer = gl.createBuffer()
      this.pedestrianBuffer = gl.createBuffer()
      this.roadDirty = this.statusDirty = this.roadFurnitureDirty = this.infrastructureDirty = this.pedestrianDirty = true
    } catch (error) {
      console.warn('3D road mesh unavailable; fallback line layer remains visible:', error)
    }
  }

  render(gl: WebGLRenderingContext, args: CustomRenderMethodInput): void {
    if (this.enabled) this.lastCameraMatrix = Array.from(args.defaultProjectionData.mainMatrix)
    if (!this.enabled || !this.program || !this.projectionUniform) return
    const source = args.defaultProjectionData.mainMatrix
    const matrix = new Float32Array(source)
    const [x, y] = this.origin
    for (let i = 0; i < 4; i++) matrix[12 + i] = source[i]! * x + source[4 + i]! * y + source[12 + i]!
    gl.useProgram(this.program)
    gl.uniformMatrix4fv(this.projectionUniform, false, matrix)
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LEQUAL)
    gl.disable(gl.CULL_FACE)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

    const draw = (buffer: WebGLBuffer | null, data: Float32Array, dirty: boolean,
      markClean: () => void) => {
      if (!buffer || !data.length) return
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      if (dirty) {
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW)
        markClean()
      }
      gl.enableVertexAttribArray(this.positionIndex)
      gl.vertexAttribPointer(this.positionIndex, 3, gl.FLOAT, false, 24, 0)
      gl.enableVertexAttribArray(this.colorIndex)
      gl.vertexAttribPointer(this.colorIndex, 3, gl.FLOAT, false, 24, 12)
      gl.drawArrays(gl.TRIANGLES, 0, data.length / 6)
    }
    draw(this.roadBuffer, this.roadMesh, this.roadDirty, () => { this.roadDirty = false })
    draw(this.statusBuffer, this.statusMesh, this.statusDirty, () => { this.statusDirty = false })
    draw(this.roadFurnitureBuffer, this.roadFurnitureMesh, this.roadFurnitureDirty, () => { this.roadFurnitureDirty = false })
    draw(this.infrastructureBuffer, this.infrastructureMesh, this.infrastructureDirty, () => { this.infrastructureDirty = false })
    draw(this.pedestrianBuffer, this.pedestrianMesh, this.pedestrianDirty, () => { this.pedestrianDirty = false })
    gl.disableVertexAttribArray(this.positionIndex)
    gl.disableVertexAttribArray(this.colorIndex)
  }

  onRemove(_map: MapLibreMap, gl: WebGLRenderingContext): void {
    if (this.roadBuffer) gl.deleteBuffer(this.roadBuffer)
    if (this.statusBuffer) gl.deleteBuffer(this.statusBuffer)
    if (this.roadFurnitureBuffer) gl.deleteBuffer(this.roadFurnitureBuffer)
    if (this.infrastructureBuffer) gl.deleteBuffer(this.infrastructureBuffer)
    if (this.pedestrianBuffer) gl.deleteBuffer(this.pedestrianBuffer)
    if (this.program) gl.deleteProgram(this.program)
    this.roadBuffer = null
    this.statusBuffer = null
    this.roadFurnitureBuffer = null
    this.infrastructureBuffer = null
    this.pedestrianBuffer = null
    this.program = null
    this.map = null
    this.gl = null
  }
}
