// panel-layout-tree (PL1.3, PL-D4): the ONE reactive layout tree behind the whole panel dock —
// a module-level singleton like usePanelWindowState's instances map, so the dock host, every
// panel's chrome and the minimap all mutate the same tree. Persistence is a single localStorage
// key (the tree is one document, unlike the legacy per-panel '-mode'/'-dock-size' scheme, which
// is migrated from once). All mutations go through the pure layout-model functions and replace
// tree.value wholesale — watchers stay shallow, undo of a bad mutation is a value swap.
import { inject, provide, ref, shallowReactive, watch, type InjectionKey, type Ref } from 'vue'

import {
  defaultLayout,
  deserializeLayout,
  dockAxisOf,
  dockToCell,
  dockToEdge,
  isDockedInTree,
  migrateLegacyPanelModes,
  removePanel,
  serializeLayout,
  setChildSizes,
  type LayoutAxis,
  type LayoutEdge,
  type LayoutNode,
  type LegacyPanelDock,
  type SplitChildSize,
} from './layout-model'
import { panelKitName } from './panel-kit'

/**
 * The main window's layout key, '<prefix>panel-layout' (MindWave: 'mindwave-panel-layout').
 * GCY1.3 (GCY-D22): a function, not a constant — the prefix is the host's and is set at boot.
 */
export const layoutStorageKey = (): string => panelKitName('-layout')

/**
 * TD4.1 (TD-D9): the layout key of a SECOND host — a detached child window that runs its own dock.
 *
 * The two windows are separate JS realms, so the module singleton below is already per-window; what
 * they DO share is localStorage. A child running the same code would therefore persist its tree over
 * the main window's — the PW-D11 hazard, arriving through storage instead of through a composable.
 * Hence one key per host window.
 */
export const layoutStorageKeyFor = (hostPanelId: string): string =>
  hostPanelId === '' ? layoutStorageKey() : `${layoutStorageKey()}@${hostPanelId}`

/**
 * Where a panel's legacy flat-scheme keys live. Defaults follow the '<prefix>panel-<id>-*'
 * scheme; a panel with keys of its own (the file-open panel's '…fs-browser-*') passes overrides (PW-D3).
 */
export interface LegacyPanelKeys {
  readonly panelId: string
  readonly modeKey?: string
  readonly dockSizeKey?: string
  /** Pre-tree default mode/size (the store's old defaultMode: 'right' etc.) — applied when the
   *  legacy keys are absent, so a FRESH install gets the same layout the flat scheme produced. */
  readonly defaultMode?: string
  readonly defaultDockSize?: number
}

export interface PanelLayoutState {
  /** The current tree; replaced wholesale by every mutation — watch it shallowly. */
  readonly tree: Ref<LayoutNode>
  /**
   * One-shot init by the dock host: if nothing persisted under the layout key, build the
   * tree from the panels' legacy '-mode'/'-dock-size' keys (PL-D4). Idempotent; legacy keys
   * are left in place (the '-open'/'-float'/... family stays in use).
   */
  init: (legacyPanels: readonly LegacyPanelKeys[]) => void
  dockPanelToEdge: (panelId: string, edge: LayoutEdge, sizePx?: number) => void
  dockPanelToCell: (panelId: string, targetPanelId: string, edge: LayoutEdge, sizePx?: number) => void
  undockPanel: (panelId: string) => void
  /** Splitter drag (PL-D12): new px extents for children of the split at `splitPath` — one
   *  atomic tree replacement per pointer event, whether it moves one neighbour or a group. */
  resizeChildrenAtPath: (splitPath: readonly number[], updates: readonly SplitChildSize[]) => void
  isDocked: (panelId: string) => boolean
  /** Axis of the split hosting the panel ('row' → vertical sidebar); null when not docked. */
  dockAxis: (panelId: string) => LayoutAxis | null
  /**
   * Live DOM element of a panel's dock cell (PL-D5). PanelDock registers it on render;
   * PanelWindow teleports into it. An ELEMENT (not a selector) on purpose: when a tree change
   * recreates the cell div, the new element flows through this reactive registry and the
   * Teleport re-targets — a selector string would never change and the content would stay
   * attached to the dead node.
   */
  cellHost: (panelId: string) => HTMLElement | null
  setCellHost: (panelId: string, el: HTMLElement) => void
  /** Unregister only if `el` is still the current host (mount of the new cell may precede
   *  unmount of the old one within a patch — a blind delete would clobber the fresh element). */
  clearCellHost: (panelId: string, el: HTMLElement) => void
  /** «Сбросить раскладку» (PL-D3): back to the default tree; per-panel open/float keys untouched. */
  reset: () => void
}

