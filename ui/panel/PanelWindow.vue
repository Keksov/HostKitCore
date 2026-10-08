<template>
  <!-- panel-window (PW1.1, PW-D3; reworked PL2.2, PL-D5): the universal panel chrome — floating
       (draggable) or docked into a PanelDock cell. The panel now teleports ITSELF: to <body> when
       floating, into its live cell element when docked (an element, not a selector — see
       PanelLayoutState.cellHost). While docked and the cell is not rendered (hidden dock, page
       without a PanelDock) nothing renders; in detached mode (PW3.x) the content lives in a child
       OS window, so nothing renders here either. -->
  <Teleport v-if="teleportTo !== null" :to="teleportTo">
  <div
    class="panel-window"
    :class="modeClass"
    :style="rootStyle"
    tabindex="0"
    :data-hotkey-surface="hotkeySurface"
    @pointerdown="onRootPointerDown"
  >
    <div class="panel-window__titlebar row items-center no-wrap">
      <div
        class="panel-window__drag row items-center no-wrap col"
        :class="{ 'panel-window__drag--active': isFloating, 'panel-window__drag--tear': state.mode === 'docked' }"
        @pointerdown="onTitlePointerDown"
      >
        <q-icon v-if="icon !== undefined" :name="icon" size="18px" class="q-mr-sm" />
        <span class="panel-window__title">{{ title }}</span>
      </div>

      <!-- SS2.3: optional consumer-supplied title-bar action buttons, left of the dock menu. Unused
           by file-open / track-list (an empty named slot renders nothing) — «Параметры» puts its
           presets button here. -->
      <slot name="titlebar-actions" />

      <!-- PL3.2 (PL-D3): ONE minimap button replaces the four dock items (req. 1) — clickable
           zones in the miniature do the docking, floating is the zone under the map. «Отдельное
           окно» (an OS matter, not layout) and «Сбросить раскладку» remain list items below. -->
      <q-btn flat dense round size="sm" :icon="modeIcon" class="panel-window__dock-menu-btn">
        <app-tooltip>{{ t('panel.dockMenu') }}</app-tooltip>
        <q-menu ref="dockMenuRef">
          <panel-minimap :state="state" :allow-float="allowFloat" @done="hideDockMenu" />
          <q-separator />
          <q-list dense style="min-width: 160px">
            <q-item
              v-if="allowDetach !== false"
              clickable
              :active="state.mode === 'detached'"
              @click="onDetachClick"
            >
              <q-item-section avatar><q-icon name="open_in_new" /></q-item-section>
              <q-item-section>{{ t('panel.detach') }}</q-item-section>
            </q-item>
            <q-item clickable @click="onResetLayout">
              <q-item-section avatar><q-icon name="restart_alt" /></q-item-section>
              <q-item-section>{{ t('panel.resetLayout') }}</q-item-section>
            </q-item>
          </q-list>
        </q-menu>
      </q-btn>
      <q-btn v-if="allowClose" flat dense round size="sm" icon="close" :aria-label="t('panel.close')" @click="close" />
    </div>

    <q-separator />

    <slot />
    <slot name="footer" />

    <!-- Resizer: a corner grip when floating. Docked panels are resized by the PanelDock
         splitters between cells (PL2.1) — the per-panel edge grip is gone. -->
    <div v-if="isFloating" class="panel-window__float-resizer" @pointerdown="onFloatResizePointerDown" />

    <!-- PL5.1 (PL-D8): drag-to-dock overlay — the same zone model as the minimap, at live size.
         pointer-events: none everywhere; hit-testing runs inside the drag handler, so the zone
         divs are pure visuals (thin strips, the hovered one fills). -->
    <Teleport to="body">
      <div v-if="dragZones !== null" class="panel-window__drop-overlay">
        <div
          v-for="(zone, i) in dragZones"
          :key="i"
          class="panel-window__drop-zone"
          :class="[`panel-window__drop-zone--${zone.edge}`, { 'panel-window__drop-zone--hovered': zone === hoveredZone }]"
          :style="{
            left: `${zone.rect.x}px`,
            top: `${zone.rect.y}px`,
            width: `${zone.rect.w}px`,
            height: `${zone.rect.h}px`,
          }"
        />
      </div>
    </Teleport>
  </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch, type CSSProperties } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuasar, type QMenu } from 'quasar'
