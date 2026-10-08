<template>
  <!-- panel-window (PW2.1, PW-D4): the detached child window's whole page.
       TD4.3 (TD-D5r2/TD-D9): it used to render ONE panel component full-window, the OS frame being
       the only chrome. The owner asked for the companion to travel with its panel and to behave
       there like a panel: «панели в одном окне можно докать как угодно относительно друг друга при
       помощи стандартного механизма как в главном окне». So this page is now a second DOCK HOST —
       the same PanelDock, the same PanelWindow chrome, the same minimap and splitters — over a
       layout tree of its own (TD-D9: its own storage key, or it would rearrange the main window
       through the shared localStorage).
       Each hosted panel keeps its own bridge to its own parent in the main window (TD-D11); only the
       HOST panel owns this OS window. -->
  <div class="panel-host">
    <PanelDock v-if="hosted.length > 0" />
    <div v-else class="panel-host__missing">
      <q-banner dense rounded class="bg-orange-1 text-orange-10">
        {{ t('panel.unknown') }}: {{ panelId }}
      </q-banner>
    </div>

    <PanelWindow
      v-for="entry in hosted"
      :key="entry.panel.id"
      :state="entry.state"
      :title="entry.title"
      :icon="entry.panel.icon"
      :allow-detach="false"
      :allow-float="false"
      @close="onPanelClosed(entry.panel.id)"
    >
      <component
        :is="entry.component"
        :bridge-state="entry.bridgeState.value"
        v-bind="entry.handlers"
      />
    </PanelWindow>
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, shallowRef, watch, watchEffect, type Component, type Ref } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { createPanelBridgeChild, type PanelBridgeChild } from '@panel/use-panel-bridge'
import { detachedRectKey, usePanelWindowState, writePanelScreenRect, type PanelWindowState } from '@panel/use-panel-window'
import { providePanelLayout } from '@panel/use-panel-layout'
import { layoutCell, listPanelIds } from '@panel/layout-model'
import PanelDock from '@panel/PanelDock.vue'
import PanelWindow from '@panel/PanelWindow.vue'
import type { PanelContribution } from '@panel/panel-registry'

// GCY1.4 (GCY-D29): the page lives in HostKitCore, which knows no host — the host's module panels
// arrive as a route prop (`panelHostRoute(modulePanels)`, panel-host-route.ts) instead of an import of
// the host's module list. Static for the page's whole life, exactly like that import was.
const props = defineProps<{ readonly panels: readonly PanelContribution[] }>()
const modulePanels = props.panels

const route = useRoute()
const { t } = useI18n()

const panelId = computed<string>(() => String(route.params.panelId ?? ''))
const panel = computed(() => modulePanels.find((p) => p.id === panelId.value))

// TD4.3 (TD-D9): this window's OWN layout tree, keyed by the host panel — provided before anything
// below mounts, so every PanelDock/PanelWindow in this subtree resolves to it and the main window's
// tree is never touched.
const layout = providePanelLayout(panelId.value)

/** One panel living in this window: its contribution, chrome state, bridge and pushed snapshot. */
interface HostedPanel {
  readonly panel: PanelContribution
  readonly state: PanelWindowState
  readonly component: Component
  readonly bridgeState: Ref<unknown>
  readonly title: string
  readonly handlers: Record<string, (...args: unknown[]) => void>
}

// The companion ids the parent says should be here right now (TD4.2). Empty until it pushes.
const companionIds = ref<readonly string[]>([])
const bridgeTitle = ref<string | null>(null)
/** Per-panel: the last snapshot its parent pushed. */
const bridgeStates = new Map<string, Ref<unknown>>()
const bridges = new Map<string, PanelBridgeChild>()

const hostedIds = computed<readonly string[]>(() => {
  if (panel.value === undefined) return []
  // A companion is only hosted while its contribution names THIS panel as its host: the child must
  // not be talked into rendering an arbitrary panel by a stray message.
  const companions = companionIds.value.filter((id) =>
    modulePanels.some((p) => p.id === id && p.detachHost === panelId.value))
  return [panelId.value, ...companions]
})

const ensureBridge = (id: string): void => {
  if (bridges.has(id)) return
  const isHost = id === panelId.value
  const state = bridgeStateRef(id)
  bridges.set(id, createPanelBridgeChild(
    id,
    {
      onState: (s) => { state.value = s },
      // Only the host names the window; a companion's caption is its own titlebar (VS2.8).
      ...(isHost ? { onTitle: (title: string) => { bridgeTitle.value = title } } : {}),
      ...(isHost ? { onCompanions: (ids: readonly string[]) => { companionIds.value = ids } } : {}),
      // TD4.3: the parent closed a COMPANION while the window stays — drop it from the window.
      ...(isHost ? {} : { onCloseRequested: () => { companionIds.value = companionIds.value.filter((x) => x !== id) } }),
    },
    { ownsWindow: isHost },
  ))
}

const bridgeStateRef = (id: string): Ref<unknown> => {
  const existing = bridgeStates.get(id)
  if (existing !== undefined) return existing
  const fresh = shallowRef<unknown>(undefined)
  bridgeStates.set(id, fresh)
  return fresh
}

const disposeBridge = (id: string): void => {
  bridges.get(id)?.dispose()
  bridges.delete(id)
}

