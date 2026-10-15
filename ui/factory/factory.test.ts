// gnauralcity GCY1.6 (GCY-D17): the locks of the host UI factory.
//
// Pinned down:
//   1. the shell's pin is GCY-D17's list — vue, pinia, vue-i18n, vue-router, quasar;
//   2. ONE list, two halves: for every pin, the bundler's alias and the type checker's `paths` send the
//      same specifiers into the host's node_modules (bare import; deep imports where the pin says so;
//      a whole npm scope), and an anchored pin never catches a neighbour (`vue-router`, `@vue/…`);
//   3. for a host GIVEN here: the generated tsconfig extends the base from the host's ui/ and carries
//      the whole `paths` (quasar twins, the host's own, the shell's aliases, the pin) in a fixed order,
//      and the quasar config, run, pins the same packages and aliases the shell to the same places.
//      Whether each REAL host's file is current is a workspace check (validate-qa.js, by the registry):
//      HostKitCore knows no host, and these tests read nothing outside it (GCY-D1, GCY-D19);
//   4. what moved from MindWave's quasar.config.ts behaves as it did there: the warn build (define +
//      index.html marker, off unless enabled), manual chunks (first rule wins, the previous function is
//      still asked, array outputs), the dev proxy's port (PORT, then SERVER_PORT, then the default).
//
// Run (part of the verify procedure, see AGENTS.md):
//   cd HostKitCore && bun test
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import { BASE_TSCONFIG, hostTsPaths, renderHostTsconfig } from './host-tsconfig'
import { type HostUiConfig, mergeDistinct, SHELL_ALIASES } from './host-ui'
import { hostModuleEntries, modulePackageEntries } from './module-packages'
import { type PinnedPackage, SHELL_PINS, pinLabel, pinnedTsPaths, pinnedViteAliases, type ViteAliasEntry } from './pins'
import { hostQuasarConfig } from './quasar-config'

/** What the bundler makes of a specifier: the first alias that matches, as @rollup/plugin-alias does. */
function viteResolve(aliases: readonly ViteAliasEntry[], specifier: string): string | null {
  for (const { find, replacement } of aliases) {
    if (typeof find === 'string') {
      if (specifier === find || specifier.startsWith(`${find}/`)) return replacement + specifier.slice(find.length)
      continue
    }
    if (find.test(specifier)) return specifier.replace(find, replacement)
  }
  return null
}

/** What the type checker makes of a specifier through `paths`: an exact key, else the longest wildcard. */
function tsResolve(paths: Readonly<Record<string, readonly string[]>>, specifier: string): string | null {
  const exact = paths[specifier]
  if (exact !== undefined) return exact[0] ?? null
  let best: { prefix: string; target: string } | null = null
  for (const [key, targets] of Object.entries(paths)) {
    if (!key.endsWith('/*') || targets[0] === undefined) continue
    const prefix = key.slice(0, -1)
    if (specifier.startsWith(prefix) && (best === null || prefix.length > best.prefix.length)) best = { prefix, target: targets[0] }
  }
  return best === null ? null : best.target.replace('*', specifier.slice(best.prefix.length))
}

const ROOT = 'C:/host/ui/node_modules'
const SAMPLE_MODULE_PINS: readonly PinnedPackage[] = [
  { name: 'codemirror' },
  { scope: '@codemirror' },
  { name: 'echarts', deep: 'bundle-and-types' },
]