import { detachedRectKey, detachedWindowName, readPanelScreenRect, type PanelMode, type PanelWindowState } from './use-panel-window'
import { MIN_PANEL_INNER_PX } from './layout-model'
import { usePanelLayout } from './use-panel-layout'
import { computeDockZones, hitTestZone, type DockZone } from './dock-zones'
import { createPanelBridgeParent, type PanelBridgeParent, type PanelEventPayload } from './use-panel-bridge'
import PanelMinimap from './PanelMinimap.vue'
import AppTooltip from '@tooltip/AppTooltip.vue'

const props = withDefaults(defineProps<{
  readonly state: PanelWindowState
  readonly title: string
  readonly icon?: string
  // PW5.6c: a panel that can't sensibly run in a separate OS window opts out with allow-detach=false
  // to hide the "Separate window" mode. PW5.7c-fix: this MUST default to true — a type-only Boolean
  // prop that is ABSENT is cast by Vue to `false` (not `undefined`), so without the default below
  // modeOptions would drop «detached» for EVERY panel that doesn't explicitly pass :allow-detach.
  // That silent cast is exactly what hid the mode for both file-open and «Список треков».
  readonly allowDetach?: boolean
  // PW5.7: remote-control panels push a serializable state snapshot to their detached child window
  // (which holds no state of its own). Ignored while in-window / for panels that don't set it.
  readonly bridgeState?: unknown
  // TD2.1 (TD-D3): what a DETACHED child may ask the main window to do and answer — the
  // request-response half of the bridge, by name. The values may be async; whatever they return
  // must survive structuredClone, and a throw reaches the child as a rejected promise. A panel that
  // sets nothing here simply has no callable names (its child gets a readable refusal, not a hang).
  readonly bridgeRequestHandlers?: Readonly<Record<string, (...args: unknown[]) => unknown>>
  /**
   * TD4.2 (TD-D10): this panel is a COMPANION — when detached, its content lives in the window of
   * the named host panel instead of a window of its own. It still runs the parent side of its own
   * bridge (one bridge per panel, TD-D11); it just never opens, focuses or closes an OS window: that
   * window belongs to the host, and the host's lifecycle brings the companion back with it.
   */
  readonly detachHost?: string
  /**
   * TD4.2 (TD-D10): the other way round — companion panel ids that should be hosted in THIS panel's
   * detached window right now. Pushed to the child on every change; the child window renders exactly
   * these alongside its own content.
   */
  readonly companions?: readonly string[]
  // PL7.1 (PL-D10): the tracks panel is a regular panel EXCEPT it cannot be closed or float —
  // it can only MOVE within the tree. Both must default to true (absent Boolean prop → false).
  readonly allowClose?: boolean
  readonly allowFloat?: boolean
  /**
   * F-0039: the panel's hotkey SURFACE (TE4.6) — put on the chrome root below, so that everything
   * inside the panel, its titlebar included, classifies as that surface.
   *
   * It has to be a declared prop and not a plain attribute: this component's root is a <Teleport>,
   * and Vue cannot auto-inherit an attribute onto such a root — it drops it and warns
   * («Extraneous non-props attributes … could not be automatically inherited»). That is exactly what
   * happened: TrackEditorDialog wrote `data-hotkey-surface="track-editor"` here, the marker never
   * reached the DOM at all, and the promise made in its own comment («Everything inside this panel
   * belongs to the track editor») held only for the content, never for the chrome.
   */
  readonly hotkeySurface?: string
}>(), {
  allowDetach: true,
  allowClose: true,
  allowFloat: true,
})

