// track-editor-detach TD4.1 (TD-D9): the layout store must be bindable to ONE storage key.
//
// The hazard this pins down is not hypothetical and not a Vue problem: a detached child window is a
// separate JS realm (so the module singleton is already per-window) but it shares localStorage with
// the main window. A child that runs its own dock through the same code would persist ITS tree under
// the main window's key and quietly rearrange the main window. Every test below is about that.
//
// GCY1.3 (GCY-D22): the keys come from the host's prefix now, and these tests run under MindWave's
// 'mindwave-' — so every literal below is also the lock «MindWave's keys stay byte for byte» (the
// owner's saved layout stays in place). Other prefixes: panel-kit.test.ts.
//
// Run (part of the verify procedure, see AGENTS.md):
//   cd HostKitCore && bun test
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { nextTick } from 'vue'

import { createPanelLayout, layoutStorageKey, layoutStorageKeyFor } from './use-panel-layout'
import { serializeLayout, type LayoutNode } from './layout-model'
import { configurePanelKit } from './panel-kit'

// bun has no DOM: the store reads/writes the ambient `localStorage`, so the test supplies one.
interface FakeStorage {
  readonly data: Map<string, string>
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

function fakeStorage(): FakeStorage {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value) },
    removeItem: (key) => { data.delete(key) },
  }
}

let storage: FakeStorage
const globals = globalThis as unknown as { localStorage?: unknown }
let hadLocalStorage = false
let previous: unknown

beforeEach(() => {
  // Per test, not once per file: bun runs every test file in one process, and another file may
  // have configured a different prefix (panel-kit.test.ts does).
  configurePanelKit({ keyPrefix: 'mindwave-' })
  storage = fakeStorage()
  hadLocalStorage = 'localStorage' in globals
  previous = globals.localStorage
  globals.localStorage = storage
})

afterEach(() => {
  if (hadLocalStorage) globals.localStorage = previous
  else delete globals.localStorage
})

/** A one-cell tree under `panelId`, produced through the store's own mutation. */
const dockOne = (layout: ReturnType<typeof createPanelLayout>, panelId: string): void => {
  layout.dockPanelToEdge(panelId, 'right', 300)
}

describe('layoutStorageKeyFor (TD4.1)', () => {
  test('the main window keeps the historical key', () => {
    expect(layoutStorageKeyFor('')).toBe(layoutStorageKey())
    expect(layoutStorageKey()).toBe('mindwave-panel-layout')
  })

  test('a host window gets a key of its own', () => {
    expect(layoutStorageKeyFor('track-editor')).toBe('mindwave-panel-layout@track-editor')
    expect(layoutStorageKeyFor('track-editor')).not.toBe(layoutStorageKey())
  })
})

describe('createPanelLayout persistence (TD-D9)', () => {
  test('a store writes only under its own key', async () => {
    const child = createPanelLayout(layoutStorageKeyFor('track-editor'))
    dockOne(child, 'track-history')
    await nextTick()
    expect(storage.data.has('mindwave-panel-layout@track-editor')).toBe(true)
    // THE regression: the main window's tree must be untouched by anything the child does.
    expect(storage.data.has(layoutStorageKey())).toBe(false)
  })

  test('two stores over different keys do not see each other', async () => {
    const main = createPanelLayout(layoutStorageKey())
    const child = createPanelLayout(layoutStorageKeyFor('track-editor'))
    dockOne(main, 'undo-journal')
    dockOne(child, 'track-history')
    await nextTick()

    expect(main.isDocked('undo-journal')).toBe(true)
    expect(main.isDocked('track-history')).toBe(false)
    expect(child.isDocked('track-history')).toBe(true)
    expect(child.isDocked('undo-journal')).toBe(false)
    expect(storage.data.get(layoutStorageKey())).not.toBe(storage.data.get('mindwave-panel-layout@track-editor'))
  })

  test('a store loads the tree persisted under its own key', () => {
    const child = createPanelLayout(layoutStorageKeyFor('track-editor'))
    dockOne(child, 'track-history')
    const saved = serializeLayout(child.tree.value as LayoutNode)
    storage.data.set('mindwave-panel-layout@track-editor', saved)
    storage.data.set(layoutStorageKey(), serializeLayout(createPanelLayout('scratch').tree.value as LayoutNode))

    const reopened = createPanelLayout(layoutStorageKeyFor('track-editor'))
    expect(reopened.isDocked('track-history')).toBe(true)
  })

  test('init() migrates into its own key, not the main one', () => {
    storage.data.set('mindwave-panel-undo-journal-mode', 'left')
    storage.data.set('mindwave-panel-undo-journal-dock-size', '300')
    const child = createPanelLayout(layoutStorageKeyFor('track-editor'))
    child.init([{ panelId: 'undo-journal' }])
    expect(storage.data.has('mindwave-panel-layout@track-editor')).toBe(true)
    expect(storage.data.has(layoutStorageKey())).toBe(false)
  })

  test('init() is one-shot: a store that already has a persisted tree ignores legacy keys', () => {
    const first = createPanelLayout(layoutStorageKeyFor('track-editor'))
    dockOne(first, 'track-history')
    storage.data.set('mindwave-panel-layout@track-editor', serializeLayout(first.tree.value as LayoutNode))
    storage.data.set('mindwave-panel-undo-journal-mode', 'left')

    const reopened = createPanelLayout(layoutStorageKeyFor('track-editor'))
    reopened.init([{ panelId: 'undo-journal' }])
    expect(reopened.isDocked('track-history')).toBe(true)
    expect(reopened.isDocked('undo-journal')).toBe(false)
  })
})