describe('the pin (GCY-D17)', () => {
  test("the shell's own packages are D17's list, in a fixed order", () => {
    expect(SHELL_PINS.map(pinLabel)).toEqual(['vue', 'pinia', 'vue-i18n', 'vue-router', 'quasar'])
  })

  test('one list, two halves: bundler and type checker send each pinned specifier into the same package', () => {
    const pins = [...SAMPLE_MODULE_PINS, ...SHELL_PINS]
    const aliases = pinnedViteAliases(pins, ROOT)
    const paths = pinnedTsPaths(pins, './node_modules')
    for (const pin of pins) {
      if ('scope' in pin) {
        const spec = `${pin.scope}/view`
        expect(viteResolve(aliases, spec)).toBe(`${ROOT}/${pin.scope}/view`)
        expect(tsResolve(paths, spec)).toBe(`./node_modules/${pin.scope}/view`)
        continue
      }
      const bare = viteResolve(aliases, pin.name)
      expect(bare).toBe(pin.entry === undefined ? `${ROOT}/${pin.name}` : `${ROOT}/${pin.name}/${pin.entry}`)
      expect(tsResolve(paths, pin.name)).toBe(`./node_modules/${pin.name}`)
      const deep = `${pin.name}/sub/file`
      expect(viteResolve(aliases, deep)).toBe(pin.deep === 'bundle-and-types' ? `${ROOT}/${pin.name}/sub/file` : null)
      expect(tsResolve(paths, deep)).toBe(pin.deep === undefined ? null : `./node_modules/${pin.name}/sub/file`)
    }
    // Same packages in both halves — nothing pinned on one side only.
    expect(Object.keys(paths).map((key) => key.replace(/\/\*$/, '')).filter((v, i, all) => all.indexOf(v) === i).sort())
      .toEqual(pins.map((pin) => ('scope' in pin ? pin.scope : pin.name)).sort())
  })

  test("an anchored pin never catches a neighbour's specifier", () => {
    const aliases = pinnedViteAliases(SHELL_PINS, ROOT)
    expect(viteResolve(aliases, 'vue-router')).toBe(`${ROOT}/vue-router/dist/vue-router.mjs`)
    expect(viteResolve(aliases, '@vue/runtime-core')).toBeNull()
    expect(viteResolve(aliases, 'vue-demi')).toBeNull()
    expect(viteResolve(aliases, 'quasarx')).toBeNull()
    expect(tsResolve(pinnedTsPaths(SHELL_PINS, './node_modules'), '@vue/runtime-core')).toBeNull()
  })

  test('a host entry that would shadow a shell alias or a pin is refused, not silently overridden', () => {
    expect(() => mergeDistinct('alias', { '@panel': 'a' }, { '@panel': 'b' })).toThrow('"@panel" is set twice')
    const host = sampleHost({ tsPaths: { vue: ['./elsewhere'] } })
    expect(() => hostTsPaths(host)).toThrow('"vue" is set twice')
  })
})

