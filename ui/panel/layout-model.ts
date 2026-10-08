// panel-layout-tree (PL1.1, PL-D1): pure layout-tree model for the panel dock — no Vue, no DOM.
// The whole dock is ONE tree: 'split' containers (row|column) + 'cell' leaves (one per docked
// panel). The central tracks area is a regular cell (TRACKS_PANEL_ID, PL-D2), present exactly
// once. A node's sizePx is its extent ALONG THE PARENT split's axis; exactly one child per split
// is flex (sizePx === null) — the branch containing the tracks cell, else the last child
// (normalize() enforces this). Docking to a window edge inserts at the root level (full
// width/height, req. 2); docking to a cell's edge splits that cell — the "two panels share a
// dimension and resize together" requirement (req. 3) falls out of the tree structure, there is
// no separate size-linking mechanism. All operations are immutable: they return a new tree.

export type LayoutAxis = 'row' | 'column'
export type LayoutEdge = 'left' | 'right' | 'top' | 'bottom'

export interface LayoutCellNode {
  readonly kind: 'cell'
  readonly panelId: string
  readonly sizePx: number | null
}

export interface LayoutSplitNode {
  readonly kind: 'split'
  readonly axis: LayoutAxis
  readonly sizePx: number | null
  readonly children: readonly LayoutNode[]
}

export type LayoutNode = LayoutCellNode | LayoutSplitNode

/** The central tracks area cell (PL-D2): always present, never closable/floating. */
export const TRACKS_PANEL_ID = 'tracks'

export const LAYOUT_VERSION = 1

/** Fallback extent for a freshly docked branch — mirrors the legacy per-panel dock size default. */
export const DEFAULT_CELL_SIZE_PX = 380

/** Hard floor so a mutation can never produce an invisible sliver (UX min sizes are PL4.2). */
export const MIN_CELL_SIZE_PX = 48

/**
 * UX minimum for a panel's CONTENT box (PL-D13, owner 2026-08-14): no resize gesture may shrink
 * the area inside the chrome below 155px in either dimension. The chrome (titlebar + separator
 * along the vertical axis) is MEASURED by the view and added on top — this constant is about the
 * inner part only. The model's MIN_CELL_SIZE_PX above stays a last-resort floor for mutations
 * that don't go through a resize gesture (persisted trees, dockToCell splits).
 */
export const MIN_PANEL_INNER_PX = 155

const MAX_TREE_DEPTH = 32

export const axisOfEdge = (edge: LayoutEdge): LayoutAxis =>
  edge === 'left' || edge === 'right' ? 'row' : 'column'

/** Leading edges insert BEFORE existing content (left/top), trailing ones after (right/bottom). */
export const edgeIsLeading = (edge: LayoutEdge): boolean => edge === 'left' || edge === 'top'

export const layoutCell = (panelId: string, sizePx: number | null = DEFAULT_CELL_SIZE_PX): LayoutCellNode =>
  ({ kind: 'cell', panelId, sizePx })

export const defaultLayout = (): LayoutNode => layoutCell(TRACKS_PANEL_ID, null)

const withSize = (node: LayoutNode, sizePx: number | null): LayoutNode => ({ ...node, sizePx })

const clampSize = (sizePx: number): number => Math.max(MIN_CELL_SIZE_PX, Math.round(sizePx))

export function containsPanel(node: LayoutNode, panelId: string): boolean {
  if (node.kind === 'cell') {
    return node.panelId === panelId
  }
  return node.children.some((child) => containsPanel(child, panelId))
}

/** Every docked panel id in tree order, the tracks cell included. */
export function listPanelIds(node: LayoutNode): string[] {
  if (node.kind === 'cell') {
    return [node.panelId]
  }
  return node.children.flatMap((child) => listPanelIds(child))
}

export const isDockedInTree = (root: LayoutNode, panelId: string): boolean =>
  containsPanel(root, panelId)

/** Path of child indices from the root to the panel's cell; [] = the root IS that cell. */
export function findPanelPath(root: LayoutNode, panelId: string): number[] | null {
  if (root.kind === 'cell') {
    return root.panelId === panelId ? [] : null
  }
  for (let i = 0; i < root.children.length; i += 1) {
    const child = root.children[i]
    if (child === undefined) {
      continue
    }
    const sub = findPanelPath(child, panelId)
    if (sub !== null) {
      return [i, ...sub]
    }
  }
  return null
}

