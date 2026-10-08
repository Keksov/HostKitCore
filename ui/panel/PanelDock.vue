<template>
  <!-- panel-layout-tree (PL2.1, PL-D5): recursive renderer of the layout tree. A split node is a
       flex row/column of its VISIBLE children with drag-splitters between them; a cell node is an
       empty host element the panel's CONTENT teleports itself into — a docked PanelWindow, or the
       host page's central tracks area (PL-D2, via cellHost(TRACKS_PANEL_ID)). Content is never
       rendered through slots here: a structural tree change recreates these wrapper divs, and
       teleported content survives that as a DOM move while slot content would remount. Hidden
       panels (closed / detached) keep their cell in the TREE but are simply not rendered —
       reopening restores the panel to its place. -->
  <div
    v-if="splitNode !== null"
    ref="splitEl"
    class="panel-dock__split"
    :class="`panel-dock__split--${splitNode.axis}`"
  >
    <template v-for="(child, pos) in visibleChildren" :key="childKey(child)">
      <div
        v-if="pos > 0"
        class="panel-dock__splitter"
        :class="`panel-dock__splitter--${splitNode.axis}`"
        @pointerdown="onSplitterPointerDown($event, pos)"
      />
      <PanelDock
        :node="child.node"
        :path="child.path"
        :hidden-panel-ids="hiddenPanelIds"
        :style="childStyle(child)"
      />
    </template>
  </div>
  <div
    v-else
    :ref="onCellRef"
    class="panel-dock__cell"
    :class="{ 'panel-dock__cell--tracks': isTracksCell }"
    :data-panel-cell="cellPanelId ?? ''"
  />
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  DEFAULT_CELL_SIZE_PX,
  MIN_PANEL_INNER_PX,
  TRACKS_PANEL_ID,
  containsPanel,
  type LayoutAxis,
  type LayoutNode,
  type LayoutSplitNode,
  type SplitChildSize,
} from './layout-model'
import { usePanelLayout } from './use-panel-layout'

const props = defineProps<{
  /** Subtree to render; the ROOT instance omits it and renders the live layout tree. */
  readonly node?: LayoutNode
  /** Real child-index path of `node` in the FULL tree — resize targets address the real tree. */
  readonly path?: readonly number[]
  /** Docked panels currently not shown (closed / detached); their cells are skipped, not removed. */
  readonly hiddenPanelIds?: readonly string[]
}>()

const layout = usePanelLayout()

const node = computed<LayoutNode>(() => props.node ?? layout.tree.value)
const path = computed<readonly number[]>(() => props.path ?? [])
const hidden = computed<ReadonlySet<string>>(() => new Set(props.hiddenPanelIds ?? []))

const splitNode = computed<LayoutSplitNode | null>(() => (node.value.kind === 'split' ? node.value : null))
const cellPanelId = computed<string | null>(() => (node.value.kind === 'cell' ? node.value.panelId : null))
const isTracksCell = computed<boolean>(() => cellPanelId.value === TRACKS_PANEL_ID)

const isVisible = (candidate: LayoutNode): boolean => {
  if (candidate.kind === 'cell') {
    return candidate.panelId === TRACKS_PANEL_ID || !hidden.value.has(candidate.panelId)
  }
  return candidate.children.some((child) => isVisible(child))
}

interface RenderChild {
  readonly node: LayoutNode
  /** Index in the REAL children array (≠ position among visible ones). */
  readonly index: number
  readonly path: readonly number[]
  /** Extent along the split axis; null = this is the flex child. */
  readonly px: number | null
}