describe('a host given here (no registry, no host files — GCY-D1: HostKitCore knows no host)', () => {
  // A host laid out like the workspace's: <ws>/Host/ui next to <ws>/HostKitCore. Paths only, nothing read.
  const WS = resolve('/ws')
  const host = sampleHost({
    uiDir: join(WS, 'Host', 'ui'),
    hostKitDir: join(WS, 'HostKitCore'),
    aliases: { '@hostlib': join(WS, 'Shared', 'hostlib.ts') },
    tsPaths: { '@hostlib': ['../server/hostlib.ts'] },
  })

  test('the generated tsconfig extends the base, from the host, and carries the whole paths block', () => {
    const text = renderHostTsconfig(host)
    expect(text.startsWith('// GENERATED by HostKitCore/ui/factory/write-host-tsconfig.ts')).toBe(true)
    expect(text).toContain('bun ../../HostKitCore/ui/factory/write-host-tsconfig.ts .')
    expect(text.endsWith('}\n')).toBe(true)
    const json = JSON.parse(text.slice(text.indexOf('{'))) as { extends: string; compilerOptions: { paths: Record<string, string[]> } }
    expect(json.extends).toBe(`../../HostKitCore/${BASE_TSCONFIG}`)
    expect(json.compilerOptions.paths).toEqual(hostTsPaths(host))
    expect(Object.keys(json.compilerOptions.paths)).toEqual([
      'src/*', 'layouts/*', 'pages/*', 'components/*', 'boot/*', 'stores/*',
      '@hostlib',
      '@panel/*', '@tooltip/*', '@hostkit/*',
      'codemirror', '@codemirror/*', 'echarts', 'echarts/*',
      'vue', 'vue/*', 'pinia', 'pinia/*', 'vue-i18n', 'vue-i18n/*', 'vue-router', 'vue-router/*', 'quasar', 'quasar/*',
    ])
    expect(json.compilerOptions.paths['@hostkit/*']).toEqual(['../../HostKitCore/ui/*'])
  })

  test('the quasar config pins and aliases what the generated tsconfig does', () => {
    const config = hostQuasarConfig(host)()
    const viteConf: ViteConfProbe = { resolve: { alias: [] }, build: { rollupOptions: {} } }
    config.build.extendViteConf(viteConf)
    const aliases = viteConf.resolve.alias
    const paths = hostTsPaths(host)
    const nodeModules = join(host.uiDir, 'node_modules').replace(/\\/g, '/')
    const pinned = Object.keys(paths).filter((key) => paths[key]?.[0]?.startsWith('./node_modules/'))
    expect(pinned.length).toBe(14)
    for (const key of pinned) {
      const spec = key.endsWith('/*') ? `${key.slice(0, -2)}/x` : key
      expect(tsResolve(paths, spec)).not.toBeNull()
      const viaBundler = viteResolve(aliases, spec)
      // A deep pin for types only (vue/*) has no bundler twin; every other one has it, in the same package.
      if (viaBundler === null) {
        expect(key.endsWith('/*') && paths[key.slice(0, -2)] !== undefined).toBe(true)
        continue
      }
      expect(viaBundler.startsWith(`${nodeModules}/${key.replace(/\/\*$/, '')}`)).toBe(true)
    }
    // The shell's aliases: the bundler's target is the type checker's, resolved from the host's ui/.
    const alias: Record<string, string | undefined> = config.build.alias
    for (const name of Object.keys(SHELL_ALIASES)) {
      const twin = paths[`${name}/*`]?.[0] ?? ''
      expect(resolve(host.uiDir, twin.replace(/\/\*$/, ''))).toBe(resolve(alias[name] ?? '?'))
    }
    expect(alias['@hostlib']).toBe(join(WS, 'Shared', 'hostlib.ts'))
  })

  test("GCY2.1: the root component and the store are the shell's, named relative to the host's ui/", () => {
    const config = hostQuasarConfig(host)()
    expect(config.sourceFiles).toEqual({
      rootComponent: '../../HostKitCore/ui/app/HostApp.vue',
      store: '../../HostKitCore/ui/app/host-store',
    })
    // Quasar imports them as `app/<path>` and looks for the store against the host's ui/: both land in
    // HostKitCore — the files next to this test's directory (read inside HostKitCore only).
    const kitUi = resolve(import.meta.dir, '..')
    expect(existsSync(join(kitUi, 'app', 'HostApp.vue'))).toBe(true)
    expect(existsSync(join(kitUi, 'app', 'host-store.ts'))).toBe(true)
    expect(resolve(host.uiDir, config.sourceFiles.rootComponent)).toBe(join(WS, 'HostKitCore', 'ui', 'app', 'HostApp.vue'))
    expect(resolve(host.uiDir, config.sourceFiles.store)).toBe(join(WS, 'HostKitCore', 'ui', 'app', 'host-store'))
    // The router stays quasar's default: the host's own src/router/index.ts (its routes).
    expect('router' in config.sourceFiles).toBe(false)
  })
})

