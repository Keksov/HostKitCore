// GCY1.7 (план gnauralcity, GCY-D30): граф импортов точки входа сервера — что наблюдатель
// (`dev-watch.ts`) считает «кодом сервера». Правка файла из графа перезапускает сервер; правка
// любого другого файла — нет.
//
// Почему граф, а не список каталогов. Сервер MindWave тянет код пяти репозиториев, и не только их
// `server/`: `GnauralCore/ui/composables/*` (модель дорожки, XML, правила имени проекта) и
// `GnauralCore/ui/project-api.ts` исполняются и на сервере. Список каталогов, написанный руками,
// стареет молча (ровно так стареет папка в команде verify — F-0065), а целый `GnauralCore/ui` в
// списке перезапускал бы сервер — и глушил бы звук — на каждой правке компонента. Граф выводится
// из самих импортов при каждом (пере)запуске, как у `bun --watch`, только без его ограничения
// «под cwd» (GCY1.1).
//
// Разбор — `Bun.Transpiler.scanImports`: он видит статические `import`/`export … from`, `import()`
// с литералом и `require`; импорты только типов (`import type`, `{ type X }`) он не возвращает —
// их нет и в исполнении. Разрешаются относительные и абсолютные спецификаторы — своим
// кодом, без кэша резолвера Bun (наблюдатель живёт часами, а файлы появляются). Пакеты
// (`node_modules`), встроенные модули (`node:`, `bun:`) и интерфейсные алиасы (`@hostkit`, `@panel` — их
// нет в исполнении сервера) в граф не входят: это не код хоста.
//
// GCY4.1 (GCY-D14): ИМЕНА ПАКЕТОВ МОДУЛЕЙ ЧЕРЕЗ `paths` TSCONFIG. Хост берёт компонент по имени
// (`@gnauralcore/server`), а Bun разрешает такое имя по `compilerOptions.paths` БЛИЖАЙШЕГО к
// импортирующему файлу tsconfig.json (замер на Bun 1.3.13: от cwd не зависит; без tsconfig имя не
// разрешается; в `extends` он местами расходится с TypeScript — см. `resolveTsconfig`). Без этого разбора граф
// `MindWaveCore/server/server.ts` потерял бы 53 файла GnauralCore из 81 — правка компонента молча
// перестала бы перезапускать сервер. Поэтому голый спецификатор сверяется с ключами `paths` ближайшего
// tsconfig, и совпавший разрешается ТЕМ ЖЕ правилом, что у Bun (`resolvePathsImport`); попавшее в
// `node_modules` отбрасывается (пин `fast-xml-parser` в paths хоста — пакет, не код). Своим кодом, а
// не `Bun.resolveSync`: тот держит tsconfig каталога закэшированным на всю жизнь процесса (замер:
// правка `paths` и новый ключ после первого вызова не видны), а наблюдатель живёт часами. Что правило
// совпадает с Bun, сверяет `import-graph.test.ts` на свежих каталогах, где кэша ещё нет.
// Сам tsconfig, к которому обратился такой спецификатор, входит в граф листом: Bun читает его при старте,
// и правка `paths` меняет то, что исполняет сервер, — значит, перезапускает его, как правка кода.

import { readFileSync, statSync } from "node:fs"
import { dirname, extname, isAbsolute, join, resolve } from "node:path"

const RESOLVE_EXTENSIONS = [".tsx", ".jsx", ".ts", ".mts", ".mjs", ".js", ".cjs", ".json"]

const isFile = (aPath: string): boolean => {
  try {
    return statSync(aPath).isFile()
  } catch {
    return false
  }
}

/** Ключ пути для сравнения: на Windows регистр не различается. */
export const pathKey = (aPath: string): string => {
  const absolute = resolve(aPath)
  return process.platform === "win32" ? absolute.toLowerCase() : absolute
}

const isInNodeModules = (aPath: string): boolean => {
  return aPath.split(/[\\/]/u).some((aSegment) => aSegment.toLowerCase() === "node_modules")
}

/** Файл, в который Bun разрешит относительный/абсолютный спецификатор; `null` — не наш или нет файла. */
export const resolveLocalImport = (aSpecifier: string, aFromDir: string): string | null => {
  const isLocal = aSpecifier === "." || aSpecifier === ".." || aSpecifier.startsWith("./") || aSpecifier.startsWith("../")
    || isAbsolute(aSpecifier)
  if (!isLocal) {
    return null
  }

  const base = resolve(aFromDir, aSpecifier)
  const candidates = [base, ...RESOLVE_EXTENSIONS.map((aExtension) => `${base}${aExtension}`)]
  // TS/ESM-обычай: импорт пишет `.js`, а лежит `.ts`.
  if (/\.[cm]?js$/u.test(base)) {
    candidates.push(base.replace(/\.([cm]?)js$/u, ".$1ts"), base.replace(/\.js$/u, ".tsx"))
  }
  candidates.push(...RESOLVE_EXTENSIONS.map((aExtension) => join(base, `index${aExtension}`)))

  return candidates.find(isFile) ?? null
}

// --- имена через `paths` tsconfig (GCY4.1) -------------------------------------------------------