export function nodeAtPath(root: LayoutNode, path: readonly number[]): LayoutNode | null {
  let node: LayoutNode = root
  for (const idx of path) {
    if (node.kind !== 'split') {
      return null
    }
    const child = node.children[idx]
    if (child === undefined) {
      return null
    }
    node = child
  }
  return node
}

/**
 * Axis of the split hosting the panel's cell: 'row' → the panel stands as a vertical sidebar
 * (the legacy left/right docks), 'column' → a horizontal band (top/bottom). Null when the panel
 * is not docked (content layouts like FileOpenPanel's accordion fall back to their wide form).
 */
export function dockAxisOf(root: LayoutNode, panelId: string): LayoutAxis | null {
  const path = findPanelPath(root, panelId)
  if (path === null || path.length === 0) {
    return null
  }
  const parent = nodeAtPath(root, path.slice(0, -1))
  return parent !== null && parent.kind === 'split' ? parent.axis : null
}

/**
 * The single flex child of a split: the branch holding the tracks cell, else the last child.
 * Its sizePx is null; every sibling holds px. The renderer and normalize() share this rule.
 */
export function flexChildIndex(node: LayoutSplitNode): number {
  const idx = node.children.findIndex((child) => containsPanel(child, TRACKS_PANEL_ID))
  return idx >= 0 ? idx : node.children.length - 1
}

/**
 * Canonical form: no empty splits, no single-child splits (the child inherits the container's
 * slot size), no same-axis nesting (grandchildren are spliced up — "insert as sibling"; the
 * subtree's flex child takes over the subtree's px budget minus its px siblings), and exactly
 * one flex child per split per the flexChildIndex rule.
 */
export function normalize(root: LayoutNode): LayoutNode {
  return normalizeNode(root) ?? defaultLayout()
}

function normalizeNode(node: LayoutNode): LayoutNode | null {
  if (node.kind === 'cell') {
    return node
  }
  const flat: LayoutNode[] = []
  for (const raw of node.children) {
    const child = normalizeNode(raw)
    if (child === null) {
      continue
    }
    if (child.kind === 'split' && child.axis === node.axis) {
      flat.push(...spliceSameAxis(child))
      continue
    }
    flat.push(child)
  }
  if (flat.length === 0) {
    return null
  }
  const first = flat[0]
  if (flat.length === 1 && first !== undefined) {
    return withSize(first, node.sizePx)
  }
  const merged: LayoutSplitNode = { kind: 'split', axis: node.axis, sizePx: node.sizePx, children: flat }
  const flexIdx = flexChildIndex(merged)
  const children = flat.map((child, i) => {
    if (i === flexIdx) {
      return child.sizePx === null ? child : withSize(child, null)
    }
    return child.sizePx === null ? withSize(child, DEFAULT_CELL_SIZE_PX) : child
  })
  return { kind: 'split', axis: node.axis, sizePx: node.sizePx, children }
}

function spliceSameAxis(child: LayoutSplitNode): LayoutNode[] {
  const flexIdx = flexChildIndex(child)
  return child.children.map((grandchild, i) => {
    if (i !== flexIdx || grandchild.sizePx !== null || containsPanel(grandchild, TRACKS_PANEL_ID)) {
      return grandchild
    }
    // The subtree's flex child loses its container: give it the container's px budget minus
    // the px siblings so the parent split keeps exactly one flex child overall.
    const siblingPx = child.children.reduce(
      (sum, other, j) => (j === i ? sum : sum + (other.sizePx ?? 0)),
      0,
    )
    const budget = child.sizePx ?? DEFAULT_CELL_SIZE_PX
    return withSize(grandchild, clampSize(budget - siblingPx))
  })
}

/** Remove a panel's cell (no-op for the tracks cell and for panels not in the tree). */
export function removePanel(root: LayoutNode, panelId: string): LayoutNode {
  if (panelId === TRACKS_PANEL_ID) {
    return root
  }
  return normalize(stripPanel(root, panelId) ?? defaultLayout())
}

function stripPanel(node: LayoutNode, panelId: string): LayoutNode | null {
  if (node.kind === 'cell') {
    return node.panelId === panelId ? null : node
  }
  const children = node.children
    .map((child) => stripPanel(child, panelId))
    .filter((child): child is LayoutNode => child !== null)
  return { ...node, children }
}