const hosted = computed<readonly HostedPanel[]>(() =>
  hostedIds.value.flatMap((id) => {
    const contribution = modulePanels.find((p) => p.id === id)
    if (contribution === undefined) return []
    const isHost = id === panelId.value
    // TD4.2 (TD-D9): window-scoped chrome state — the same panel is open in the main window too, and
    // its geometry there must not follow it here (nor the other way round).
    const state = usePanelWindowState(id, {
      hostPanelId: panelId.value,
      defaultMode: 'docked',
      defaultOpen: true,
    })
    state.open = true
    if (state.mode !== 'docked') state.setMode('docked')
    return [{
      panel: contribution,
      state,
      component: componentCache(contribution),
      bridgeState: bridgeStateRef(id),
      title: isHost ? (bridgeTitle.value ?? t(contribution.titleKey)) : t(contribution.titleKey),
      handlers: handlersFor(contribution, isHost),
    }]
  }),
)

const components = new Map<string, Component>()
const componentCache = (contribution: PanelContribution): Component => {
  const existing = components.get(contribution.id)
  if (existing !== undefined) return existing
  const made = defineAsyncComponent(contribution.component)
  components.set(contribution.id, made)
  return made
}

/**
 * Generic listeners for a panel's content: 'close' closes the panel (the WINDOW only when it is the
 * host's — PW-D6 then brings everything back in-window), the declared events go over that panel's
 * own bridge, and `bridge-request` is the request-response half for panels that asked for it (TD-D3).
 */
function handlersFor(contribution: PanelContribution, isHost: boolean): Record<string, (...args: unknown[]) => void> {
  const handlers: Record<string, (...args: unknown[]) => void> = {
    onClose: (): void => {
      if (isHost) window.close()
      else onPanelClosed(contribution.id)
    },
  }
  for (const name of contribution.events ?? []) {
    handlers[`on${name.charAt(0).toUpperCase()}${name.slice(1)}`] = (...args: unknown[]): void => {
      bridges.get(contribution.id)?.sendEvent(name, args)
    }
  }
  if (contribution.bridgeRequests === true) {
    handlers['bridgeRequest'] = ((name: string, ...args: unknown[]): Promise<unknown> => {
      const bridge = bridges.get(contribution.id)
      return bridge === undefined
        ? Promise.reject(new Error(`panel-request "${name}": this window has no bridge`))
        : bridge.request(name, args)
    }) as unknown as (...args: unknown[]) => void
  }
  return handlers
}

/** The user closed a panel inside this window: the host takes the window with it, a companion tells
 *  its parent and leaves the dock (TD4.2 — the parent then stops listing it as a companion). */
function onPanelClosed(id: string): void {
  if (id === panelId.value) {
    window.close()
    return
  }
  bridges.get(id)?.closeByChild()
  companionIds.value = companionIds.value.filter((x) => x !== id)
}

// Keep bridges and the layout tree in step with the hosted set: a companion arriving gets a bridge
// and a cell, one leaving loses both. The host's cell IS the tree's root when nothing is persisted.
watch(hostedIds, (ids, previous) => {
  for (const id of ids) ensureBridge(id)
  for (const id of previous ?? []) {
    if (!ids.includes(id)) disposeBridge(id)
  }
  const host = panelId.value
  if (host !== '' && !listPanelIds(layout.tree.value).includes(host)) {
    layout.tree.value = layoutCell(host, null)
  }
  for (const id of ids) {
    if (id !== host && !layout.isDocked(id)) {
      // Under the editor by default: the companion is a list, the host is the work surface.
      layout.dockPanelToEdge(id, 'bottom', 240)
    }
  }
  for (const id of listPanelIds(layout.tree.value)) {
    if (!ids.includes(id)) layout.undockPanel(id)
  }
}, { immediate: true })

// PW4.1 (PW-D7): remember this window's on-screen rect so the next detach/auto-reopen restores it.
// There is no move event, so poll screenX/screenY on an interval as well as on resize; write only
// when it actually changed. Content coordinates (screenX/screenY + innerWidth/innerHeight).
let geometryTimer: number | null = null
let lastGeometry = ''

const captureGeometry = (): void => {
  if (panelId.value === '') {
    return
  }
  const w = window.innerWidth
  const h = window.innerHeight
  if (w <= 0 || h <= 0) {
    return
  }
  const rect = { x: window.screenX, y: window.screenY, w, h }
  const signature = `${rect.x},${rect.y},${rect.w},${rect.h}`
  if (signature === lastGeometry) {
    return
  }
  lastGeometry = signature
  writePanelScreenRect(detachedRectKey(panelId.value), rect)
}

onMounted(() => {
  window.addEventListener('resize', captureGeometry)
  geometryTimer = window.setInterval(captureGeometry, 1000)
  captureGeometry()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', captureGeometry)
  if (geometryTimer !== null) {
    window.clearInterval(geometryTimer)
    geometryTimer = null
  }
  for (const id of [...bridges.keys()]) disposeBridge(id)
})

// The OS window caption (PW-D4); tracks the locale too. VS2.8: a parent-pushed dynamic title wins
// over the static manifest key (which remains the pre-push fallback). `app.title` is the HOST's key
// (the product name) — a host must provide it (GCY1.4, contract in app-messages.ts).
watchEffect(() => {
  const p = panel.value
  document.title = bridgeTitle.value ?? (p === undefined ? t('app.title') : t(p.titleKey))
})
</script>

<style scoped lang="scss">
.panel-host {
  height: 100vh;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--q-dark-page, #fff);

  &__missing { padding: 12px; }
}
</style>