type PathsTable = Readonly<Record<string, readonly string[]>>

export interface ResolvedTsconfig {
  /** Файлы цепочки: ближайший tsconfig.json и те, что он расширяет (`extends`). */
  readonly files: readonly string[]
  /** `null` — `paths` в цепочке нет (или конфиг не разобрался). */
  readonly paths: PathsTable | null
  /** От чего считаются цели действующих `paths`: `baseUrl` их же конфига, иначе каталог этого конфига. */
  readonly pathsBase: string
}

/** Кэш одного разбора графа: tsconfig по каталогу и разобранные конфиги. Между разборами не живёт. */
export interface TsconfigCache {
  readonly nearest: Map<string, string | null>
  readonly resolved: Map<string, ResolvedTsconfig>
}

export const createTsconfigCache = (): TsconfigCache => ({ nearest: new Map(), resolved: new Map() })

/** Ближайший к каталогу tsconfig.json (сам каталог, затем родители) — тот, что читает Bun. */
export const nearestTsconfig = (aDir: string, aCache: TsconfigCache = createTsconfigCache()): string | null => {
  const visited: string[] = []
  let dir = resolve(aDir)
  let found: string | null = null
  for (;;) {
    const key = pathKey(dir)
    const cached = aCache.nearest.get(key)
    if (cached !== undefined) {
      found = cached
      break
    }
    visited.push(key)
    const candidate = join(dir, "tsconfig.json")
    if (isFile(candidate)) {
      found = candidate
      break
    }
    const parent = dirname(dir)
    if (parent === dir) {
      break
    }
    dir = parent
  }
  for (const key of visited) {
    aCache.nearest.set(key, found)
  }
  return found
}

type JsonObject = Record<string, unknown>

const isJsonObject = (aValue: unknown): aValue is JsonObject => typeof aValue === "object" && aValue !== null && !Array.isArray(aValue)

/**
 * Цель `extends` — так, как её берёт Bun 1.3.13 (замер GCY4.1, свежие каталоги): только строка-путь,
 * ровно как написана. В отличие от TypeScript Bun НЕ дописывает `.json` и НЕ понимает массив `extends`
 * — такой конфиг имени у него не даёт, значит, и в графе не должен. Пакет-конфиг (`@tsconfig/…`) не
 * разрешаем: у хостов его нет.
 */
const extendsTarget = (aConfig: JsonObject, aConfigDir: string): string | null => {
  const raw = aConfig.extends
  if (typeof raw !== "string" || !(raw.startsWith("./") || raw.startsWith("../") || isAbsolute(raw))) {
    return null
  }
  const target = resolve(aConfigDir, raw)
  return isFile(target) ? target : null
}

/**
 * Цепочка конфига по правилу Bun 1.3.13 (замер GCY4.1): свои `paths` заменяют унаследованные целиком, и
 * их цели считаются от `baseUrl` ТОГО ЖЕ конфига, иначе от его каталога. Чужой `baseUrl` на них не
 * действует — ни родительский на `paths` потомка, ни потомка на унаследованные `paths` (TypeScript
 * тут думает иначе; исполняет сервер Bun).
 */
const resolveTsconfig = (aFile: string, aCache: TsconfigCache, aDepth = 0): ResolvedTsconfig => {
  const key = pathKey(aFile)
  const cached = aCache.resolved.get(key)
  if (cached !== undefined) {
    return cached
  }

  const configDir = dirname(aFile)
  let result: ResolvedTsconfig = { files: [aFile], paths: null, pathsBase: configDir }
  try {
    const parsed: unknown = Bun.JSONC.parse(readFileSync(aFile, "utf8"))
    if (isJsonObject(parsed)) {
      const files: string[] = [aFile]
      let paths: PathsTable | null = null
      let pathsBase = configDir
      const parent = aDepth < 16 ? extendsTarget(parsed, configDir) : null
      if (parent !== null) {
        const inherited = resolveTsconfig(parent, aCache, aDepth + 1)
        files.push(...inherited.files)
        paths = inherited.paths
        pathsBase = inherited.pathsBase
      }
      const options = parsed.compilerOptions
      if (isJsonObject(options) && isJsonObject(options.paths)) {
        const own: Record<string, readonly string[]> = {}
        for (const [pattern, targets] of Object.entries(options.paths)) {
          if (Array.isArray(targets)) {
            own[pattern] = targets.filter((aTarget): aTarget is string => typeof aTarget === "string")
          }
        }
        paths = own
        pathsBase = typeof options.baseUrl === "string" ? resolve(configDir, options.baseUrl) : configDir
      }
      result = { files, paths, pathsBase }
    }
  } catch {
    // Не читается или не разбирается (правка посреди записи): `paths` нет, сам файл — в графе листом,
    // его следующая правка и есть та, что надо подхватить.
  }
  aCache.resolved.set(key, result)
  return result
}