// GCY4.1 (GCY-D14): a host imports a module by NAME, only through the entries the module declares in its
// package.json `exports`. One table (the module's), two halves (the bundler's anchored aliases, the type
// checker's exact `paths`): every entry lands on the same file in both, and an undeclared path by name
// lands nowhere in either. The module packages here are written into a temp folder — HostKitCore reads
// no module of the workspace (GCY-D1).
describe('module packages by name (GCY4.1, GCY-D14)', () => {
  const WS = mkdtempSync(join(tmpdir(), 'hostkit-factory-modules-'))
  const write = (aPath: string, aText: string): void => {
    mkdirSync(join(WS, aPath, '..'), { recursive: true })
    writeFileSync(join(WS, aPath), aText)
  }
  const modPackage = (aDir: string, aPkg: unknown): string => {
    write(`${aDir}/package.json`, JSON.stringify(aPkg, null, 2))
    return join(WS, aDir)
  }
  for (const file of ['index.ts', 'module.ts', 'widgets.ts', 'protocol/index.ts', 'stores/audio.ts']) write(`Mod/ui/${file}`, 'export {}\n')
  write('Mod/server/index.ts', 'export {}\n')
  const modUi = modPackage('Mod/ui', {
    name: '@mod/ui',
    '//exports': 'a comment key next to the table, as in GnauralCore',
    exports: { '.': './index.ts', './module': './module.ts', './widgets': './widgets.ts', './protocol': './protocol/index.ts' },
  })
  const modServer = modPackage('Mod/server', { name: '@mod/server', exports: { '.': './index.ts' } })
  const host = sampleHost({ uiDir: join(WS, 'Host', 'ui'), hostKitDir: join(WS, 'HostKitCore'), modulePackages: [modUi] })

  afterAll(() => rmSync(WS, { recursive: true, force: true }))

  test("the entries are the package's name and exports, in its order, onto absolute files", () => {
    expect(modulePackageEntries(modUi).map((entry) => [entry.specifier, entry.file])).toEqual([
      ['@mod/ui', join(WS, 'Mod', 'ui', 'index.ts')],
      ['@mod/ui/module', join(WS, 'Mod', 'ui', 'module.ts')],
      ['@mod/ui/widgets', join(WS, 'Mod', 'ui', 'widgets.ts')],
      ['@mod/ui/protocol', join(WS, 'Mod', 'ui', 'protocol', 'index.ts')],
    ])
  })

  test('one table, two halves: each entry lands on the same file; an undeclared path by name lands nowhere', () => {
    const aliases = runExtend(host).resolve.alias
    const paths = hostTsPaths(host)
    for (const entry of modulePackageEntries(modUi)) {
      expect(viteResolve(aliases, entry.specifier)).toBe(entry.file.replace(/\\/g, '/'))
      expect(resolve(host.uiDir, tsResolve(paths, entry.specifier) ?? '?')).toBe(entry.file)
      expect(paths[entry.specifier]).toEqual([relative(host.uiDir, entry.file).replace(/\\/g, '/')])
    }
    for (const deep of ['@mod/ui/stores/audio', '@mod/ui/module/x', '@mod/ui/', '@mod/uix', '@mod/server']) {
      expect([deep, viteResolve(aliases, deep)]).toEqual([deep, null])
      expect([deep, tsResolve(paths, deep)]).toEqual([deep, null])
    }
    // The generated tsconfig puts them after the shell's aliases, before the pin.
    const keys = Object.keys(paths)
    expect(keys.slice(keys.indexOf('@hostkit/*') + 1, keys.indexOf('codemirror'))).toEqual([
      '@mod/ui', '@mod/ui/module', '@mod/ui/widgets', '@mod/ui/protocol',
    ])
  })

  test('several packages: both, in the host order', () => {
    const both = sampleHost({ uiDir: host.uiDir, hostKitDir: host.hostKitDir, modulePackages: [modServer, modUi] })
    expect(hostModuleEntries(both.modulePackages).map((entry) => entry.specifier)).toEqual([
      '@mod/server', '@mod/ui', '@mod/ui/module', '@mod/ui/widgets', '@mod/ui/protocol',
    ])
    expect(viteResolve(runExtend(both).resolve.alias, '@mod/server')).toBe(join(WS, 'Mod', 'server', 'index.ts').replace(/\\/g, '/'))
  })

  test('a table the factory cannot honour exactly is refused, loudly', () => {
    const bad = (aName: string, aExports: unknown): string => modPackage(`Bad/${aName}`, { name: `@bad/${aName}`, exports: aExports })
    write('Bad/x.ts', 'export {}\n')
    expect(() => modulePackageEntries(bad('star', { './*': './*.ts' }))).toThrow('is a pattern')
    expect(() => modulePackageEntries(bad('cond', { '.': { import: './index.ts' } }))).toThrow('is not a plain')
    expect(() => modulePackageEntries(bad('missing', { '.': './nope.ts' }))).toThrow('names a missing file')
    expect(() => modulePackageEntries(bad('none', undefined))).toThrow('no "exports" table')
    expect(() => modulePackageEntries(bad('empty', {}))).toThrow('"exports" is empty')
    expect(() => modulePackageEntries(join(WS, 'Nowhere'))).toThrow('no package.json')
    // The same name from two packages, and a module name that is also a host alias.
    expect(() => hostModuleEntries([modUi, modUi])).toThrow('"@mod/ui" is declared twice')
    const clash = sampleHost({ uiDir: host.uiDir, hostKitDir: host.hostKitDir, modulePackages: [modUi], aliases: { '@mod/ui': 'x' } })
    expect(() => hostQuasarConfig(clash)).toThrow('"@mod/ui" is set twice')
    expect(() => hostTsPaths(sampleHost({ ...clash, aliases: {}, tsPaths: { '@mod/ui/widgets': ['x'] } }))).toThrow('"@mod/ui/widgets" is set twice')
  })
})


