// gnauralcity GCY1.6 (GCY-D17, «хост = конфигурация»): what a host gives the UI factory, and what the
// factory adds on its own for every host. A host's quasar.config.ts exports its `HostUiConfig` as
// `hostUi` and its default as `hostQuasarConfig(hostUi)` (`quasar-config.ts`); the same object feeds
// the host's generated tsconfig (`host-tsconfig.ts`). Nothing here names a product or a module
// (GCY-D19): the module list, the brand, the libraries of the modules and the host's own additions
// all arrive in this object.

import { join, relative } from 'node:path'

import { SHELL_PINS, type PinnedPackage } from './pins'

export interface HostUiConfig {
  /** The host's ui/ directory — where its quasar.config.ts and tsconfig.json live. Absolute. */
  readonly uiDir: string
  /**
   * The HostKitCore checkout (absolute). Passed by the host, not derived here: the quasar CLI bundles
   * quasar.config.ts together with its relative imports into a temporary file NEXT TO the host's
   * config, so `import.meta.url` inside the factory names the host's directory, not this one.
   */
  readonly hostKitDir: string
  /** Quasar boot files, in order (the host's — the key prefix comes first, GCY-D22). */
  readonly boot: readonly string[]
  /** Quasar global css files. */
  readonly css: readonly string[]
  /** Quasar extras (icon fonts). */
  readonly extras: readonly string[]
  /** Where `quasar build` writes the bundle. Absolute. */
  readonly distDir: string
  /** The host's own bundler aliases (absolute targets), set before the shell's. */
  readonly aliases: Readonly<Record<string, string>>
  /**
   * The host's own tsconfig `paths` entries, relative to `uiDir` (the generated tsconfig lives there),
   * set after the quasar twins and before the shell's aliases and the pins.
   */
  readonly tsPaths: Readonly<Record<string, readonly string[]>>
  /**
   * Third-party libraries of the host's MODULES, pinned to the host's node_modules like the shell's
   * own packages (both halves — bundler and type checker — derived from this list). The host installs
   * them; the factory knows no module, so it cannot know their libraries.
   */
  readonly modulePins: readonly PinnedPackage[]
  /**
   * GCY4.1 (GCY-D14): the host's module packages — their folders (absolute), each with a package.json
   * whose `name` and `exports` are the module's declared entry points. The factory turns each entry into
   * an anchored bundler alias and an exact tsconfig `paths` key (`module-packages.ts`), so the host — and
   * the other modules it bundles — import a module by name and only through its entries.
   */
  readonly modulePackages: readonly string[]
  /**
   * Rollup `manualChunks` by package: a module from `node_modules/<package>/` goes into `chunk`; the
   * first matching rule wins. Empty: the factory leaves rollup's chunking alone.
   */
  readonly chunks: readonly { readonly package: string; readonly chunk: string }[]
  /**
   * The backend port the dev proxy targets when AppCore passes none. AppCore may relocate the server
   * to a free port (several apps at once) and passes it via PORT (or SERVER_PORT) — that wins.
   */
  readonly defaultBackendPort: number
  /**
   * The warn build (VWG-D2/VWG-D3): the same `quasar build`, but with Vue's dev warnings ALIVE —
   * `process.env.NODE_ENV` defined as 'development' — and a marker in index.html (`window[marker]=true`,
   * injected by a Vite plugin named `pluginName`) by which a test gate tells such a build from a
   * production one. `enabled` stays false by default: the production build must stay a production build.
   */
  readonly vueWarnBuild?: {
    readonly enabled: boolean
    readonly marker: string
    readonly pluginName: string
  }
  /** Quasar `framework` (config, icon set, plugins). */
  readonly framework: {
    readonly config?: Readonly<Record<string, unknown>>
    readonly iconSet?: string
    readonly plugins?: readonly string[]
  }
}

/**
 * The shell's own entry points (GCY-D2: the aliases keep their names, only their target moved here),
 * relative to the HostKitCore checkout. Every host and module imports the shell through them.
 */
export const SHELL_ALIASES: Readonly<Record<string, string>> = {
  // PW1.1 (PW-D8): the universal panel control, importable from module repos.
  '@panel': 'ui/panel',
  // TT1.2 (TT-D7): the universal tooltip control — the ONLY way to add a tooltip anywhere.
  '@tooltip': 'ui/tooltip',
  // GCY1.4 (GCY-D29): the rest of the shell — the ws transport (`@hostkit/ws/ws`), the module registry
  // and app assembly, the detached-panel page and route (`@hostkit/app/...`), the shell services.
  '@hostkit': 'ui',
}

/**
 * GCY2.1 (GCY-D17): the app files every host has the same, relative to the HostKitCore checkout — the
 * root component and the pinia store. Quasar takes them from here (its `sourceFiles`), so a host does not
 * write them: until GCY2.1 they were MindWave's `src/App.vue` and `src/stores/index.ts`, moved without
 * a change. Quasar keeps its defaults for the rest — the host's own `src/router/index.ts` (its routes) —
 * and requires `index.html` in the host's ui/ whatever is configured.
 */
export const SHELL_SOURCE_FILES = {
  rootComponent: 'ui/app/HostApp.vue',
  store: 'ui/app/host-store',
} as const

/**
 * Quasar's `sourceFiles` for a host: the shell's files, relative to the host's ui/ with forward slashes —
 * quasar imports them as `app/<path>` (`app` is its alias of the host's ui/) and looks for the store by
 * resolving the same path against the host's ui/.
 */
export const hostSourceFiles = (host: HostUiConfig): Record<keyof typeof SHELL_SOURCE_FILES, string> => ({
  rootComponent: relative(host.uiDir, join(host.hostKitDir, ...SHELL_SOURCE_FILES.rootComponent.split('/'))).replace(/\\/g, '/'),
  store: relative(host.uiDir, join(host.hostKitDir, ...SHELL_SOURCE_FILES.store.split('/'))).replace(/\\/g, '/'),
})

/** The shell's aliases with absolute targets, for the bundler. */
export const shellAliasTargets = (hostKitDir: string): Record<string, string> =>
  Object.fromEntries(Object.entries(SHELL_ALIASES).map(([name, rel]) => [name, join(hostKitDir, ...rel.split('/'))]))

/**
 * The host's whole pin, in the order both halves are emitted: its modules' libraries, then the shell's
 * own packages. The ONE list the bundler's aliases and the generated tsconfig `paths` come from.
 */
export const hostPins = (host: HostUiConfig): PinnedPackage[] => [...host.modulePins, ...SHELL_PINS]

/**
 * Object spread that refuses to override: a host entry silently shadowing a shell alias or a pin (or the
 * other way round) would point the bundler and the type checker somewhere nobody chose.
 */
export function mergeDistinct<T>(what: string, ...parts: Readonly<Record<string, T>>[]): Record<string, T> {
  const out: Record<string, T> = {}
  for (const part of parts) {
    for (const [key, value] of Object.entries(part)) {
      if (key in out) throw new Error(`host UI factory: ${what} "${key}" is set twice`)
      out[key] = value
    }
  }
  return out
}

/**
 * The type checker's twins of the aliases the quasar CLI gives every app (`src`, `components`,
 * `layouts`, `pages`, `boot`, `stores` → `src/...`), relative to the host's ui/.
 */
export const QUASAR_TS_PATHS: Readonly<Record<string, readonly string[]>> = {
  'src/*': ['./src/*'],
  'layouts/*': ['./src/layouts/*'],
  'pages/*': ['./src/pages/*'],
  'components/*': ['./src/components/*'],
  'boot/*': ['./src/boot/*'],
  'stores/*': ['./src/stores/*'],
}
