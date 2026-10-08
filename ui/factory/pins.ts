// gnauralcity GCY1.6 (GCY-D17): the ONE place of truth for the packages a host bundles and type-checks
// as ONE copy, and the two derivations of it — the bundler's aliases and the type checker's `paths`.
//
// Why a pin at all. Module trees (GnauralCore/ui, HostKitCore/ui) carry their own node_modules so that
// their own `bun test` can boot vue, quasar & co. Vite and TypeScript resolve a bare import from the
// IMPORTING file, so without a pin a module's component would bundle — and be type-checked against —
// that second copy: two reactivity systems in one app, singletons that stop being single (TE4.8). A
// third-party library of a module (codemirror, echarts) is pinned for the same reason and, besides,
// because the module tree has no copy of it at all: the host installs it.
//
// Why both derivations live here, side by side. Until GCY1.6 the pin was typed twice by hand
// (quasar.config.ts and tsconfig.json of the host) and nothing compared the two. Now the host passes
// ONE list to the factory, and the factory produces both places from it: the aliases at build time
// (`quasar-config.ts`), the `paths` into the host's generated `tsconfig.hostkit.json`
// (`host-tsconfig.ts`; the workspace's validate-qa.js reddens when that file is stale).

/** A package (or every package of an npm scope) the host bundles and type-checks from ITS node_modules. */
export type PinnedPackage = PinnedScope | PinnedName

/** Every package of an npm scope, deep imports included: `@codemirror/view`, `@codemirror/state`, … */
export interface PinnedScope {
  /** The scope with its `@`, e.g. '@codemirror'. */
  readonly scope: string
}

export interface PinnedName {
  /** The package name, e.g. 'vue'. */
  readonly name: string
  /**
   * The file the BUNDLER gets for the bare import, relative to the package directory — the build the
   * app ships (vue's runtime-only esm-bundler build, quasar's client build). Absent: the package
   * directory itself, resolved by its package.json. The type checker always gets the package directory
   * (its types come from package.json).
   */
  readonly entry?: string
  /**
   * Deep imports `<name>/…` pinned too — in the bundler and the type checker ('bundle-and-types') or in
   * the type checker only ('types'). Absent: the bare import only. These are the values the pin had in
   * the two hand-typed places when it moved here (GCY1.6 moved it without changing behaviour, GCY-D12):
   * deep imports of the shell's packages were pinned for types everywhere, for the bundler only for
   * quasar (`quasar/wrappers` in the host's boot files, `quasar/icon-set/…` in quasar's generated
   * entry). The deep vue imports of today (`vue/compiler-sfc`, `vue/server-renderer`) are in tests.
   */
  readonly deep?: 'bundle-and-types' | 'types'
}

/**
 * The shell's own packages (GCY-D17: vue, pinia, vue-i18n, vue-router, quasar): every host bundles the
 * shell and its modules against one copy of each. Third-party libraries of MODULES are not listed
 * here — HostKitCore knows no module; the host passes them (`HostUiConfig.modulePins`).
 */
export const SHELL_PINS: readonly PinnedName[] = [
  { name: 'vue', entry: 'dist/vue.runtime.esm-bundler.js', deep: 'types' },
  { name: 'pinia', entry: 'dist/pinia.mjs', deep: 'types' },
  { name: 'vue-i18n', entry: 'dist/vue-i18n.mjs', deep: 'types' },
  { name: 'vue-router', entry: 'dist/vue-router.mjs', deep: 'types' },
  { name: 'quasar', entry: 'dist/quasar.client.js', deep: 'bundle-and-types' },
]

/** One Vite alias entry in the array form (`resolve.alias`). */
export interface ViteAliasEntry {
  readonly find: string | RegExp
  readonly replacement: string
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/** Forward slashes: Vite compares and rewrites ids in that form. */
export const toVitePath = (pathValue: string): string => pathValue.replace(/\\/g, '/')

/**
 * The bundler's half of the pin: anchored aliases into `nodeModulesDir` (absolute, the host's
 * node_modules), in the order of `pins`. Anchored — `^vue$`, not 'vue' — so that `vue-router` or
 * `@vue/…` never match the alias of `vue`.
 */
export function pinnedViteAliases(pins: readonly PinnedPackage[], nodeModulesDir: string): ViteAliasEntry[] {
  const root = toVitePath(nodeModulesDir)
  const out: ViteAliasEntry[] = []
  for (const pin of pins) {
    if ('scope' in pin) {
      out.push({ find: new RegExp(`^${escapeRegExp(pin.scope)}\\/(.*)$`), replacement: `${root}/${pin.scope}/$1` })
      continue
    }
    out.push({
      find: new RegExp(`^${escapeRegExp(pin.name)}$`),
      replacement: pin.entry === undefined ? `${root}/${pin.name}` : `${root}/${pin.name}/${pin.entry}`,
    })
    if (pin.deep === 'bundle-and-types') {
      out.push({ find: new RegExp(`^${escapeRegExp(pin.name)}\\/(.*)$`), replacement: `${root}/${pin.name}/$1` })
    }
  }
  return out
}

/**
 * The type checker's half of the pin: tsconfig `paths` entries into `nodeModulesRel` — relative to the
 * tsconfig that will hold them (the host's generated file sits in the host's ui/, so './node_modules').
 */
export function pinnedTsPaths(pins: readonly PinnedPackage[], nodeModulesRel: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const pin of pins) {
    if ('scope' in pin) {
      out[`${pin.scope}/*`] = [`${nodeModulesRel}/${pin.scope}/*`]
      continue
    }
    out[pin.name] = [`${nodeModulesRel}/${pin.name}`]
    if (pin.deep !== undefined) out[`${pin.name}/*`] = [`${nodeModulesRel}/${pin.name}/*`]
  }
  return out
}

/** The package or scope a pin names — what both halves must agree on. */
export const pinLabel = (pin: PinnedPackage): string => ('scope' in pin ? `${pin.scope}/*` : pin.name)