/** Шаблон `paths`, который ловит спецификатор, и подстановка `*`; точный ключ сильнее, затем — длиннейший префикс. */
const matchPathsPattern = (aSpecifier: string, aPaths: PathsTable): { pattern: string; star: string } | null => {
  if (Object.hasOwn(aPaths, aSpecifier) && !aSpecifier.includes("*")) {
    return { pattern: aSpecifier, star: "" }
  }
  let best: { pattern: string; star: string } | null = null
  let bestPrefix = -1
  for (const pattern of Object.keys(aPaths)) {
    const starAt = pattern.indexOf("*")
    if (starAt < 0 || pattern.indexOf("*", starAt + 1) >= 0) {
      continue
    }
    const prefix = pattern.slice(0, starAt)
    const suffix = pattern.slice(starAt + 1)
    if (aSpecifier.length >= prefix.length + suffix.length && aSpecifier.startsWith(prefix) && aSpecifier.endsWith(suffix)
      && prefix.length > bestPrefix) {
      best = { pattern, star: aSpecifier.slice(prefix.length, aSpecifier.length - suffix.length) }
      bestPrefix = prefix.length
    }
  }
  return best
}

const isBuiltinSpecifier = (aSpecifier: string): boolean => /^(?:node|bun):/u.test(aSpecifier)

/**
 * Голый спецификатор через `paths` ближайшего к `aFromDir` tsconfig — по правилу Bun (см. шапку).
 * `file` — файл кода (`null`: ни один ключ не совпал, цели нет или она в `node_modules`); `tsconfigs` —
 * цепочка конфига, к которому обратился спецификатор (пусто — tsconfig нет или спецификатор не голый).
 */
export const resolvePathsImport = (
  aSpecifier: string,
  aFromDir: string,
  aCache: TsconfigCache = createTsconfigCache(),
): { readonly file: string | null; readonly tsconfigs: readonly string[] } => {
  const none = { file: null, tsconfigs: [] as string[] }
  if (aSpecifier.startsWith(".") || isAbsolute(aSpecifier) || isBuiltinSpecifier(aSpecifier)) {
    return none
  }
  const nearest = nearestTsconfig(aFromDir, aCache)
  if (nearest === null) {
    return none
  }
  const config = resolveTsconfig(nearest, aCache)
  const match = config.paths === null ? null : matchPathsPattern(aSpecifier, config.paths)
  if (config.paths === null || match === null) {
    return { file: null, tsconfigs: config.files }
  }
  for (const target of config.paths[match.pattern] ?? []) {
    const absolute = resolve(config.pathsBase, target.replace("*", match.star))
    const file = resolveLocalImport(absolute, aFromDir)
    if (file !== null) {
      return { file: isInNodeModules(file) ? null : file, tsconfigs: config.files }
    }
  }
  return { file: null, tsconfigs: config.files }
}

const loaderOf = (aPath: string): "ts" | "tsx" | "js" | "jsx" | null => {
  switch (extname(aPath).toLowerCase()) {
    case ".ts":
    case ".mts":
    case ".cts":
      return "ts"
    case ".tsx":
      return "tsx"
    case ".js":
    case ".mjs":
    case ".cjs":
      return "js"
    case ".jsx":
      return "jsx"
    default:
      return null
  }
}

const transpilers = new Map<string, InstanceType<typeof Bun.Transpiler>>()

/** Спецификаторы импортов файла (без импортов только типов). */
export const scanSpecifiers = (aPath: string, aSource: string): string[] => {
  const loader = loaderOf(aPath)
  if (loader === null) {
    return []
  }

  let transpiler = transpilers.get(loader)
  if (transpiler === undefined) {
    transpiler = new Bun.Transpiler({ loader })
    transpilers.set(loader, transpiler)
  }

  return transpiler.scanImports(aSource).map((aImport) => aImport.path)
}

/**
 * Все файлы, достижимые из `aEntry` по локальным импортам и по именам из `paths` tsconfig (вместе с ним
 * самим и с tsconfig, к которым обращались голые спецификаторы), — абсолютные пути.
 * Файл, который не читается или не разбирается (синтаксическая ошибка посреди правки), остаётся в
 * графе листом: его следующая правка и есть та, что надо подхватить.
 */
export const scanImportGraph = (aEntry: string): string[] => {
  const seen = new Set<string>()
  const files: string[] = []
  const queue = [resolve(aEntry)]
  // Свежий на каждый разбор: наблюдатель живёт часами, и tsconfig между перезапусками может смениться.
  const tsconfigCache = createTsconfigCache()
  const enqueue = (aFile: string): void => {
    if (!isInNodeModules(aFile) && !seen.has(pathKey(aFile))) {
      queue.push(aFile)
    }
  }

  while (queue.length > 0) {
    const file = queue.pop() as string
    const key = pathKey(file)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    files.push(file)

    let specifiers: string[]
    try {
      specifiers = scanSpecifiers(file, readFileSync(file, "utf8"))
    } catch {
      continue
    }

    for (const specifier of specifiers) {
      const local = resolveLocalImport(specifier, dirname(file))
      if (local !== null) {
        enqueue(local)
        continue
      }
      const named = resolvePathsImport(specifier, dirname(file), tsconfigCache)
      for (const tsconfig of named.tsconfigs) {
        enqueue(tsconfig)
      }
      if (named.file !== null) {
        enqueue(named.file)
      }
    }
  }

  return files
}
