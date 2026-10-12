// gnauralcity GCY2.1 (GCY-D17): the locks of what every host's app gets from HostKitCore instead of
// writing it — moved here from MindWave's `src/router/routes.ts` and `src/boot/i18n.ts` without a change.
//
// Pinned down:
//   1. the modules' routes become vue-router records — name, path, component, in the modules' order;
//      nothing else of the module's contribution (the nav label is the layout's business);
//   2. vue-i18n of the app: the saved language is read under the HOST's key (`<prefix>locale` — MindWave's
//      stays 'mindwave-locale'), Russian when none is saved, English as the fallback, Composition API.
//
// Run (part of the verify procedure, see AGENTS.md):
//   cd HostKitCore && bun test
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import type { App } from 'vue'
import type { I18n } from 'vue-i18n'

import { configureHostKeys } from './host-keys'
import { DEFAULT_LOCALE, FALLBACK_LOCALE, installHostI18n } from './host-i18n'
import { moduleRouteRecords } from './host-router'
import type { CoreModuleRouteContribution } from './module-registry'

describe('module routes as router records', () => {
  test('name, path and component, in order; the nav label stays out', () => {
    const first = () => Promise.resolve({})
    const second = () => Promise.resolve({})
    const routes: CoreModuleRouteContribution[] = [
      { name: 'a.page', path: 'a', navLabelKey: 'nav.a', component: first },
      { name: 'b.page', path: 'b', navLabelKey: 'nav.b', component: second },
    ]
    expect(moduleRouteRecords(routes)).toEqual([
      { name: 'a.page', path: 'a', component: first },
      { name: 'b.page', path: 'b', component: second },
    ])
  })
})

describe("the app's vue-i18n", () => {
  const savedStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const store = new Map<string, string>()

  /** A storage with what the function reads; and an app that keeps what it is given. */
  function install(prefix: string): I18n {
    configureHostKeys({ keyPrefix: prefix })
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: (key: string) => store.get(key) ?? null },
    })
    const used: unknown[] = []
    installHostI18n({ use: (plugin: unknown) => used.push(plugin) } as unknown as App, { en: { a: 'A' }, ru: { a: 'А' } })
    expect(used.length).toBe(1)
    return used[0] as I18n
  }

  afterEach(() => {
    store.clear()
    if (savedStorage === undefined) delete (globalThis as { localStorage?: unknown }).localStorage
    else Object.defineProperty(globalThis, 'localStorage', savedStorage)
  })
  // bun runs every test file in one process: leave the prefix as MindWave's (host-keys.test.ts does too).
  afterAll(() => {
    configureHostKeys({ keyPrefix: 'mindwave-' })
  })

  test("the saved language is read under the host's key — MindWave's 'mindwave-locale'", () => {
    store.set('mindwave-locale', 'en')
    store.set('other-locale', 'ru')
    const i18n = install('mindwave-')
    expect(i18n.mode).toBe('composition')
    expect((i18n.global.locale as unknown as { value: string }).value).toBe('en')
  })

  test('another host reads its own key, not a neighbour\'s', () => {
    store.set('mindwave-locale', 'en')
    const i18n = install('gnauralcity-')
    expect((i18n.global.locale as unknown as { value: string }).value).toBe(DEFAULT_LOCALE)
  })

  test('nothing saved: Russian, with English as the fallback', () => {
    const i18n = install('mindwave-')
    expect(DEFAULT_LOCALE).toBe('ru')
    expect((i18n.global.locale as unknown as { value: string }).value).toBe('ru')
    expect((i18n.global.fallbackLocale as unknown as { value: unknown }).value).toBe(FALLBACK_LOCALE)
    expect(FALLBACK_LOCALE).toBe('en')
  })
})