/**
 * The tree minus the panel's cell, normalized WITHOUT the tracks-restoring fallback; null when
 * nothing remains. Unlike removePanel this strips the tracks cell too — the dock operations use
 * it to implement a MOVE of the tracks cell (PL7.1, PL-D10): strip + insert keeps the
 * «tracks exactly once» invariant, while removePanel keeps refusing to DELETE it.
 */
function removedBase(root: LayoutNode, panelId: string): LayoutNode | null {
  const stripped = stripPanel(root, panelId)
  return stripped === null ? null : normalizeNode(stripped)
}

/**
 * Dock to a window side (req. 2): the panel spans the full available width/height because it is
 * inserted at the ROOT level — wrapping the root in a perpendicular split when needed. For the
 * tracks cell this is a MOVE (PL-D10): its cell stays flex, the rest of the dock becomes the px
 * neighbor (normalize assigns the default px to a flex-less branch).
 */
export function dockToEdge(
  root: LayoutNode,
  panelId: string,
  edge: LayoutEdge,
  sizePx: number = DEFAULT_CELL_SIZE_PX,
): LayoutNode {
  const isTracks = panelId === TRACKS_PANEL_ID
  const base = removedBase(root, panelId)
  if (base === null) {
    return root // the panel WAS the whole tree — nothing to dock against
  }
  const added = layoutCell(panelId, isTracks ? null : clampSize(sizePx))
  const axis = axisOfEdge(edge)
  const leading = edgeIsLeading(edge)
  if (base.kind === 'split' && base.axis === axis) {
    const children = leading ? [added, ...base.children] : [...base.children, added]
    return normalize({ ...base, children })
  }
  const wrapped = withSize(base, null)
  return normalize({
    kind: 'split',
    axis,
    sizePx: null,
    children: leading ? [added, wrapped] : [wrapped, added],
  })
}

/**
 * Dock to a side of an existing cell (req. 3): the target cell is replaced by a split of the two,
 * so both share the perpendicular dimension and resize together structurally. Docking a panel
 * onto itself is a no-op; a vanished target degrades to the corresponding window edge. For the
 * tracks cell this is a MOVE (PL-D10): tracks joins the target as the flex child, the target
 * keeps px.
 */
export function dockToCell(
  root: LayoutNode,
  panelId: string,
  targetPanelId: string,
  edge: LayoutEdge,
  sizePx: number = DEFAULT_CELL_SIZE_PX,
): LayoutNode {
  if (panelId === targetPanelId) {
    return root
  }
  const isTracks = panelId === TRACKS_PANEL_ID
  const base = removedBase(root, panelId)
  if (base === null) {
    return root
  }
  if (findPanelPath(base, targetPanelId) === null) {
    return isTracks ? root : dockToEdge(base, panelId, edge, sizePx)
  }
  const added = layoutCell(panelId, isTracks ? null : clampSize(sizePx))
  const axis = axisOfEdge(edge)
  const leading = edgeIsLeading(edge)
  const replaced = mapCell(base, targetPanelId, (target) => ({
    kind: 'split',
    axis,
    sizePx: target.sizePx,
    children: isTracks
      ? leading
        ? [added, target]
        : [target, added]
      : leading
        ? [added, withSize(target, null)]
        : [withSize(target, null), added],
  }))
  return normalize(replaced)
}

function mapCell(
  node: LayoutNode,
  panelId: string,
  fn: (target: LayoutCellNode) => LayoutNode,
): LayoutNode {
  if (node.kind === 'cell') {
    return node.panelId === panelId ? fn(node) : node
  }
  return { ...node, children: node.children.map((child) => mapCell(child, panelId, fn)) }
}

/** One child's new extent for setChildSizes — index into the split's REAL children array. */
export interface SplitChildSize {
  readonly index: number
  readonly sizePx: number
}

/**
 * Splitter drag (PL-D5, PL-D12): set the px extents of several children of the ONE split at
 * `splitPath` atomically. The plain drag transfers px between the splitter's two neighbours and
 * the Ctrl-drag spreads a delta over a whole group — either way the sizes must land as a single
 * tree replacement so the persist watcher fires once per pointer event and no intermediate
 * (inconsistent) tree ever renders. The caller only ever addresses px-holding children — the
 * result is intentionally NOT normalized so the flex assignment stays untouched mid-drag.
 */
