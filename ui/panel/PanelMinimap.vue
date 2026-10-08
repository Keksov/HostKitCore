<template>
  <!-- panel-layout-tree (PL3.1, PL-D3): the dock minimap — a proportional miniature of the CURRENT
       layout with clickable dock zones. Outer ring = the four window edges (root-level docks,
       full width/height — req. 2); inner rectangles = the visible cells, each with four edge
       zones that SPLIT that cell (req. 3: the two panels then share a dimension structurally).
       The panel's own cell shows as «current» and offers no zones; the floating zone sits under
       the map (owner: floating belongs to the minimap, detach does not). Geometry and labels are
       measured from the LIVE dock DOM at open time — the miniature is honest by construction. -->
  <div class="panel-minimap">
    <div class="panel-minimap__frame" :style="frameStyle">
      <div
        v-for="edge in EDGES"
        :key="`win-${edge}`"
        class="panel-minimap__edge"
        :class="`panel-minimap__edge--${edge}`"
        @click="onWindowEdge(edge)"
      />
      <div class="panel-minimap__area">
        <div
          v-for="cell in cells"
          :key="cell.panelId"
          class="panel-minimap__cell"
          :class="{
            'panel-minimap__cell--tracks': cell.isTracks,
            'panel-minimap__cell--self': cell.isSelf,
          }"
          :style="cellStyle(cell)"
        >
          <span class="panel-minimap__cell-label">{{ cell.label }}</span>
          <template v-if="!cell.isSelf">
            <div
              v-for="edge in EDGES"
              :key="edge"
              class="panel-minimap__cell-zone"
              :class="`panel-minimap__cell-zone--${edge}`"
              @click.stop="onCellZone(cell.panelId, edge)"
            />
          </template>
        </div>
      </div>
    </div>
    <div
      v-if="allowFloat"
      class="panel-minimap__floating"
      :class="{ 'panel-minimap__floating--active': state.mode === 'floating' }"
      @click="onFloating"
    >
      <q-icon name="picture_in_picture_alt" size="16px" class="q-mr-sm" />
      <span>{{ t('panel.dockFloat') }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, type CSSProperties } from 'vue'
import { useI18n } from 'vue-i18n'
import { TRACKS_PANEL_ID, listPanelIds, type LayoutEdge } from './layout-model'
import { usePanelLayout } from './use-panel-layout'
import type { PanelWindowState } from './use-panel-window'

const props = withDefaults(defineProps<{
  /** The panel being positioned (its own cell is «current», not a target). */
  readonly state: PanelWindowState
  /** PL7.1: the tracks panel can only MOVE — no floating zone. MUST default to true explicitly:
   *  an absent type-only Boolean prop is cast by Vue to false (the PW5.7c-fix trap). */
  readonly allowFloat?: boolean
}>(), {
  allowFloat: true,
})

const emit = defineEmits<{
  /** An action was taken — the hosting menu closes itself. */
  done: []
}>()

const { t } = useI18n()
const layout = usePanelLayout()

const EDGES: readonly LayoutEdge[] = ['left', 'right', 'top', 'bottom']

/** Padding ring of the frame reserved for the window-edge zones, px. */
const RING = 16
/** Fixed miniature width; height follows the real dock's aspect ratio. */
const FRAME_W = 248

interface MiniCell {
  readonly panelId: string
  readonly label: string
  readonly isTracks: boolean
  readonly isSelf: boolean
  /** Normalized [0..1] position inside the dock bounds. */
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

const cells = ref<readonly MiniCell[]>([])
const aspect = ref(16 / 10)

// The miniature reflects the dock at menu-open time: q-menu mounts its content on show, so
// onMounted IS the open moment. Visible cells = tree cells that currently have a live host.
onMounted(() => {
  interface Measured {
    readonly panelId: string
    readonly rect: DOMRect
    readonly label: string
  }
  const measured: Measured[] = []
  for (const panelId of listPanelIds(layout.tree.value)) {
    const host = layout.cellHost(panelId)
    if (host === null) {
      continue
    }
    const rect = host.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) {
      continue
    }
    const label = panelId === TRACKS_PANEL_ID
      ? t('panel.tracksArea')
      : host.querySelector('.panel-window__title')?.textContent ?? ''
    measured.push({ panelId, rect, label })
  }
  if (measured.length === 0) {
    cells.value = []
    return
  }
  const left = Math.min(...measured.map((m) => m.rect.left))
  const top = Math.min(...measured.map((m) => m.rect.top))
  const right = Math.max(...measured.map((m) => m.rect.right))
  const bottom = Math.max(...measured.map((m) => m.rect.bottom))
  const width = Math.max(1, right - left)
  const height = Math.max(1, bottom - top)
  aspect.value = width / height
  cells.value = measured.map((m) => ({
    panelId: m.panelId,
    label: m.label,
    isTracks: m.panelId === TRACKS_PANEL_ID,
    isSelf: m.panelId === props.state.panelId,
    x: (m.rect.left - left) / width,
    y: (m.rect.top - top) / height,
    w: m.rect.width / width,
    h: m.rect.height / height,
  }))
})