const emit = defineEmits<{
  close: []
  // PW3.1 (PW-D5): a content event bridged back from the detached child window.
  panelEvent: [name: string, payload: PanelEventPayload]
}>()

const { t } = useI18n()
const $q = useQuasar()
const layout = usePanelLayout()

const isFloating = computed<boolean>(() => props.state.mode === 'floating')
const modeClass = computed<string>(() =>
  isFloating.value ? 'panel-window--floating' : 'panel-window--docked',
)

// PL2.2 (PL-D5): where this panel's content lives. Floating → <body>; docked → the LIVE cell
// element registered by PanelDock (null while the cell is not rendered → render nothing, the
// v-if above). Element identity is the re-anchoring signal after a tree change.
const teleportTo = computed<HTMLElement | 'body' | null>(() => {
  if (!props.state.open || props.state.mode === 'detached') {
    return null
  }
  return isFloating.value ? 'body' : layout.cellHost(props.state.panelId)
})

const rootStyle = computed<CSSProperties>(() => {
  if (isFloating.value) {
    const r = props.state.floatRect
    return { position: 'fixed', left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px`, zIndex: props.state.floatZ }
  }
  return {}
})

// PL4.1 (PL-D7): any pointerdown inside a floating panel raises it above its floating siblings.
const onRootPointerDown = (): void => {
  if (isFloating.value) {
    props.state.bringToFront()
  }
}

// PL3.2 (PL-D3): the dock menu = the minimap (all placement) + detach + layout reset. The menu
// must NOT auto-close (zone hovers live inside it) — the minimap emits 'done' after an action.
const dockMenuRef = ref<QMenu | null>(null)
const hideDockMenu = (): void => {
  dockMenuRef.value?.hide()
}
const onDetachClick = (): void => {
  hideDockMenu()
  selectDetached()
}
// «Сбросить раскладку» (PL-D3): panels whose cells vanish self-repair to floating (see the
// repairDockedWithoutCell watcher), so a reset never leaves a panel rendering nowhere.
const onResetLayout = (): void => {
  hideDockMenu()
  layout.reset()
}

const modeIcon = computed<string>(() => {
  if (props.state.mode === 'floating') return 'picture_in_picture_alt'
  return props.state.mode === 'detached' ? 'open_in_new' : 'space_dashboard'
})

const close = (): void => {
  props.state.open = false
  emit('close')
}

// ---- Detached mode (PW3.1, PW-D1/PW-D6) --------------------------------------------------------
// The panel content moves to a child OS window: same SPA at #/panel/<id> via window.open — in
// AppCore that's WebView2's default popup (same process/origin), in a browser a normal popup.
// While detached this component stays mounted (the host keeps it while the panel is open) but
// renders nothing; it owns the parent side of the bridge.

let bridge: PanelBridgeParent | null = null
// A child F5 looks like child-closed followed by child-ready — debounce the "restore to the
// previous in-window mode" reaction so a reload doesn't yank the panel back (PW-D6).
let childClosedTimer: number | null = null

const cancelChildClosedTimer = (): void => {
  if (childClosedTimer !== null) {
    window.clearTimeout(childClosedTimer)
    childClosedTimer = null
  }
}

const inWindowMode = (): PanelMode =>
  props.state.prevMode !== 'detached' ? props.state.prevMode : 'floating'

const openChildWindow = (): boolean => {
  // Reopen at the child's last on-screen rect (PW4.1); first-ever detach falls back to the
  // floating size. The named target means a still-open child is reused/focused, never duplicated.
  const saved = readPanelScreenRect(detachedRectKey(props.state.panelId))
  const r = props.state.floatRect
  const features = [`width=${Math.round(saved?.w ?? r.w)}`, `height=${Math.round(saved?.h ?? r.h)}`]
  if (saved !== null) {
    features.push(`left=${Math.round(saved.x)}`, `top=${Math.round(saved.y)}`)
  }
  const win = window.open(
    `#/panel/${props.state.panelId}`,
    detachedWindowName(props.state.panelId),
    features.join(','),
  )
  if (win === null) {
    return false
  }
  win.focus()
  return true
}

const teardownBridge = (): void => {
  cancelChildClosedTimer()
  bridge?.dispose()
  bridge = null
}

// PW5.7: push the current snapshot to the detached child (no-op while in-window — bridge is null).
const sendCurrentState = (): void => {
  if (bridge !== null && props.bridgeState !== undefined) {
    try {
      bridge.sendState(props.bridgeState)
    } catch (error) {
      // TD4.6: an unclonable snapshot (a Vue Proxy is the classic one) throws HERE, in the sender —
      // the child just never hears from us and the panel looks empty for no reason. Name the panel:
      // a bare DataCloneError from inside a watcher says nothing about whose snapshot it was.
      console.error(
        `panel "${props.state.panelId}": snapshot was not sent to its detached window — ${String(error)}`,
      )
    }
  }
}

// VS2.8: the title prop can be dynamic (e.g. it names the lane a settings panel is retargeted to)
// — mirror it to the detached child's window caption.
const sendCurrentTitle = (): void => {
  if (bridge !== null) {
    bridge.sendTitle(props.title)
  }
}

// TD4.2 (TD-D10): which companions the child window should be showing right now.
const sendCurrentCompanions = (): void => {
  if (bridge !== null && props.companions !== undefined) {
    bridge.sendCompanions(props.companions)
  }
}

/** TD4.2: a companion's window belongs to its host — this panel must never open or close one. */
const ownsWindow = (): boolean => props.detachHost === undefined || props.detachHost === ''

const ensureBridge = (): void => {
  if (bridge !== null) {
    return
  }
  bridge = createPanelBridgeParent(props.state.panelId, {
    onChildReady: (): void => {
      cancelChildClosedTimer()
      // A freshly-ready child gets the current snapshot immediately (PW5.7) + the caption (VS2.8)
      // + the companion list (TD4.2), so it can lay its dock out before anything else arrives.
      sendCurrentState()
      sendCurrentTitle()
      sendCurrentCompanions()
    },
    onChildClosed: (): void => {
      cancelChildClosedTimer()
      childClosedTimer = window.setTimeout(() => {
        childClosedTimer = null
        // The user closed the child window — the panel returns to the main window (stays open).
        if (props.state.mode === 'detached' && props.state.open) {
          teardownBridge()
          props.state.setMode(inWindowMode())
        }
      }, 1000)
    },
    // TD4.2 (TD-D10): the panel was closed INSIDE the shared window — the window lives on, this
    // panel does not. Same end state as the titlebar's X here: closed, and back in-window next time.
    onClosedByChild: (): void => {
      if (!props.state.open) {
        return
      }
      props.state.setMode(inWindowMode())
      props.state.open = false
      teardownBridge()
      emit('close')
    },
    onPanelEvent: (name, payload): void => emit('panelEvent', name, payload),
    // TD2.1: the handler map is read at CALL time, so a consumer may rebuild it reactively; an
    // unknown name is a refusal with the name in it, which is what the child shows the user.
    onRequest: (name, payload): unknown => {
      const handler = props.bridgeRequestHandlers?.[name]
      if (handler === undefined) {
        throw new Error(`panel-request "${name}": this panel has no such handler`)
      }
      return handler(...payload)
    },
  })
}

const detachBlocked = (): void => {
  $q.notify({ type: 'warning', message: t('panel.detachBlocked') })
}

const selectDetached = (): void => {
  // Open the child first (still inside the click's user activation); only then flip the mode —
  // a blocked popup (PW-D1 fallback) leaves the panel exactly where it was. The panel KEEPS its
  // cell in the layout tree (the host hides it while detached), so closing the child returns it
  // to its former place (PL-D4).
  if (props.state.mode === 'detached') {
    return
  }
  // TD4.2: a companion rides into its host's window; it has no window to open of its own. Consumers
  // normally hide the detach item for such a panel — this is the belt to that pair of braces.
  if (!ownsWindow()) {
    ensureBridge()
    props.state.setMode('detached')
    return
  }
  if (!openChildWindow()) {
    detachBlocked()
    return
  }
  ensureBridge()
  props.state.setMode('detached')
}

// PL2.2 self-repair: a panel whose persisted mode says 'docked' but whose cell is absent from
// the tree (stale/corrupt storage, a layout reset from another window) falls back to floating —
// otherwise it would silently render nowhere.
const repairDockedWithoutCell = (): void => {
  if (props.state.open && props.state.mode === 'docked' && !layout.isDocked(props.state.panelId)) {
    props.state.setMode('floating')
  }
}
watch(
  () => [props.state.open, props.state.mode, layout.isDocked(props.state.panelId)],
  () => repairDockedWithoutCell(),
)

// App start / returning to the hosting page with a persisted detached panel: one auto-reopen
// attempt (PW-D6); without user activation a browser blocker may refuse -> fall back in-window.
onMounted(() => {
  repairDockedWithoutCell()
  if (props.state.open && props.state.mode === 'detached') {
    // TD4.2: a companion just re-attaches its bridge — the host's window is (re)opening on its own,
    // and two panels racing to open the same named window would fight over its geometry.
    if (!ownsWindow()) {
      ensureBridge()
    } else if (openChildWindow()) {
      ensureBridge()
    } else {
      props.state.setMode(inWindowMode())
      detachBlocked()
    }
  }
})

// Main-side close while detached (PW-D6): closing the panel closes the child window too — unless the
// window is the host's, in which case only this panel's content leaves it (TD4.2).
watch(() => props.state.open, (open) => {
  if (!open && bridge !== null) {
    // A companion's cell disappears from the child window because its HOST stops listing it
    // (the host pushes the companion list), so there is nothing to ask for here.
    if (ownsWindow()) {
      bridge.requestClose()
    }
    teardownBridge()
  }
})

// PW5.7: forward snapshot changes to the detached child (deep — the snapshot is an object).
watch(() => props.bridgeState, () => sendCurrentState(), { deep: true })
// VS2.8: forward title changes too (retargeting a panel renames its detached window).
watch(() => props.title, () => sendCurrentTitle())
// TD4.2 (TD-D10): opening or closing a companion changes what the child window must host.
watch(() => props.companions, () => sendCurrentCompanions(), { deep: true })

// TD4.5 (TD-D10): a COMPANION is put into and out of detached mode by its host's mode, not by a
// click on its own menu — so its bridge follows the mode rather than the gesture. (A window-owning
// panel keeps going through selectDetached, which opens the window first and only then flips this.)
watch(() => props.state.mode, (mode) => {
  if (ownsWindow()) {
    return
  }
  if (mode === 'detached' && props.state.open) {
    ensureBridge()
  } else if (mode !== 'detached') {
    teardownBridge()
  }
})

// Host unmount (e.g. the main window navigates away): close the child cleanly instead of letting
// its watchdog time out. mode stays 'detached' + open stays true, so remounting reopens it.
onBeforeUnmount(() => {
  // TD4.2: only the window's OWNER closes it here. A companion unmounting (its panel was closed, or
  // the host page went away) must not take the host's window down with it.
  if (bridge !== null && props.state.open && props.state.mode === 'detached' && ownsWindow()) {
    bridge.requestClose()
  }
  teardownBridge()
})

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max))

