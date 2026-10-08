/**
 * The line-letter atlas, drawn at runtime on a 2D canvas (browser only): one cell per line, a
 * rounded square in the line's colour with its label in dark ink. Plain text in our own style;
 * no MTA bullets, fonts or logos, and no font files to download.
 */
import { CanvasTexture, SRGBColorSpace } from 'three'
import { atlasLayout, type AtlasLayout } from './buildLabels'

export interface LabelAtlas {
  readonly texture: CanvasTexture
  readonly layout: AtlasLayout
  /** Line id to atlas cell. */
  readonly cellIndex: ReadonlyMap<string, number>
}

/** Chip artwork as fractions of a cell (data/config/scene.json `labels`). */
export interface ChipArt {
  readonly atlasCellPx: number
  /** The rest of the cell stays transparent, so neighbouring chips never touch. */
  readonly chipFill: number
  readonly cornerRadius: number
  readonly fontScale: number
  readonly textMaxWidth: number
}

const FONT_STACK = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'

export function createLabelAtlas(
  lines: readonly { readonly id: string; readonly label: string }[],
  colorById: ReadonlyMap<string, string>,
  inkHex: string,
  art: ChipArt,
): LabelAtlas {
  const cellPx = art.atlasCellPx
  const ordered = [...lines].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const layout = atlasLayout(ordered.length)
  const canvas = document.createElement('canvas')
  canvas.width = layout.cols * cellPx
  canvas.height = layout.rows * cellPx
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('labels: 2D canvas is unavailable')

  const chip = cellPx * art.chipFill
  const inset = (cellPx - chip) / 2
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  const cellIndex = new Map<string, number>()
  ordered.forEach((line, index) => {
    const color = colorById.get(line.id)
    if (color === undefined) throw new Error(`labels: no colour for line "${line.id}"`)
    const left = (index % layout.cols) * cellPx
    const top = Math.floor(index / layout.cols) * cellPx
    context.fillStyle = color
    context.beginPath()
    context.roundRect(left + inset, top + inset, chip, chip, chip * art.cornerRadius)
    context.fill()
    context.fillStyle = inkHex
    context.font = `800 ${Math.round(cellPx * art.fontScale)}px ${FONT_STACK}`
    // maxWidth squeezes three-letter labels (SIR) into the chip instead of overflowing it.
    context.fillText(line.label, left + cellPx / 2, top + cellPx / 2, chip * art.textMaxWidth)
    cellIndex.set(line.id, index)
  })

  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  return { texture, layout, cellIndex }
}
