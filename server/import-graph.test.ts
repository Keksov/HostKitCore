// GCY1.7: граф импортов точки входа — то, за чем следит наблюдатель. Два замка: разбор на подложенном
// дереве (что входит и что нет) и сверка с бандлером самого Bun на настоящем коде (каркас HostKitCore):
// если разбор разойдётся с тем, что Bun на самом деле грузит, наблюдатель молча перестанет видеть
// правку — а это ровно та болезнь `bun --watch`, ради которой он заведён (GCY1.1).

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import {
  createTsconfigCache,
  nearestTsconfig,
  pathKey,
  resolveLocalImport,
  resolvePathsImport,
  scanImportGraph,
} from "./import-graph"

describe("import-graph.ts", () => {
  let root = ""

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "hostkit-graph-"))
    const files: Record<string, string> = {
      "host/server/entry.ts": [
        "import { a } from \"./a\"",
        "import type { T } from \"./types-only\"",
        "import { type U } from \"./types-only-2\"",
        "import { b } from \"../../mod/server/b.js\"",
        "import { readFileSync } from \"node:fs\"",
        "import pkg from \"pkg\"",
        "import \"./side-effect\"",
        "export { c } from \"./dir\"",
        "const lazy = () => import(\"./lazy\")",
        "export const x = [a, b, readFileSync, pkg, lazy]",
      ].join("\n"),
      "host/server/a.ts": "import { x } from \"./entry\"\nexport const a = () => x\n",
      "host/server/types-only.ts": "export type T = number\n",
      "host/server/types-only-2.ts": "export type U = number\n",
      "host/server/side-effect.ts": "console.log(1)\n",
      "host/server/dir/index.ts": "export const c = 1\n",
      "host/server/lazy.ts": "export const lazy = 1\n",
      "host/server/broken.ts": "import { \n",
      "host/server/not-imported.ts": "export const n = 1\n",
      "mod/server/b.ts": "import { shared } from \"../ui/composables/shared\"\nexport const b = shared\n",
      "mod/ui/composables/shared.ts": "export const shared = 1\n",
      "host/server/node_modules/pkg/index.js": "module.exports = 1\n",
      "host/server/node_modules/pkg/package.json": "{\"name\":\"pkg\",\"main\":\"index.js\"}\n",
    }
    for (const [path, content] of Object.entries(files)) {
      const full = join(root, path)
      await mkdir(resolve(full, ".."), { recursive: true })
      await writeFile(full, content)
    }
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const rel = (aFiles: readonly string[]): string[] =>
    aFiles.map((aFile) => aFile.slice(root.length + 1).replaceAll("\\", "/")).sort()

  test("локальные импорты по цепочке, через репо и index; без типов, пакетов и встроенных", () => {
    expect(rel(scanImportGraph(join(root, "host/server/entry.ts")))).toEqual([
      "host/server/a.ts",
      "host/server/dir/index.ts",
      "host/server/entry.ts",
      "host/server/lazy.ts",
      "host/server/side-effect.ts",
      "mod/server/b.ts",
      "mod/ui/composables/shared.ts",
    ])
  })

  test("неразбираемый файл — лист графа, а не падение", () => {
    expect(rel(scanImportGraph(join(root, "host/server/broken.ts")))).toEqual(["host/server/broken.ts"])
  })

  test("разрешение: пакеты и встроенные — не наше; .js → .ts; каталог → index", () => {
    const from = join(root, "host/server")
    expect(resolveLocalImport("pkg", from)).toBeNull()
    expect(resolveLocalImport("node:fs", from)).toBeNull()
    expect(resolveLocalImport("@hostkit/ws/ws", from)).toBeNull()
    expect(resolveLocalImport("./missing", from)).toBeNull()
    expect(rel([resolveLocalImport("../../mod/server/b.js", from) as string])).toEqual(["mod/server/b.ts"])
    expect(rel([resolveLocalImport("./dir", from) as string])).toEqual(["host/server/dir/index.ts"])
  })

  test("сверка с бандлером Bun на коде каркаса: те же файлы, что Bun грузит", async () => {
    const entry = join(import.meta.dir, "start.ts")
    const outdir = await mkdtemp(join(tmpdir(), "hostkit-graph-build-"))
    try {
      const built = await Bun.build({ entrypoints: [entry], target: "bun", packages: "external", metafile: true, outdir })
      expect(built.success).toBe(true)
      const inputs = Object.keys(built.metafile?.inputs ?? {}).map((aInput) => pathKey(resolve(process.cwd(), aInput))).sort()
      const scanned = scanImportGraph(entry).map(pathKey).sort()
      expect(inputs.length).toBeGreaterThan(3)
      expect(scanned).toEqual(inputs)
    } finally {
      await rm(outdir, { recursive: true, force: true })
    }
  })
})