const readItem = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const persist = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Ignore quota / privacy-mode failures — persistence is best-effort.
  }
}

let instance: PanelLayoutState | null = null

/**
 * TD4.1 (TD-D9): a layout store bound to ONE storage key. The main window keeps the module singleton
 * below (nothing about it changes); a child window that hosts a dock of its own creates a second
 * store with its own key and provides it to its subtree.
 */
export function createPanelLayout(storageKey: string): PanelLayoutState {
  const tree = ref<LayoutNode>(deserializeLayout(readItem(storageKey)) ?? defaultLayout())
  let initialized = readItem(storageKey) !== null
  const cellHosts = shallowReactive<Record<string, HTMLElement | null>>({})

  watch(tree, (value) => persist(storageKey, serializeLayout(value)))

  const state: PanelLayoutState = {
    tree,
    init: (legacyPanels: readonly LegacyPanelKeys[]): void => {
      if (initialized) {
        return
      }
      initialized = true
      const entries: LegacyPanelDock[] = legacyPanels.map((spec) => {
        const prefix = panelKitName(`-${spec.panelId}-`)
        const sizeRaw = readItem(spec.dockSizeKey ?? `${prefix}dock-size`)
        const size = sizeRaw === null ? spec.defaultDockSize ?? Number.NaN : Number(sizeRaw)
        return {
          panelId: spec.panelId,
          mode: readItem(spec.modeKey ?? `${prefix}mode`) ?? spec.defaultMode ?? '',
          dockSize: size,
        }
      })
      tree.value = migrateLegacyPanelModes(entries)
      // Write even an unchanged default so migration never re-runs against future legacy edits.
      persist(storageKey, serializeLayout(tree.value))
    },
    dockPanelToEdge: (panelId, edge, sizePx?): void => {
      tree.value = dockToEdge(tree.value, panelId, edge, sizePx)
    },
    dockPanelToCell: (panelId, targetPanelId, edge, sizePx?): void => {
      tree.value = dockToCell(tree.value, panelId, targetPanelId, edge, sizePx)
    },
    undockPanel: (panelId): void => {
      tree.value = removePanel(tree.value, panelId)
    },
    resizeChildrenAtPath: (splitPath, updates): void => {
      tree.value = setChildSizes(tree.value, splitPath, updates)
    },
    isDocked: (panelId): boolean => isDockedInTree(tree.value, panelId),
    dockAxis: (panelId): LayoutAxis | null => dockAxisOf(tree.value, panelId),
    cellHost: (panelId): HTMLElement | null => cellHosts[panelId] ?? null,
    setCellHost: (panelId, el): void => {
      cellHosts[panelId] = el
    },
    clearCellHost: (panelId, el): void => {
      if (cellHosts[panelId] === el) {
        cellHosts[panelId] = null
      }
    },
    reset: (): void => {
      tree.value = defaultLayout()
    },
  }

  return state
}

/**
 * TD4.1 (TD-D9): the layout a subtree belongs to. Injected by a host that runs its OWN dock (the
 * detached child window); absent in the main window, where every caller keeps sharing the module
 * singleton exactly as before.
 */
const PANEL_LAYOUT_KEY: InjectionKey<PanelLayoutState> = Symbol('panel-layout')

/** Call from the host component's setup, BEFORE the dock and any PanelWindow below it mount. */
export function providePanelLayout(hostPanelId: string): PanelLayoutState {
  const layout = createPanelLayout(layoutStorageKeyFor(hostPanelId))
  provide(PANEL_LAYOUT_KEY, layout)
  return layout
}

export function usePanelLayout(): PanelLayoutState {
  // inject() outside setup returns undefined (and warns in dev) — that is exactly the main-window
  // path, and it lands on the singleton below.
  const provided = inject(PANEL_LAYOUT_KEY, null)
  if (provided !== null) {
    return provided
  }
  if (instance === null) {
    instance = createPanelLayout(layoutStorageKey())
  }
  return instance
}
