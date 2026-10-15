// gnauralcity GCY4.1 (GCY-D14, GCY-D17): a host imports its modules BY PACKAGE NAME, and only through the
// entry points each module declares — the `exports` of the module's own package.json. The host lists the
// module folders (`HostUiConfig.modulePackages`); the factory reads their tables here and derives both
// halves from them, exactly as it derives the pin (`pins.ts`):
//
//   * the bundler's aliases — anchored (`^@gnauralcore/ui/widgets$`), one per entry, onto the entry file;
//   * the type checker's `paths` — one EXACT key per entry, no `*`.
//
// So a path the module did not declare resolves in neither: a deep import by name (`@gnauralcore/ui/
// stores/audio`) fails the type check and the build, instead of quietly working. Why not a prefix alias
// onto the folder: Vite's string alias matches `name` AND `name/…`, so the package root would also catch
// every deep path (and, aimed at index.ts, break the subpaths); a wildcard `paths` key would admit them too.
//
// The table is the module's, the list of modules the host's: nothing here names a module (GCY-D19). A host
// whose module adds an entry regenerates its tsconfig.hostkit.json — validate-qa.js reddens until it does.

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** One declared entry of a module package: the specifier a host writes, the file it lands on (absolute). */
export interface ModuleEntry {
  readonly specifier: string
  readonly file: string
}

const fail = (aDir: string, aWhat: string): never => {
  throw new Error(`host UI factory: module package ${join(aDir, 'package.json')}: ${aWhat} (GCY-D14)`)
}

/**
 * The entries of the module package in `aDir` (absolute): `name` + every key of `exports`, in its order.
 * Only the form our modules use is accepted — a string target `./…` per key `.` or `./…`, no `*`, no
 * conditions — and every target must exist: a typo in the table is refused here, loudly, rather than
 * becoming an alias that resolves nowhere.
 */
export function modulePackageEntries(aDir: string): ModuleEntry[] {
  const file = join(aDir, 'package.json')
  if (!existsSync(file)) fail(aDir, 'no package.json')
  let pkg: unknown
  try {
    pkg = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    return fail(aDir, `unparsable (${(error as Error).message})`)
  }
  const { name, exports } = (pkg ?? {}) as { name?: unknown; exports?: unknown }
  if (typeof name !== 'string' || name === '') fail(aDir, 'no "name"')
  if (typeof exports !== 'object' || exports === null || Array.isArray(exports)) fail(aDir, 'no "exports" table')
  const out: ModuleEntry[] = []
  for (const [key, target] of Object.entries(exports as Record<string, unknown>)) {
    if (key !== '.' && !key.startsWith('./')) fail(aDir, `export "${key}" is not "." or "./…"`)
    if (key.includes('*')) fail(aDir, `export "${key}" is a pattern — declare each entry`)
    if (typeof target !== 'string' || !target.startsWith('./')) fail(aDir, `export "${key}" is not a plain "./…" file`)
    const entryFile = resolve(aDir, target as string)
    if (!existsSync(entryFile)) fail(aDir, `export "${key}" names a missing file ${target as string}`)
    out.push({ specifier: key === '.' ? (name as string) : `${name as string}/${key.slice(2)}`, file: entryFile })
  }
  if (out.length === 0) fail(aDir, '"exports" is empty')
  return out
}

/** Every entry of the host's module packages, in the host's order; one name declared twice is refused. */
export function hostModuleEntries(aModulePackages: readonly string[]): ModuleEntry[] {
  const seen = new Set<string>()
  const out: ModuleEntry[] = []
  for (const dir of aModulePackages) {
    for (const entry of modulePackageEntries(dir)) {
      if (seen.has(entry.specifier)) throw new Error(`host UI factory: module entry "${entry.specifier}" is declared twice`)
      seen.add(entry.specifier)
      out.push(entry)
    }
  }
  return out
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/** The bundler's half: one anchored alias per entry, onto the entry file (forward slashes, as Vite ids). */
export const moduleViteAliases = (aEntries: readonly ModuleEntry[]): { find: RegExp; replacement: string }[] =>
  aEntries.map((entry) => ({ find: new RegExp(`^${escapeRegExp(entry.specifier)}$`), replacement: entry.file.replace(/\\/g, '/') }))
