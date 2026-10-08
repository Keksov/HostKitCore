// gnauralcity GCY1.3 (GCY-D22): the lock of the parametrisation itself — every name the panel
// framework writes outside the JS realm comes from the host's prefix, and from nowhere else.
//
// Three things are pinned down:
//   1. MindWave's names stay byte for byte what they were before the prefix became a setting (the
//      owner's saved layout and panel geometry stay in place — GCY-D22 says «no migration»);
//   2. another host's prefix reaches every one of them — storage keys, the legacy-migration keys,
//      the bridge channel and the detached window's name;
//   3. there is no default: asking for a name before configurePanelKit() throws, and importing the
//      framework computes no name at all (modules are evaluated before the host's boot code runs).
//
// Run (part of the verify procedure, see AGENTS.md):
//   cd HostKitCore && bun test
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { nextTick } from 'vue'

import { configurePanelKit, panelKitName } from './panel-kit'
import { createPanelLayout, layoutStorageKey, layoutStorageKeyFor } from './use-panel-layout'
import { detachedRectKey, detachedWindowName, panelStoragePrefix, usePanelWindowState } from './use-panel-window'
import { panelChannelName } from './use-panel-bridge'

// bun has no DOM: the stores read/write the ambient `localStorage`, so the test supplies one.
const data = new Map<string, string>()
const fakeStorage = {
  getItem: (key: string): string | null => data.get(key) ?? null,
  setItem: (key: string, value: string): void => { data.set(key, value) },
  removeItem: (key: string): void => { data.delete(key) },
}
const globals = globalThis as unknown as { localStorage?: unknown }
let hadLocalStorage = false
let previous: unknown

beforeEach(() => {
  data.clear()
  hadLocalStorage = 'localStorage' in globals
  previous = globals.localStorage
  globals.localStorage = fakeStorage
})

afterEach(() => {
  if (hadLocalStorage) globals.localStorage = previous
  else delete globals.localStorage
})

/** Every name the framework makes, for one panel id and one host-window id. */
const namesOf = (panelId: string, hostPanelId: string): Record<string, string> => ({
  layout: layoutStorageKeyFor(''),
  hostLayout: layoutStorageKeyFor(hostPanelId),
  panel: panelStoragePrefix(panelId),
  hostPanel: panelStoragePrefix(panelId, hostPanelId),
  detachedRect: detachedRectKey(panelId),
  channel: panelChannelName(panelId),
  window: detachedWindowName(panelId),
})

