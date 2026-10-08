// gnauralcity GCY1.5 (GCY-D22): the lock of the shell's one host setting — the key prefix.
//
// Pinned down:
//   1. MindWave's language key stays byte for byte 'mindwave-locale' (the owner's saved language stays
//      in place — no migration), and another host gets its own;
//   2. ONE state for the whole shell: the panel framework's configurePanelKit() and configureHostKeys()
//      set the very same value — a panel name and the language key always share the prefix;
//   3. there is no default: in a fresh process, asking for the language key before configuration
//      throws, and importing the shell computes no name (modules are evaluated before the host's boot).
//
// Run (part of the verify procedure, see AGENTS.md):
//   cd HostKitCore && bun test
import { afterAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { configureHostKeys, hostKey, isHostKeysConfigured } from './host-keys'
import { configurePanelKit, panelKitName } from '../panel/panel-kit'
import { localeStorageKey } from '../shell/language'

describe('host keys: one prefix for the whole shell (GCY-D22)', () => {
  // bun runs every test file in one process: leave the prefix as MindWave's, the way panel-kit.test.ts
  // leaves it (files that depend on it configure it themselves anyway).
  afterAll(() => {
    configureHostKeys({ keyPrefix: 'mindwave-' })
  })

  test("MindWave ('mindwave-') keeps its language key byte for byte", () => {
    configureHostKeys({ keyPrefix: 'mindwave-' })
    expect(localeStorageKey()).toBe('mindwave-locale')
    expect(hostKey('locale')).toBe('mindwave-locale')
    expect(panelKitName('-layout')).toBe('mindwave-panel-layout')
  })

  test('another host gets its language key under its own prefix', () => {
    configureHostKeys({ keyPrefix: 'gnauralcity-' })
    expect(localeStorageKey()).toBe('gnauralcity-locale')
  })

  test('configurePanelKit and configureHostKeys set ONE value: panel names and the language key move together', () => {
    configurePanelKit({ keyPrefix: 'a-' })
    expect([panelKitName('-layout'), localeStorageKey()]).toEqual(['a-panel-layout', 'a-locale'])
    configureHostKeys({ keyPrefix: 'b-' })
    expect([panelKitName('-layout'), localeStorageKey()]).toEqual(['b-panel-layout', 'b-locale'])
    expect(isHostKeysConfigured()).toBe(true)
  })

  test('an empty prefix is refused by both entries', () => {
    expect(() => configureHostKeys({ keyPrefix: '' })).toThrow('keyPrefix must be a non-empty string')
    expect(() => configurePanelKit({ keyPrefix: '' })).toThrow('keyPrefix must be a non-empty string')
  })
})

describe('host keys: no default prefix', () => {
  // A FRESH process, as in panel-kit.test.ts: here the prefix is configured already, and a reset hook
  // exported just for tests would be a second way to reach the state.
  test('importing the shell computes no name; asking for the language key before configuration throws', () => {
    const url = (file: string): string => pathToFileURL(join(import.meta.dir, file)).href
    const script = [
      `const mods = await Promise.all([${['host-keys.ts', '../shell/language.ts', '../shell/bun-actions.ts'].map((f) => JSON.stringify(url(f))).join(', ')}].map((u) => import(u)))`,
      `const calls = { configured: () => mods[0].isHostKeysConfigured(), key: () => mods[0].hostKey('locale'), locale: () => mods[1].localeStorageKey() }`,
      `const out = {}`,
      `for (const [k, f] of Object.entries(calls)) { try { out[k] = 'returned ' + JSON.stringify(f()) } catch (e) { out[k] = e.message } }`,
      `console.log(JSON.stringify(out))`,
    ].join('\n')
    const child = Bun.spawnSync({ cmd: [process.execPath, '--eval', script], cwd: import.meta.dir, stderr: 'pipe' })
    expect(child.stderr.toString()).toBe('')
    expect(child.exitCode).toBe(0)
    const out = JSON.parse(child.stdout.toString().trim()) as Record<string, string>
    const refusal = 'shell key "locale" asked for before configureHostKeys({ keyPrefix })'
    expect(out.configured).toBe('returned false')
    expect(`key: ${out.key?.slice(0, refusal.length)}`).toBe(`key: ${refusal}`)
    expect(`locale: ${out.locale?.slice(0, refusal.length)}`).toBe(`locale: ${refusal}`)
  })
})