// The flex rule mirrors flexChildIndex(), but over the VISIBLE children only: when the tree's
// designated flex child is hidden, the last visible one flexes so the split still fills its box.
const visibleChildren = computed<readonly RenderChild[]>(() => {
  const split = splitNode.value
  if (split === null) {
    return []
  }
  const visible = split.children
    .map((child, index) => ({ child, index }))
    .filter((entry) => isVisible(entry.child))
  const tracksPos = visible.findIndex((entry) => containsPanel(entry.child, TRACKS_PANEL_ID))
  const flexPos = tracksPos >= 0 ? tracksPos : visible.length - 1
  return visible.map((entry, pos) => ({
    node: entry.child,
    index: entry.index,
    path: [...path.value, entry.index],
    px: pos === flexPos ? null : entry.child.sizePx ?? DEFAULT_CELL_SIZE_PX,
  }))
})

const childKey = (child: RenderChild): string =>
  child.node.kind === 'cell' ? `cell-${child.node.panelId}` : `split-${child.index}`

const childStyle = (child: RenderChild): Record<string, string> =>
  child.px === null ? { flex: '1 1 auto' } : { flex: `0 0 ${child.px}px` }

const splitEl = ref<HTMLElement | null>(null)

// Keep in sync with .panel-dock__splitter { flex-basis } below.
const SPLITTER_EXTENT_PX = 6

// PL-D13: minimal extent of a rendered subtree along `axis` — every panel keeps at least
// MIN_PANEL_INNER_PX of CONTENT in both dimensions. A cell adds its MEASURED chrome (titlebar +
// separator matter only for the vertical extent; a docked panel has no horizontal chrome), a
// same-axis split sums its visible children plus the splitters between them, a perpendicular
// split needs its tallest/widest child.
const cellChromePx = (panelId: string, axis: LayoutAxis): number => {
  if (axis === 'row') {
    return 0
  }
  const host = layout.cellHost(panelId)
  const bar = host?.querySelector<HTMLElement>('.panel-window__titlebar') ?? null
  const sep = host?.querySelector<HTMLElement>('.panel-window > .q-separator') ?? null
  return (bar?.offsetHeight ?? 0) + (sep?.offsetHeight ?? 0)
}

const minExtentOf = (candidate: LayoutNode, axis: LayoutAxis): number => {
  if (candidate.kind === 'cell') {
    return MIN_PANEL_INNER_PX + cellChromePx(candidate.panelId, axis)
  }
  const visible = candidate.children.filter((child) => isVisible(child))
  if (visible.length === 0) {
    return 0
  }
  if (candidate.axis === axis) {
    return (
      visible.reduce((sum, child) => sum + minExtentOf(child, axis), 0) +
      SPLITTER_EXTENT_PX * (visible.length - 1)
    )
  }
  return Math.max(...visible.map((child) => minExtentOf(child, axis)))
}