describe('panel-kit: names follow the host prefix (GCY-D22)', () => {
  // The historical literals, as the code wrote them before GCY1.3 (use-panel-layout.ts:27/38/126,
  // use-panel-window.ts:59/242). The channel and the window name were 'mw-panel…' then; they are
  // internal (parent and child are one bundle) and now follow the prefix like everything else.
  test("MindWave ('mindwave-') keeps its storage keys byte for byte", () => {
    configurePanelKit({ keyPrefix: 'mindwave-' })
    expect(namesOf('undo-journal', 'track-editor')).toEqual({
      layout: 'mindwave-panel-layout',
      hostLayout: 'mindwave-panel-layout@track-editor',
      panel: 'mindwave-panel-undo-journal-',
      hostPanel: 'mindwave-panel-undo-journal@track-editor-',
      detachedRect: 'mindwave-panel-undo-journal-detached-rect',
      channel: 'mindwave-panel:undo-journal',
      window: 'mindwave-panel-undo-journal',
    })
  })

  test('another host gets every name under its own prefix', () => {
    configurePanelKit({ keyPrefix: 'gnauralcity-' })
    expect(namesOf('undo-journal', 'track-editor')).toEqual({
      layout: 'gnauralcity-panel-layout',
      hostLayout: 'gnauralcity-panel-layout@track-editor',
      panel: 'gnauralcity-panel-undo-journal-',
      hostPanel: 'gnauralcity-panel-undo-journal@track-editor-',
      detachedRect: 'gnauralcity-panel-undo-journal-detached-rect',
      channel: 'gnauralcity-panel:undo-journal',
      window: 'gnauralcity-panel-undo-journal',
    })
    expect(layoutStorageKey()).toBe('gnauralcity-panel-layout')
  })

  test('panel state persists under the prefix in force (the five per-panel fields)', async () => {
    configurePanelKit({ keyPrefix: 'gnauralcity-' })
    // A panel id of its own: usePanelWindowState keeps a module-level instance per id.
    const state = usePanelWindowState('panel-kit-test-a')
    state.open = true
    state.setMode('docked')
    state.setDockSize(300)
    state.setFloatRect({ x: 10 })
    await nextTick()
    expect([...data.keys()].sort()).toEqual([
      'gnauralcity-panel-panel-kit-test-a-dock-size',
      'gnauralcity-panel-panel-kit-test-a-float',
      'gnauralcity-panel-panel-kit-test-a-mode',
      'gnauralcity-panel-panel-kit-test-a-open',
      'gnauralcity-panel-panel-kit-test-a-prev-mode',
    ])
  })

  test('the one-shot legacy migration reads the legacy keys under the prefix in force', () => {
    configurePanelKit({ keyPrefix: 'gnauralcity-' })
    data.set('mindwave-panel-undo-journal-mode', 'left') // somebody else's key: must be ignored
    data.set('gnauralcity-panel-track-history-mode', 'right')
    data.set('gnauralcity-panel-track-history-dock-size', '300')
    const layout = createPanelLayout(layoutStorageKey())
    layout.init([{ panelId: 'undo-journal' }, { panelId: 'track-history' }])
    expect(layout.isDocked('track-history')).toBe(true)
    expect(layout.isDocked('undo-journal')).toBe(false)
    expect(data.has('gnauralcity-panel-layout')).toBe(true)
    expect(data.has('mindwave-panel-layout')).toBe(false)
  })

  test('an empty prefix is refused', () => {
    expect(() => configurePanelKit({ keyPrefix: '' })).toThrow('keyPrefix must be a non-empty string')
  })
})

describe('panel-kit: no default prefix', () => {
  // A FRESH process: in this one other tests have configured the kit already, and a reset hook
  // exported just for tests would be a second way to reach the state — the very thing production
  // never does. The child imports the framework's modules exactly as an app does, BEFORE any
  // configuration, which is also the proof that no name is computed at module top level.
  test('importing the framework computes no name; asking for one before configuration throws', () => {
    const url = (file: string): string => pathToFileURL(join(import.meta.dir, file)).href
    const script = [
      `const mods = await Promise.all([${['panel-kit.ts', 'use-panel-layout.ts', 'use-panel-window.ts', 'use-panel-bridge.ts', 'layout-model.ts', 'dock-zones.ts', 'panel-registry.ts'].map((f) => JSON.stringify(url(f))).join(', ')}].map((u) => import(u)))`,
      `const calls = { kit: () => mods[0].panelKitName('-layout'), layout: () => mods[1].layoutStorageKeyFor(''), window: () => mods[2].usePanelWindowState('x'), rect: () => mods[2].detachedRectKey('x'), name: () => mods[2].detachedWindowName('x'), channel: () => mods[3].panelChannelName('x') }`,
      `const out = {}`,
      `for (const [k, f] of Object.entries(calls)) { try { out[k] = 'returned ' + JSON.stringify(f()) } catch (e) { out[k] = e.message } }`,
      `console.log(JSON.stringify(out))`,
    ].join('\n')
    const child = Bun.spawnSync({ cmd: [process.execPath, '--eval', script], cwd: import.meta.dir, stderr: 'pipe' })
    expect(child.stderr.toString()).toBe('')
    expect(child.exitCode).toBe(0)
    const out = JSON.parse(child.stdout.toString().trim()) as Record<string, string>
    const refusal = 'panel framework (@panel) used before configurePanelKit({ keyPrefix })'
    expect(Object.keys(out).sort()).toEqual(['channel', 'kit', 'layout', 'name', 'rect', 'window'])
    for (const [call, result] of Object.entries(out)) {
      expect(`${call}: ${result.slice(0, refusal.length)}`).toBe(`${call}: ${refusal}`)
    }
    // …and this process, where the kit IS configured, answers the same calls (the refusal above is
    // about the missing configuration, not a broken import).
    configurePanelKit({ keyPrefix: 'mindwave-' })
    expect(panelKitName('-layout')).toBe('mindwave-panel-layout')
  })
})
