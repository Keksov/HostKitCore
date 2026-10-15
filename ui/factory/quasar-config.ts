// gnauralcity GCY1.6 (GCY-D17): the quasar config factory. A host's quasar.config.ts is
//
//   export const hostUi: HostUiConfig = { ... }        // what makes this host this host
//   export default hostQuasarConfig(hostUi)
//
// and gets what every host shares: the pin of one copy of the shell's packages and of its modules'
// libraries (`pins.ts`), the shell's aliases, the hash router, the build target, the dev proxy to its
// backend, the warn build and the manual chunks — all moved here from MindWave's quasar.config.ts
// without changing what the CLI builds (GCY-D12). GCY2.1: and the app files every host has the same —
// the root component and the pinia store (`SHELL_SOURCE_FILES`, quasar's `sourceFiles`).
//
// Loaded by the quasar CLI from the host's config: esbuild bundles this file into a temporary file next
// to the host's quasar.config.ts (relative imports are bundled, packages stay external) — keep it free
// of package imports and of `import.meta.url`.

import { join } from 'node:path'

import { type HostUiConfig, hostPins, hostSourceFiles, mergeDistinct, shellAliasTargets } from './host-ui'
import { hostModuleEntries, moduleViteAliases } from './module-packages'
import { pinnedViteAliases, type ViteAliasEntry } from './pins'

/** The parts of the Vite config `extendViteConf` touches (quasar hands over the whole config). */
interface ViteConfLike {
  define?: Record<string, unknown>
  plugins?: unknown[]
  resolve?: { alias?: ViteAliasEntry[] | Record<string, string> }
  build?: { rollupOptions?: { output?: RollupOutputLike | RollupOutputLike[] } }
}

interface RollupOutputLike {
  manualChunks?: unknown
  [key: string]: unknown
}

/** The quasar config function a host's quasar.config.ts exports as its default. */
export function hostQuasarConfig(host: HostUiConfig) {
  // Backend port for the dev proxy. AppCore may relocate the server to a free port (multiple apps at
  // once) and passes it via PORT — follow it, else the host's default.
  const backendPort = Number(process.env.PORT) || Number(process.env.SERVER_PORT) || host.defaultBackendPort
  const proxyTarget = `http://localhost:${backendPort}`
  const vueWarnBuild = host.vueWarnBuild?.enabled === true ? host.vueWarnBuild : undefined
  // The pin: one list, from which the host's generated tsconfig gets its `paths` too.
  const pins = hostPins(host)
  const alias = mergeDistinct('alias', host.aliases, shellAliasTargets(host.hostKitDir))
  // GCY4.1 (GCY-D14): the modules' declared entries (module-packages.ts) — read once, when the config is
  // built; a name that would also be a host or shell alias is refused like any other double entry.
  const moduleEntries = hostModuleEntries(host.modulePackages)
  mergeDistinct('alias', alias, Object.fromEntries(moduleEntries.map((entry) => [entry.specifier, entry.file])))

  return function (/* ctx */) {
    return {
      // GCY2.1: the root component and the pinia store are the shell's (`SHELL_SOURCE_FILES`); the
      // router stays quasar's default, the host's `src/router/index.ts`.
      sourceFiles: hostSourceFiles(host),

      boot: [...host.boot],

      css: [...host.css],

      extras: [...host.extras],

      build: {
        target: { browser: ['es2022'] },
        vueRouterMode: 'hash',
        distDir: host.distDir,
        // The host's own aliases, then the shell's (`@panel`, `@tooltip`, `@hostkit`); their tsconfig
        // twins are generated from the same tables (`host-tsconfig.ts`).
        alias: { ...alias },
        extendViteConf(viteConf: ViteConfLike) {
          // VWG1.1 (VWG-D2): рычаг предупреждений — НЕ `__DEV__` (слова `__DEV__` в сборках Vue нет
          // ни разу), а `process.env.NODE_ENV`: в vue.runtime.esm-bundler.js и
          // @vue/runtime-core/.../runtime-core.esm-bundler.js каждое предупреждение стоит под
          // `process.env.NODE_ENV !== "production"`. Ставится ПЕРВЫМ делом — ниже по функции есть
          // ранний return для массива rollup-выходов.
          if (vueWarnBuild !== undefined) {
            viteConf.define = {
              ...(viteConf.define ?? {}),
              'process.env.NODE_ENV': JSON.stringify('development')
            }
            // VWG3.1: метка «это warn-сборка» прямо в index.html. По ней ворота сценарного слоя
            // отличают сборку, где предупреждения СУЩЕСТВУЮТ, от обычной, где их вырезали, — и на
            // обычной честно говорят, что ничего не стерегут. Имя метки и плагина — хоста.
            viteConf.plugins ??= []
            viteConf.plugins.push({
              name: vueWarnBuild.pluginName,
              transformIndexHtml() {
                return [{ tag: 'script', injectTo: 'head-prepend', children: `window.${vueWarnBuild.marker}=true` }]
              }
            })
          }

          viteConf.resolve ??= {}

          const currentAliases: ViteAliasEntry[] = Array.isArray(viteConf.resolve.alias)
            ? viteConf.resolve.alias
            : Object.entries(viteConf.resolve.alias ?? {}).map(([find, replacement]) => ({ find, replacement }))

          // TE4.8 (track-editor): a module tree carries vue+pinia as devDependencies so its own
          // `bun test` can boot the composable singletons. Vite resolves a bare import from the
          // IMPORTING file, so without this pin a module's composable would bundle that second copy
          // of vue — two reactivity systems, one app, and singletons that stop being single.
          // GCY1.3: HostKitCore/ui carries its own vue (and, through bun's peer install, quasar and
          // vue-i18n) for the same reason — the same pins keep the shell on the host's copies.
          // GCY4.1: the modules by name — anchored, one per declared entry, so an undeclared (deep) path
          // by name resolves nowhere. Before the pin: a module's name never collides with a pinned package.
          currentAliases.push(...moduleViteAliases(moduleEntries))
          currentAliases.push(...pinnedViteAliases(pins, join(host.uiDir, 'node_modules')))
          viteConf.resolve.alias = currentAliases

          if (host.chunks.length === 0) return

          viteConf.build ??= {}
          viteConf.build.rollupOptions ??= {}

          const applyManualChunks = (output: RollupOutputLike = {}): RollupOutputLike => ({
            ...output,
            manualChunks(id: string) {
              for (const rule of host.chunks) {
                if (id.includes(`/node_modules/${rule.package}/`) || id.includes(`\\node_modules\\${rule.package}\\`)) {
                  return rule.chunk
                }
              }

              return typeof output.manualChunks === 'function' ? output.manualChunks(id) : undefined
            }
          })

          const currentOutput = viteConf.build.rollupOptions.output
          if (Array.isArray(currentOutput)) {
            viteConf.build.rollupOptions.output = currentOutput.map((output) => applyManualChunks(output))
            return
          }

          viteConf.build.rollupOptions.output = applyManualChunks(currentOutput)
        }
      },

      devServer: {
        open: false,
        // The shell's server paths: its API and the ws transport (`@hostkit/ws/ws`, `/ws/ui`).
        proxy: {
          '/api': {
            target: proxyTarget
          },
          '/ws/ui': {
            target: proxyTarget,
            ws: true
          }
        }
      },

      framework: {
        ...(host.framework.config === undefined ? {} : { config: { ...host.framework.config } }),
        ...(host.framework.iconSet === undefined ? {} : { iconSet: host.framework.iconSet }),
        ...(host.framework.plugins === undefined ? {} : { plugins: [...host.framework.plugins] })
      }
    }
  }
}