export function setChildSizes(
  root: LayoutNode,
  splitPath: readonly number[],
  updates: readonly SplitChildSize[],
): LayoutNode {
  if (updates.length === 0) {
    return root
  }
  const rec = (node: LayoutNode, depth: number): LayoutNode => {
    if (node.kind !== 'split') {
      return node
    }
    if (depth === splitPath.length) {
      return {
        ...node,
        children: node.children.map((child, i) => {
          const update = updates.find((entry) => entry.index === i)
          return update === undefined ? child : withSize(child, clampSize(update.sizePx))
        }),
      }
    }
    const idx = splitPath[depth]
    if (idx === undefined || idx < 0 || idx >= node.children.length) {
      return node
    }
    return { ...node, children: node.children.map((child, i) => (i === idx ? rec(child, depth + 1) : child)) }
  }
  return rec(root, 0)
}

/** Structural invariants: tracks exactly once, unique panel ids, no degenerate splits. */
export function validateLayout(root: LayoutNode): boolean {
  const ids = listPanelIds(root)
  if (ids.filter((id) => id === TRACKS_PANEL_ID).length !== 1) {
    return false
  }
  if (new Set(ids).size !== ids.length) {
    return false
  }
  return validateShape(root, 0)
}

function validateShape(node: LayoutNode, depth: number): boolean {
  if (depth > MAX_TREE_DEPTH) {
    return false
  }
  if (node.kind === 'cell') {
    return true
  }
  if (node.children.length < 2) {
    return false
  }
  return node.children.every((child) => validateShape(child, depth + 1))
}

// ---- Serialization (PL-D4) --------------------------------------------------------------------

export function serializeLayout(root: LayoutNode): string {
  return JSON.stringify({ v: LAYOUT_VERSION, root })
}

/** Whitelist-parse a persisted layout; anything invalid yields null (caller falls back). */
export function deserializeLayout(raw: string | null | undefined): LayoutNode | null {
  if (raw === null || raw === undefined || raw === '') {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as { v?: unknown; root?: unknown }
    if (typeof parsed !== 'object' || parsed === null || parsed.v !== LAYOUT_VERSION) {
      return null
    }
    const root = sanitizeNode(parsed.root, 0)
    if (root === null) {
      return null
    }
    const normalized = normalize(root)
    return validateLayout(normalized) ? normalized : null
  } catch {
    return null
  }
}

function sanitizeNode(value: unknown, depth: number): LayoutNode | null {
  if (depth > MAX_TREE_DEPTH || typeof value !== 'object' || value === null) {
    return null
  }
  const node = value as Record<string, unknown>
  const sizeRaw = node['sizePx']
  const sizePx = typeof sizeRaw === 'number' && Number.isFinite(sizeRaw) ? clampSize(sizeRaw) : null
  if (node['kind'] === 'cell') {
    const panelId = node['panelId']
    if (typeof panelId !== 'string' || panelId === '') {
      return null
    }
    return { kind: 'cell', panelId, sizePx }
  }
  if (node['kind'] === 'split') {
    const axis = node['axis']
    if (axis !== 'row' && axis !== 'column' || !Array.isArray(node['children'])) {
      return null
    }
    const children: LayoutNode[] = []
    for (const childRaw of node['children'] as unknown[]) {
      const child = sanitizeNode(childRaw, depth + 1)
      if (child === null) {
        return null
      }
      children.push(child)
    }
    return { kind: 'split', axis, sizePx, children }
  }
  return null
}

// ---- Legacy migration (PL-D4) -----------------------------------------------------------------

export interface LegacyPanelDock {
  readonly panelId: string
  /** Legacy PanelMode string; only left/right/top/bottom entries produce a dock. */
  readonly mode: string
  readonly dockSize: number
}

/**
 * One-shot migration from the flat per-panel '<prefix>panel-<id>-mode/-dock-size' scheme:
 * each legacy edge mode becomes a root-level dock in entry order. Floating/detached panels
 * stay out of the tree.
 */
export function migrateLegacyPanelModes(entries: readonly LegacyPanelDock[]): LayoutNode {
  let tree = defaultLayout()
  for (const entry of entries) {
    if (entry.mode === 'left' || entry.mode === 'right' || entry.mode === 'top' || entry.mode === 'bottom') {
      const size = Number.isFinite(entry.dockSize) && entry.dockSize > 0 ? entry.dockSize : DEFAULT_CELL_SIZE_PX
      tree = dockToEdge(tree, entry.panelId, entry.mode, size)
    }
  }
  return tree
}
