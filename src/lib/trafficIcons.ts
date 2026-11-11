import type { Map } from 'maplibre-gl'
import type { InfrastructureKind } from './infrastructure'

/** Draw pixel-perfect road-sign glyphs into MapLibre's sprite atlas.
 * No external image server or icon font is needed; selection uses icon halos. */
const MARKERS: readonly Exclude<InfrastructureKind, 'stop_line'>[] = [
  'traffic_signal', 'stop', 'give_way', 'crossing',
]

function polygon(ctx: CanvasRenderingContext2D, points: readonly [number, number][]): void {
  ctx.beginPath()
  points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))
  ctx.closePath()
}
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
}
function icon(kind: Exclude<InfrastructureKind, 'stop_line'>): ImageData {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d')!
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  if (kind === 'traffic_signal') {
    roundRect(ctx, 20, 5, 24, 54, 7)
    ctx.fillStyle = '#171d26'; ctx.fill()
    ctx.strokeStyle = '#f2f5f7'; ctx.lineWidth = 3; ctx.stroke()
    for (const [y, color] of [[16, '#e4474b'], [32, '#efbd3b'], [48, '#30c579']] as const) {
      ctx.beginPath(); ctx.arc(32, y, 6, 0, Math.PI * 2)
      ctx.fillStyle = color; ctx.fill()
    }
  } else if (kind === 'stop') {
    polygon(ctx, [[20, 6], [44, 6], [58, 20], [58, 44], [44, 58], [20, 58], [6, 44], [6, 20]])
    ctx.fillStyle = '#cf3341'; ctx.fill()
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 3.5; ctx.stroke()
    ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.font = 'bold 15px Arial, sans-serif'; ctx.fillText('STOP', 32, 33)
  } else if (kind === 'give_way') {
    polygon(ctx, [[5, 9], [59, 9], [32, 57]])
    ctx.fillStyle = '#ffffff'; ctx.fill()
    ctx.strokeStyle = '#d93e42'; ctx.lineWidth = 8; ctx.stroke()
    polygon(ctx, [[15, 15], [49, 15], [32, 45]])
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.stroke()
  } else {
    roundRect(ctx, 7, 7, 50, 50, 5)
    ctx.fillStyle = '#247bbb'; ctx.fill()
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 3; ctx.stroke()
    polygon(ctx, [[32, 12], [53, 50], [11, 50]])
    ctx.fillStyle = '#ffffff'; ctx.fill()
    ctx.beginPath(); ctx.arc(30, 25, 3, 0, Math.PI * 2)
    ctx.fillStyle = '#1d6593'; ctx.fill()
    ctx.strokeStyle = '#1d6593'; ctx.lineWidth = 2.7
    ctx.beginPath(); ctx.moveTo(30, 29); ctx.lineTo(32, 38)
    ctx.moveTo(32, 38); ctx.lineTo(24, 44)
    ctx.moveTo(32, 38); ctx.lineTo(39, 44)
    ctx.moveTo(31, 32); ctx.lineTo(39, 35); ctx.stroke()
  }
  return ctx.getImageData(0, 0, 64, 64)
}

export function registerTrafficIcons(map: Map): void {
  for (const kind of MARKERS) {
    const name = `editor-infra-${kind}`
    if (!map.hasImage(name)) map.addImage(name, icon(kind), { pixelRatio: 2 })
  }
}