// Generic pointer-drag: wire window listeners until pointerup.
const beginDrag = (onMove: (event: PointerEvent) => void, onUp?: () => void): void => {
  const move = (event: PointerEvent): void => onMove(event)
  const up = (): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    onUp?.()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

// ---- Drag-to-dock (PL5.1, PL-D8) ---------------------------------------------------------------
// Dragging the titlebar moves the floating window (FB4.2) and, past a small threshold, shows the
// drop-zone overlay — the same zone model the minimap uses, at live size. Dragging a DOCKED
// panel's titlebar first tears it off into floating (the cell leaves the tree) and continues as
// the same gesture, so re-docking is one motion. A drop inside a zone applies the same tree
// mutation the minimap click would; a drop outside leaves the panel floating where it is.

const dragZones = shallowRef<readonly DockZone[] | null>(null)
const hoveredZone = shallowRef<DockZone | null>(null)

const DRAG_ZONES_THRESHOLD_PX = 8

const applyDropZone = (zone: DockZone): void => {
  if (zone.kind === 'edge') {
    layout.dockPanelToEdge(props.state.panelId, zone.edge, props.state.dockSize)
  } else if (zone.targetPanelId !== null) {
    layout.dockPanelToCell(props.state.panelId, zone.targetPanelId, zone.edge, props.state.dockSize)
  }
  props.state.setMode('docked')
}

const onTitlePointerDown = (event: PointerEvent): void => {
  if (props.state.mode === 'detached') {
    return
  }
  event.preventDefault()
  // PL7.1 (PL-D10): a no-float panel (tracks) never tears off — its drag is a pure MOVE: the
  // window stays docked in place, only the zone overlay runs, and the drop relocates the cell.
  const moveOnly = !props.allowFloat
  let torn = isFloating.value // a floating panel is already "torn"; a docked one tears on threshold
  let anchorX = event.clientX
  let anchorY = event.clientY
  let baseX = props.state.floatRect.x
  let baseY = props.state.floatRect.y
  let zonesRequested = false

  const requestZones = (): void => {
    if (zonesRequested) {
      return
    }
    zonesRequested = true
    // nextTick: after a tear-off the dock re-renders without our cell — measure the NEW geometry.
    void nextTick(() => {
      dragZones.value = computeDockZones(layout, props.state.panelId)
    })
  }

  beginDrag(
    (moveEvent) => {
      const dx = moveEvent.clientX - anchorX
      const dy = moveEvent.clientY - anchorY
      const beyondThreshold = Math.abs(dx) + Math.abs(dy) >= DRAG_ZONES_THRESHOLD_PX
      if (moveOnly) {
        if (beyondThreshold) {
          requestZones()
        }
        hoveredZone.value =
          dragZones.value !== null ? hitTestZone(dragZones.value, moveEvent.clientX, moveEvent.clientY) : null
        return
      }
      if (!torn) {
        if (!beyondThreshold) {
          return
        }
        torn = true
        layout.undockPanel(props.state.panelId)
        props.state.setMode('floating')
        props.state.bringToFront()
        // Re-base so the window appears under the cursor, titlebar at the pointer.
        baseX = moveEvent.clientX - Math.min(props.state.floatRect.w / 2, 120)
        baseY = moveEvent.clientY - 14
        anchorX = moveEvent.clientX
        anchorY = moveEvent.clientY
        props.state.setFloatRect({ x: baseX, y: baseY })
        requestZones()
        return
      }
      if (beyondThreshold) {
        requestZones()
      }
      props.state.setFloatRect({
        x: clamp(baseX + dx, 0, window.innerWidth - 80),
        y: clamp(baseY + dy, 0, window.innerHeight - 40),
      })
      hoveredZone.value =
        dragZones.value !== null ? hitTestZone(dragZones.value, moveEvent.clientX, moveEvent.clientY) : null
    },
    () => {
      const zone = hoveredZone.value
      dragZones.value = null
      hoveredZone.value = null
      if (zone !== null) {
        applyDropZone(zone)
      }
    },
  )
}

// FB4.2: resize the floating window from its bottom-right grip.
// PL-D13: the CONTENT box keeps at least MIN_PANEL_INNER_PX in both dimensions here too — the
// chrome (borders, titlebar + separator) is measured from the live window, not assumed.
const onFloatResizePointerDown = (event: PointerEvent): void => {
  event.preventDefault()
  event.stopPropagation()
  const startX = event.clientX
  const startY = event.clientY
  const origin = { ...props.state.floatRect }
  const root = (event.currentTarget as HTMLElement | null)?.closest<HTMLElement>('.panel-window') ?? null
  const bar = root?.querySelector<HTMLElement>(':scope > .panel-window__titlebar') ?? null
  const sep = root?.querySelector<HTMLElement>(':scope > .q-separator') ?? null
  const borderW = root === null ? 0 : root.offsetWidth - root.clientWidth
  const borderH = root === null ? 0 : root.offsetHeight - root.clientHeight
  const minW = Math.max(props.state.minFloatW, MIN_PANEL_INNER_PX + borderW)
  const minH = Math.max(
    props.state.minFloatH,
    MIN_PANEL_INNER_PX + borderH + (bar?.offsetHeight ?? 0) + (sep?.offsetHeight ?? 0),
  )
  beginDrag((moveEvent) => {
    props.state.setFloatRect({
      w: Math.max(minW, origin.w + (moveEvent.clientX - startX)),
      h: Math.max(minH, origin.h + (moveEvent.clientY - startY)),
    })
  })
}

// PL2.2: the docked edge-grip resizer is gone — docked panels are resized by the PanelDock
// splitters (PL2.1). state.dockSize survives as the size HINT a panel brings to its next dock.
</script>

<style scoped lang="scss">
.panel-window {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--q-dark-page, #fff);
  box-sizing: border-box;

  &--floating {
    border: 1px solid rgba(128, 128, 128, 0.35);
    border-radius: 6px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);
    overflow: hidden;
  }

  /* PL2.2: a docked panel simply fills its PanelDock cell — position/order/borders belong to
     the dock renderer (PL2.1) now, not to the panel. */
  &--docked {
    position: relative;
    flex: 1 1 auto;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
  }

  /* PL7.3 (owner 2026-08-14): titlebars must read as CHROME, not content — a solid contrasting
     band + VS Code-style caption typography (smaller, uppercase, tracked, slightly dimmed). The
     currentColor mix adapts to the theme: light text on dark theme → lighter band, and vice
     versa. The q-separator below the titlebar doubles as its bottom border. */
  &__titlebar {
    flex: 0 0 auto;
    padding: 2px 4px 2px 8px;
    background: color-mix(in srgb, currentColor 14%, transparent);
    user-select: none;
  }

  &__drag {
    min-width: 0;
    padding: 4px 0;
    &--active { cursor: move; }
    &--tear { cursor: grab; }
  }

  &__title {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    opacity: 0.82;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__float-resizer {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 16px;
    height: 16px;
    cursor: nwse-resize;
  }
}

// PL5.1 (PL-D8): drag-to-dock overlay. The strip-with-fade visuals mirror the minimap zones
// (PanelMinimap.vue) — keep the two in sync when tuning.
@mixin drop-zone-strip($dir) {
  background: linear-gradient(
    $dir,
    color-mix(in srgb, var(--q-primary, #1976d2) 60%, transparent) 0,
    color-mix(in srgb, var(--q-primary, #1976d2) 28%, transparent) 4px,
    transparent 14px
  );
}

.panel-window__drop-overlay {
  position: fixed;
  inset: 0;
  z-index: 5990; // above every floating panel (cap 5900), below Quasar dialogs (6000)
  pointer-events: none;
}

.panel-window__drop-zone {
  position: absolute;
  transition: background 0.1s;

  &--left { @include drop-zone-strip(to right); }
  &--right { @include drop-zone-strip(to left); }
  &--top { @include drop-zone-strip(to bottom); }
  &--bottom { @include drop-zone-strip(to top); }
  &--hovered { background: color-mix(in srgb, var(--q-primary, #1976d2) 40%, transparent); }
}
</style>
