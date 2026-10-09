// GCY1.7: граф импортов точки входа — то, за чем следит наблюдатель. Два замка: разбор на подложенном
// дереве (что входит и что нет) и сверка с бандлером самого Bun на настоящем коде (каркас HostKitCore):
// если разбор разойдётся с тем, что Bun на самом деле грузит, наблюдатель молча перестанет видеть
// правку — а это ровно та болезнь `bun --watch`, ради которой он заведён (GCY1.1).

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { pathKey, resolveLocalImport, scanImportGraph } from "./import-graph"

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
    expect(resolveLocalImport("@protocol", from)).toBeNull()
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
