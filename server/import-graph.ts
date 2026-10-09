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
// их нет и в исполнении. Разрешаются только относительные и абсолютные спецификаторы — своим
// кодом, без кэша резолвера Bun (наблюдатель живёт часами, а файлы появляются). Пакеты
// (`node_modules`), встроенные модули (`node:`, `bun:`) и алиасы (`@protocol` — у сервера только
// типы) в граф не входят: это не код хоста.

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
 * Все файлы, достижимые из `aEntry` по локальным импортам (вместе с ним самим), — абсолютные пути.
 * Файл, который не читается или не разбирается (синтаксическая ошибка посреди правки), остаётся в
 * графе листом: его следующая правка и есть та, что надо подхватить.
 */
export const scanImportGraph = (aEntry: string): string[] => {
  const seen = new Set<string>()
  const files: string[] = []
  const queue = [resolve(aEntry)]

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
      const resolved = resolveLocalImport(specifier, dirname(file))
      if (resolved !== null && !isInNodeModules(resolved) && !seen.has(pathKey(resolved))) {
        queue.push(resolved)
      }
    }
  }

  return files
}