const frameStyle = computed<CSSProperties>(() => {
  const innerW = FRAME_W - RING * 2
  const innerH = Math.min(220, Math.max(90, innerW / aspect.value))
  return { width: `${FRAME_W}px`, height: `${Math.round(innerH + RING * 2)}px` }
})

const cellStyle = (cell: MiniCell): CSSProperties => ({
  left: `${cell.x * 100}%`,
  top: `${cell.y * 100}%`,
  width: `${cell.w * 100}%`,
  height: `${cell.h * 100}%`,
})

const finishDocked = (): void => {
  props.state.setMode('docked')
  emit('done')
}

const onWindowEdge = (edge: LayoutEdge): void => {
  layout.dockPanelToEdge(props.state.panelId, edge, props.state.dockSize)
  finishDocked()
}

const onCellZone = (targetPanelId: string, edge: LayoutEdge): void => {
  layout.dockPanelToCell(props.state.panelId, targetPanelId, edge, props.state.dockSize)
  finishDocked()
}

const onFloating = (): void => {
  layout.undockPanel(props.state.panelId)
  props.state.setMode('floating')
  emit('done')
}
</script>

<style scoped lang="scss">
// Owner-приёмка PL3.3 (2026-08-14): зоны видны СРАЗУ — тонкая полоска у кромки с фейдом к
// центру; hover заливает всю зону. Горизонтальные зоны (top/bottom) — полосой на ВСЮ ширину,
// как вертикальные на всю высоту; углы отдаются вертикальным (z-index выше).
@mixin zone-strip($dir) {
  background: linear-gradient(
    $dir,
    color-mix(in srgb, var(--q-primary, #1976d2) 60%, transparent) 0,
    color-mix(in srgb, var(--q-primary, #1976d2) 28%, transparent) 3px,
    transparent 9px
  );
}

@mixin zone-hover {
  &:hover { background: color-mix(in srgb, var(--q-primary, #1976d2) 50%, transparent); }
}

.panel-minimap {
  padding: 8px;
  user-select: none;
}

.panel-minimap__frame {
  position: relative;
  border: 1px solid rgba(128, 128, 128, 0.35);
  border-radius: 4px;
  overflow: hidden;
}

.panel-minimap__edge {
  position: absolute;
  transition: background 0.12s;
  cursor: pointer;

  @include zone-hover;
  &--left { left: 0; top: 0; bottom: 0; width: 16px; z-index: 3; @include zone-strip(to right); }
  &--right { right: 0; top: 0; bottom: 0; width: 16px; z-index: 3; @include zone-strip(to left); }
  &--top { top: 0; left: 0; right: 0; height: 16px; z-index: 2; @include zone-strip(to bottom); }
  &--bottom { bottom: 0; left: 0; right: 0; height: 16px; z-index: 2; @include zone-strip(to top); }
}

.panel-minimap__area {
  position: absolute;
  inset: 16px;
}

.panel-minimap__cell {
  position: absolute;
  box-sizing: border-box;
  border: 1px solid rgba(128, 128, 128, 0.45);
  background: rgba(128, 128, 128, 0.08);
  overflow: hidden;

  &--tracks { background: rgba(128, 128, 128, 0.18); }
  &--self {
    border-color: var(--q-primary, #1976d2);
    background: rgba(25, 118, 210, 0.18);
  }
}

.panel-minimap__cell-label {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  font-size: 10px;
  line-height: 1.1;
  text-align: center;
  opacity: 0.75;
  overflow: hidden;
  pointer-events: none;
}

.panel-minimap__cell-zone {
  position: absolute;
  cursor: pointer;
  transition: background 0.12s;

  @include zone-hover;
  &--left { left: 0; top: 0; bottom: 0; width: 30%; z-index: 2; @include zone-strip(to right); }
  &--right { right: 0; top: 0; bottom: 0; width: 30%; z-index: 2; @include zone-strip(to left); }
  &--top { top: 0; left: 0; right: 0; height: 35%; z-index: 1; @include zone-strip(to bottom); }
  &--bottom { bottom: 0; left: 0; right: 0; height: 35%; z-index: 1; @include zone-strip(to top); }
}

.panel-minimap__floating {
  display: flex;
  align-items: center;
  margin-top: 8px;
  padding: 6px 8px;
  border: 1px dashed rgba(128, 128, 128, 0.45);
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.12s;

  &:hover { background: rgba(128, 128, 128, 0.15); }
  &--active {
    border-color: var(--q-primary, #1976d2);
    background: rgba(25, 118, 210, 0.12);
  }
}
</style>