describe('what moved from the host config behaves as it did there', () => {
  test('warn build off: no define, no marker plugin', () => {
    const conf = runExtend(sampleHost({ vueWarnBuild: { enabled: false, marker: '__X__', pluginName: 'x-marker' } }))
    expect(conf.define).toBeUndefined()
    expect(conf.plugins).toBeUndefined()
  })

  test("warn build on: NODE_ENV is 'development' and index.html gets the host's marker", () => {
    const conf = runExtend(sampleHost({ vueWarnBuild: { enabled: true, marker: '__X__', pluginName: 'x-marker' } }), { define: { keep: '1' } })
    expect(conf.define).toEqual({ keep: '1', 'process.env.NODE_ENV': '"development"' })
    const plugin = conf.plugins?.[0] as { name: string; transformIndexHtml: () => unknown }
    expect(plugin.name).toBe('x-marker')
    expect(plugin.transformIndexHtml()).toEqual([{ tag: 'script', injectTo: 'head-prepend', children: 'window.__X__=true' }])
  })

  test('manual chunks: first matching rule wins, both path styles, else the previous function is asked', () => {
    const previous = (id: string) => (id.endsWith('.special') ? 'special' : undefined)
    const conf = runExtend(sampleHost({}), { build: { rollupOptions: { output: { manualChunks: previous, keep: 1 } } } })
    const output = conf.build?.rollupOptions?.output as { manualChunks: (id: string) => unknown; keep: number }
    expect(output.keep).toBe(1)
    expect(output.manualChunks('/w/node_modules/zrender/lib/a.js')).toBe('charts-renderer')
    expect(output.manualChunks('C:\\w\\node_modules\\echarts\\core.js')).toBe('charts-core')
    expect(output.manualChunks('/w/node_modules/echartsx/a.js')).toBeUndefined()
    expect(output.manualChunks('/w/src/a.special')).toBe('special')
  })

  test('manual chunks: an array of outputs gets the rule each; no rules leave the output alone', () => {
    const conf = runExtend(sampleHost({}), { build: { rollupOptions: { output: [{}, {}] } } })
    const outputs = conf.build?.rollupOptions?.output as { manualChunks: (id: string) => unknown }[]
    expect(outputs.map((o) => o.manualChunks('/w/node_modules/zrender/a.js'))).toEqual(['charts-renderer', 'charts-renderer'])
    const untouched = { foo: 1 }
    const bare = runExtend(sampleHost({ chunks: [] }), { build: { rollupOptions: { output: untouched } } })
    expect(bare.build?.rollupOptions?.output).toBe(untouched)
  })

  test("dev proxy: PORT, else SERVER_PORT, else the host's default", () => {
    const saved = { PORT: process.env.PORT, SERVER_PORT: process.env.SERVER_PORT }
    const target = () => hostQuasarConfig(sampleHost({}))().devServer.proxy['/api'].target
    try {
      delete process.env.PORT
      delete process.env.SERVER_PORT
      expect(target()).toBe('http://localhost:3999')
      process.env.SERVER_PORT = '4568'
      expect(target()).toBe('http://localhost:4568')
      process.env.PORT = '4567'
      expect(target()).toBe('http://localhost:4567')
      expect(hostQuasarConfig(sampleHost({}))().devServer.proxy['/ws/ui']).toEqual({ target: 'http://localhost:4567', ws: true })
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})

interface ViteConfProbe {
  define?: Record<string, unknown>
  plugins?: unknown[]
  resolve: { alias: ViteAliasEntry[] }
  build: { rollupOptions: { output?: Record<string, unknown> | Record<string, unknown>[] } }
}

function sampleHost(overrides: Partial<HostUiConfig>): HostUiConfig {
  return {
    uiDir: 'C:/host/ui',
    hostKitDir: 'C:/HostKitCore',
    boot: [],
    css: [],
    extras: [],
    distDir: 'C:/host/server/public',
    aliases: {},
    tsPaths: {},
    modulePins: SAMPLE_MODULE_PINS,
    modulePackages: [],
    chunks: [
      { package: 'zrender', chunk: 'charts-renderer' },
      { package: 'echarts', chunk: 'charts-core' },
    ],
    defaultBackendPort: 3999,
    framework: {},
    ...overrides,
  }
}

function runExtend(host: HostUiConfig, start: Partial<ViteConfProbe> = {}): ViteConfProbe {
  const viteConf: ViteConfProbe = { resolve: { alias: [] }, build: { rollupOptions: {} }, ...start }
  hostQuasarConfig(host)().build.extendViteConf(viteConf)
  return viteConf
}
