// panel-layout-tree (PL5.1, PL-D8): the drop-zone model shared by drag-to-dock. Zones mirror the
// minimap's layout exactly (same fractions/band idea) but in SCREEN coordinates over the live
// dock: window-edge bands first (they win hit-testing near the dock border), then per-cell zones
// (sides before top/bottom bands — the same corner priority the minimap gives via z-index).
// A drop applies the SAME tree mutation the minimap click would.
import { listPanelIds, type LayoutEdge } from './layout-model'
import type { PanelLayoutState } from './use-panel-layout'

export interface ZoneRect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface DockZone {
  readonly kind: 'edge' | 'cell'
  readonly edge: LayoutEdge
  /** Target cell for kind 'cell'; null for window edges. */
  readonly targetPanelId: string | null
  readonly rect: ZoneRect
}

/** Width of the window-edge drop bands, px (the minimap's 16px ring, scaled to live size). */
const EDGE_BAND_PX = 28
/** Cell side zones take this fraction of the cell width (minimap: 30%). */
const CELL_SIDE_FRACTION = 0.3
/** Cell top/bottom bands take this fraction of the cell height (minimap: 35%). */
const CELL_BAND_FRACTION = 0.35

/**
 * Zones over the CURRENT dock, excluding the dragged panel's own cell (it is normally already
 * undocked when this runs — the exclusion covers the pre-undock measurement race).
 */
export function computeDockZones(layout: PanelLayoutState, excludePanelId: string): DockZone[] {
  interface MeasuredCell {
    readonly panelId: string
    readonly rect: DOMRect
  }
  // Bounds come from ALL rendered cells (the excluded panel's cell included, if any — a docked
  // panel moved WITHOUT tear-off, PL-D10, still occupies its cell); target zones skip it.
  const all: MeasuredCell[] = []
  for (const panelId of listPanelIds(layout.tree.value)) {
    const host = layout.cellHost(panelId)
    if (host === null) {
      continue
    }
    const rect = host.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) {
      continue
    }
    all.push({ panelId, rect })
  }
  const cells = all.filter((cell) => cell.panelId !== excludePanelId)
  if (cells.length === 0) {
    return []
  }
  const left = Math.min(...all.map((c) => c.rect.left))
  const top = Math.min(...all.map((c) => c.rect.top))
  const right = Math.max(...all.map((c) => c.rect.right))
  const bottom = Math.max(...all.map((c) => c.rect.bottom))

  const zones: DockZone[] = [
    { kind: 'edge', edge: 'left', targetPanelId: null, rect: { x: left, y: top, w: EDGE_BAND_PX, h: bottom - top } },
    { kind: 'edge', edge: 'right', targetPanelId: null, rect: { x: right - EDGE_BAND_PX, y: top, w: EDGE_BAND_PX, h: bottom - top } },
    { kind: 'edge', edge: 'top', targetPanelId: null, rect: { x: left, y: top, w: right - left, h: EDGE_BAND_PX } },
    { kind: 'edge', edge: 'bottom', targetPanelId: null, rect: { x: left, y: bottom - EDGE_BAND_PX, w: right - left, h: EDGE_BAND_PX } },
  ]
  for (const cell of cells) {
    const r = cell.rect
    const sideW = r.width * CELL_SIDE_FRACTION
    const bandH = r.height * CELL_BAND_FRACTION
    zones.push(
      { kind: 'cell', edge: 'left', targetPanelId: cell.panelId, rect: { x: r.left, y: r.top, w: sideW, h: r.height } },
      { kind: 'cell', edge: 'right', targetPanelId: cell.panelId, rect: { x: r.right - sideW, y: r.top, w: sideW, h: r.height } },
      { kind: 'cell', edge: 'top', targetPanelId: cell.panelId, rect: { x: r.left, y: r.top, w: r.width, h: bandH } },
      { kind: 'cell', edge: 'bottom', targetPanelId: cell.panelId, rect: { x: r.left, y: r.bottom - bandH, w: r.width, h: bandH } },
    )
  }
  return zones
}

/** First zone containing the point wins — the array order IS the priority. */
export function hitTestZone(zones: readonly DockZone[], x: number, y: number): DockZone | null {
  return (
    zones.find(
      (zone) =>
        x >= zone.rect.x && x < zone.rect.x + zone.rect.w && y >= zone.rect.y && y < zone.rect.y + zone.rect.h,
    ) ?? null
  )
}