// Generic pointer-drag (as in PanelWindow): window listeners until pointerup.
const beginDrag = (onMove: (event: PointerEvent) => void): void => {
  const move = (event: PointerEvent): void => onMove(event)
  const up = (): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

// Splitter between visible children pos-1 and pos (PL-D12). The plain drag moves ONLY the
// splitter itself: the delta is transferred between its two neighbours (their px sum is
// constant, so the flex branch — wherever it is — and every other border stay put). When one
// neighbour IS the flex child it holds no px — the single px neighbour is adjusted and the flex
// absorbs the delta, which pins the outer borders all the same. Ctrl-drag is a group resize:
// the delta is split EQUALLY between all px children on the side OPPOSITE the flex branch
// (dragging towards the group shrinks each of them, away — grows), the flex absorbs the sum.
const onSplitterPointerDown = (event: PointerEvent, pos: number): void => {
  const split = splitNode.value
  const children = visibleChildren.value
  const before = children[pos - 1]
  const after = children[pos]
  if (split === null || before === undefined || after === undefined) {
    return
  }
  const horizontal = split.axis === 'row'
  event.preventDefault()
  const start = horizontal ? event.clientX : event.clientY
  const splitPath = path.value

  // PL-D13: the flex branch is clamped too, so its rendered extent is measured once at drag
  // start — container minus the px children minus the splitters (there is no single element to
  // read when the flex child is a nested split).
  const containerRect = splitEl.value?.getBoundingClientRect() ?? null
  const containerExtent = containerRect === null ? 0 : horizontal ? containerRect.width : containerRect.height
  const flexExtent = Math.max(
    0,
    containerExtent -
      children.reduce((sum, child) => sum + (child.px ?? 0), 0) -
      SPLITTER_EXTENT_PX * (children.length - 1),
  )

  if (!event.ctrlKey) {
    const beforePx = before.px
    const afterPx = after.px
    const minBefore = minExtentOf(before.node, split.axis)
    const minAfter = minExtentOf(after.node, split.axis)
    const beforeExtent = beforePx ?? flexExtent
    const afterExtent = afterPx ?? flexExtent
    beginDrag((moveEvent) => {
      let delta = (horizontal ? moveEvent.clientX : moveEvent.clientY) - start
      delta = Math.max(delta, minBefore - beforeExtent)
      delta = Math.min(delta, afterExtent - minAfter)
      const updates: SplitChildSize[] = []
      if (beforePx !== null) {
        updates.push({ index: before.index, sizePx: beforePx + delta })
      }
      if (afterPx !== null) {
        updates.push({ index: after.index, sizePx: afterPx - delta })
      }
      layout.resizeChildrenAtPath(splitPath, updates)
    })
    return
  }

  const flexPos = children.findIndex((child) => child.px === null)
  const flexChild = children[flexPos]
  const minFlex = flexChild === undefined ? 0 : minExtentOf(flexChild.node, split.axis)
  const groupOnAfterSide = flexPos < pos
  const group = groupOnAfterSide ? children.slice(pos) : children.slice(0, pos)
  const startSizes = group.map((child) => child.px ?? DEFAULT_CELL_SIZE_PX)
  // Growth clamp: the group's total gain comes out of the flex branch, which keeps ITS minimum.
  const maxPerChild = (flexExtent - minFlex) / group.length
  // Shrink clamp: no group member's content goes below its own minimum.
  const minPerChild = Math.max(
    ...group.map((child, i) => minExtentOf(child.node, split.axis) - (startSizes[i] ?? DEFAULT_CELL_SIZE_PX)),
  )
  const sign = groupOnAfterSide ? -1 : 1
  beginDrag((moveEvent) => {
    const delta = (horizontal ? moveEvent.clientX : moveEvent.clientY) - start
    const perChild = Math.min(maxPerChild, Math.max(minPerChild, (sign * delta) / group.length))
    layout.resizeChildrenAtPath(
      splitPath,
      group.map((child, i) => ({ index: child.index, sizePx: (startSizes[i] ?? DEFAULT_CELL_SIZE_PX) + perChild })),
    )
  })
}

// The cell HOST element for a docked PanelWindow (see PanelLayoutState.cellHost). Instances are
// keyed by panelId in the parent v-for, so one instance never switches between panels; only the
// stale-element guard in clearCellHost is needed for patch-order races.
let registeredEl: HTMLElement | null = null
const onCellRef = (el: unknown): void => {
  const id = cellPanelId.value
  if (id === null) {
    return
  }
  const element = el instanceof HTMLElement ? el : null
  if (element !== null) {
    registeredEl = element
    layout.setCellHost(id, element)
  } else if (registeredEl !== null) {
    layout.clearCellHost(id, registeredEl)
    registeredEl = null
  }
}
</script>

<style scoped lang="scss">
.panel-dock__split {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;

  &--row { flex-direction: row; }
  &--column { flex-direction: column; }
}

.panel-dock__cell {
  display: flex;
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.panel-dock__splitter {
  flex: 0 0 6px;
  align-self: stretch;
  background: rgba(128, 128, 128, 0.12);
  transition: background 0.15s;

  &:hover { background: rgba(128, 128, 128, 0.35); }
  &--row { cursor: col-resize; }
  &--column { cursor: row-resize; }
}
</style>