// GCY4.1 (GCY-D14): хост берёт компонент по ИМЕНИ пакета, Bun разрешает имя по `paths` ближайшего
// tsconfig. Без этого разбора граф терял бы весь компонент (у MindWave — 53 файла из 81), и правка
// GnauralCore молча переставала бы перезапускать сервер. Здесь — правило на подложенном дереве и
// сверка его с самим Bun (`Bun.resolveSync` на свежих каталогах, где у резолвера Bun ещё нет кэша).
describe("import-graph.ts: имена через paths tsconfig (GCY4.1)", () => {
  let root = ""

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "hostkit-graph-paths-"))
    const files: Record<string, string> = {
      // Пустой node_modules над деревом: без него Bun на голом имени пошёл бы автоустанавливать пакет.
      "ws/node_modules/.keep": "",
      "ws/comp/server/index.ts": "import { inner } from \"./inner\"\nexport const x = inner\n",
      "ws/comp/server/inner.ts": "export const inner = 1\n",
      "ws/comp/server/deep.ts": "export const deep = 1\n",
      "ws/comp/server/testing.ts": "export { inner } from \"./inner\"\n",
      "ws/comp/ui/protocol/index.ts": "export type P = number\nexport const guard = 1\n",
      "ws/comp/ui/protocol/types-only.ts": "export type T = number\n",
      "ws/comp/wild/thing.ts": "export const w = 1\n",
      "ws/comp/wild/sp/x.ts": "export const wrong = 1\n",
      "ws/comp/wild-sp/x.ts": "export const right = 1\n",
      // Хост: JSONC с комментариями и висячими запятыми — как MindWaveCore/server/tsconfig.json.
      "ws/host/server/tsconfig.json": [
        "{",
        "  // имена модулей — точные ключи",
        "  \"compilerOptions\": {",
        "    \"paths\": {",
        "      \"@c/server\": [\"../../comp/server/index.ts\"],",
        "      \"@c/server/testing\": [\"../../comp/server/testing.ts\"],",
        "      \"@c/ui/protocol\": [\"../../comp/ui/protocol/index.ts\"],",
        "      \"@c/types\": [\"../../comp/ui/protocol/types-only.ts\"],",
        "      \"@w/*\": [\"../../comp/wild/*\"],",
        "      \"@w/sp/*\": [\"../../comp/wild-sp/*\"],",
        "      \"@multi\": [\"../../comp/missing.ts\", \"../../comp/server/inner.ts\"],",
        "      \"pinned\": [\"./node_modules/pinned\"],",
        "    },",
        "  },",
        "}",
      ].join("\n"),
      "ws/host/server/node_modules/pinned/index.js": "module.exports = 1\n",
      "ws/host/server/node_modules/pinned/package.json": "{\"name\":\"pinned\",\"main\":\"index.js\"}\n",
      "ws/host/server/entry.ts": [
        "import { x } from \"@c/server\"",
        "import { guard } from \"@c/ui/protocol\"",
        "import type { T } from \"@c/types\"",
        "import { w } from \"@w/thing\"",
        "import pinned from \"pinned\"",
        "import { readFileSync } from \"node:fs\"",
        "const lazy = () => import(\"@c/server/deep\")",
        "export const all = [x, guard, w, pinned, readFileSync, lazy]",
      ].join("\n"),
      // Без tsconfig — имя не разрешает и Bun.
      "ws/host2/server/entry.ts": "import { x } from \"@c/server\"\nexport const all = x\n",
      // `extends`: пути — от конфига, где записаны (как у TypeScript).
      "ws/base/tsconfig.base.json": "{ \"compilerOptions\": { \"paths\": { \"@c/server\": [\"../comp/server/index.ts\"] } } }\n",
      "ws/host3/server/tsconfig.json": "{ \"extends\": \"../../base/tsconfig.base.json\", \"compilerOptions\": { \"strict\": true } }\n",
      "ws/host3/server/entry.ts": "import { x } from \"@c/server\"\nexport const all = x\n",
      // `baseUrl` своего конфига: цели — от него.
      "ws/host4/server/tsconfig.json": "{ \"compilerOptions\": { \"baseUrl\": \"../..\", \"paths\": { \"@c/server\": [\"comp/server/index.ts\"] } } }\n",
      "ws/host4/server/entry.ts": "import { x } from \"@c/server\"\nexport const all = x\n",
      // Где Bun расходится с TypeScript (имени у Bun нет — не должно быть и в графе): `extends` без `.json`,
      // `extends` массивом, `paths` потомка при `baseUrl` родителя.
      "ws/base/baseurl-only.json": "{ \"compilerOptions\": { \"baseUrl\": \"..\" } }\n",
      "ws/host7/server/tsconfig.json": "{ \"extends\": \"../../base/tsconfig.base\" }\n",
      "ws/host8/server/tsconfig.json": "{ \"extends\": [\"../../base/tsconfig.base.json\"] }\n",
      "ws/host9/server/tsconfig.json": "{ \"extends\": \"../../base/baseurl-only.json\", \"compilerOptions\": { \"paths\": { \"@c/server\": [\"comp/server/index.ts\"] } } }\n",
      // Конфиг, который не разбирается (правка посреди записи): лист графа, не падение.
      "ws/host5/server/tsconfig.json": "{ \"compilerOptions\": { \"paths\": { \"@c/server\": [\n",
      "ws/host5/server/entry.ts": "import { x } from \"@c/server\"\nexport const all = x\n",
    }
    for (const [path, content] of Object.entries(files)) {
      const full = join(root, path)
      await mkdir(resolve(full, ".."), { recursive: true })
      await writeFile(full, content)
    }
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const rel = (aFiles: readonly string[]): string[] =>
    aFiles.map((aFile) => aFile.slice(root.length + 1).replaceAll("\\", "/")).sort()

  test("имя по paths ведёт в модуль и дальше по его импортам; пакет из node_modules, тип и чужой подпуть — нет", () => {
    expect(rel(scanImportGraph(join(root, "ws/host/server/entry.ts")))).toEqual([
      "ws/comp/server/index.ts",
      "ws/comp/server/inner.ts",
      "ws/comp/ui/protocol/index.ts",
      "ws/comp/wild/thing.ts",
      "ws/host/server/entry.ts",
      // tsconfig, к которому обратились голые имена: Bun читает его на старте — его правка тоже код.
      "ws/host/server/tsconfig.json",
    ])
  })

  test("без tsconfig имени нет — как у Bun; extends и baseUrl — по правилу Bun; битый конфиг — лист", () => {
    expect(rel(scanImportGraph(join(root, "ws/host2/server/entry.ts")))).toEqual(["ws/host2/server/entry.ts"])
    expect(rel(scanImportGraph(join(root, "ws/host3/server/entry.ts")))).toEqual([
      "ws/base/tsconfig.base.json",
      "ws/comp/server/index.ts",
      "ws/comp/server/inner.ts",
      "ws/host3/server/entry.ts",
      "ws/host3/server/tsconfig.json",
    ])
    expect(rel(scanImportGraph(join(root, "ws/host4/server/entry.ts")))).toEqual([
      "ws/comp/server/index.ts",
      "ws/comp/server/inner.ts",
      "ws/host4/server/entry.ts",
      "ws/host4/server/tsconfig.json",
    ])
    expect(rel(scanImportGraph(join(root, "ws/host5/server/entry.ts")))).toEqual([
      "ws/host5/server/entry.ts",
      "ws/host5/server/tsconfig.json",
    ])
  })

  test("правило совпадает с Bun.resolveSync (свежие каталоги — без его кэша)", () => {
    const bunFile = (aSpecifier: string, aFromDir: string): string | null => {
      try {
        const file = Bun.resolveSync(aSpecifier, aFromDir)
        return /[\\/]node_modules[\\/]/u.test(file) ? null : pathKey(file)
      } catch {
        return null
      }
    }
    const cases: readonly (readonly [string, string])[] = [
      ["@c/server", "ws/host/server"],
      ["@c/server/testing", "ws/host/server"],
      ["@c/ui/protocol", "ws/host/server"],
      ["@w/thing", "ws/host/server"],
      ["@c/server/deep", "ws/host/server"],
      ["pinned", "ws/host/server"],
      ["@c/server", "ws/host2/server"],
      ["@c/server", "ws/host3/server"],
      ["@c/server", "ws/host4/server"],
      ["@w/sp/x", "ws/host/server"],
      ["@multi", "ws/host/server"],
      ["@c/server", "ws/host7/server"],
      ["@c/server", "ws/host8/server"],
      ["@c/server", "ws/host9/server"],
    ]
    const ours = cases.map(([aSpecifier, aDir]) => {
      const file = resolvePathsImport(aSpecifier, join(root, aDir)).file
      return [aSpecifier, aDir, file === null ? null : pathKey(file)]
    })
    const bun = cases.map(([aSpecifier, aDir]) => [aSpecifier, aDir, bunFile(aSpecifier, join(root, aDir))])
    expect(ours).toEqual(bun)
    // И сверка не пуста: восемь случаев разрешаются в файл модуля (длиннейший префикс шаблона — в wild-sp).
    expect(ours.filter((aRow) => aRow[2] !== null).length).toBe(8)
    expect(rel([resolvePathsImport("@w/sp/x", join(root, "ws/host/server")).file as string])).toEqual(["ws/comp/wild-sp/x.ts"])
  })

  test("правка paths видна следующему разбору — кэша между разборами нет (наблюдатель живёт часами)", async () => {
    const dir = join(root, "ws/host6/server")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "entry.ts"), "import { x } from \"@c/server\"\nexport const all = x\n")
    const config = (aTarget: string) => `{ "compilerOptions": { "paths": { "@c/server": ["${aTarget}"] } } }\n`
    await writeFile(join(dir, "tsconfig.json"), config("../../comp/server/deep.ts"))
    expect(rel(scanImportGraph(join(dir, "entry.ts")))).toEqual([
      "ws/comp/server/deep.ts",
      "ws/host6/server/entry.ts",
      "ws/host6/server/tsconfig.json",
    ])
    await writeFile(join(dir, "tsconfig.json"), config("../../comp/server/index.ts"))
    expect(rel(scanImportGraph(join(dir, "entry.ts")))).toEqual([
      "ws/comp/server/index.ts",
      "ws/comp/server/inner.ts",
      "ws/host6/server/entry.ts",
      "ws/host6/server/tsconfig.json",
    ])
  })

  test("ближайший tsconfig — от каталога импортирующего файла вверх", () => {
    const cache = createTsconfigCache()
    expect(rel([nearestTsconfig(join(root, "ws/host/server"), cache) as string])).toEqual(["ws/host/server/tsconfig.json"])
    expect(nearestTsconfig(join(root, "ws/comp/server"), cache)).toBeNull()
  })
})
