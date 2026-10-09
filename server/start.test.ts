// GCY1.7: порядок fetch и ws-раздача каркаса, статика — без сокетов. `startHostServer` целиком
// (настоящий Bun.serve) здесь не поднимается: запрос к нему шёл бы через fetch на loopback, а этот
// набор идёт без NO_PROXY (шаг hostkit-tests; F-0012: Bun читает прокси один раз на старте). Его
// проверяет живой дым шага; здесь — всё, из чего он собран.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { createHostFetch, createHostWebSocket, UI_WS_TOPIC, type HostServerInstance, type HostServerModule, type HostSocket } from "./start"
import { createStaticHandler } from "./static"

interface FakeServerLog {
  readonly upgrades: unknown[]
}

const fakeServer = (aUpgradeOk = true): { server: HostServerInstance; log: FakeServerLog } => {
  const log: FakeServerLog = { upgrades: [] }
  const server = {
    upgrade: (_aRequest: Request, aOptions: { data: unknown }) => {
      log.upgrades.push(aOptions.data)
      return aUpgradeOk
    },
    requestIP: () => ({ address: "127.0.0.1", family: "IPv4", port: 50000 }),
  } as unknown as HostServerInstance
  return { server, log }
}

const request = (aPath: string): Request => new Request(`http://127.0.0.1:3391${aPath}`)

describe("createHostFetch — порядок", () => {
  test("/ws/ui: upgrade с данными сокета { kind, clientIp }; отказ upgrade — 400 текстом", async () => {
    const calls: string[] = []
    const fetch = createHostFetch({
      admin: { handleRequest: async () => { calls.push("admin"); return null } },
      modules: [{ name: "m", fetch: () => { calls.push("m"); return null } }],
      serveStatic: async () => { calls.push("static"); return new Response("s") },
    })

    const ok = fakeServer()
    expect(await fetch(request("/ws/ui"), ok.server)).toBeUndefined()
    expect(ok.log.upgrades).toEqual([{ kind: "ui", clientIp: "127.0.0.1" }])

    const failed = await fetch(request("/ws/ui"), fakeServer(false).server)
    expect(failed?.status).toBe(400)
    expect(await failed?.text()).toBe("WebSocket upgrade failed")
    expect(calls).toEqual([])
  })

  test("админ-ручки раньше модулей; модули по порядку до первого ответа; затем статика", async () => {
    const calls: string[] = []
    const modules: HostServerModule[] = [
      { name: "a", fetch: (aRequest) => { calls.push("a"); return new URL(aRequest.url).pathname === "/api/a" ? new Response("A") : null } },
      { name: "no-http" },
      { name: "b", fetch: async (aRequest) => { calls.push("b"); return new URL(aRequest.url).pathname.startsWith("/api") ? new Response("B") : null } },
    ]
    const fetch = createHostFetch({
      admin: {
        handleRequest: async (aRequest) => {
          calls.push("admin")
          return new URL(aRequest.url).pathname === "/api/admin/bun-actions" ? new Response("ADMIN") : null
        },
      },
      modules,
      serveStatic: async (aPathname) => {
        calls.push(`static ${aPathname}`)
        return new Response("S")
      },
    })
    const { server } = fakeServer()

    const run = async (aPath: string): Promise<[string, string[]]> => {
      calls.length = 0
      const response = await fetch(request(aPath), server)
      return [await (response as Response).text(), [...calls]]
    }

    expect(await run("/api/admin/bun-actions")).toEqual(["ADMIN", ["admin"]])
    expect(await run("/api/a")).toEqual(["A", ["admin", "a"]])
    expect(await run("/api/other")).toEqual(["B", ["admin", "a", "b"]])
    expect(await run("/index.html")).toEqual(["S", ["admin", "a", "b", "static /index.html"]])
  })
})

describe("createHostWebSocket", () => {
  const socket = (aLog: string[]): HostSocket =>
    ({ data: { kind: "ui", clientIp: "127.0.0.1" }, subscribe: (aTopic: string) => aLog.push(`subscribe ${aTopic}`) }) as unknown as HostSocket

  test("open: подписка на тему оболочки, затем модули по порядку; close — по порядку", () => {
    const log: string[] = []
    const handler = createHostWebSocket([
      { name: "a", ws: { open: () => log.push("open a"), close: () => log.push("close a") } },
      { name: "b", ws: { open: () => log.push("open b"), close: () => log.push("close b") } },
      { name: "c" },
    ])
    const ws = socket(log)
    handler.open?.(ws)
    handler.close?.(ws, 1000, "")
    expect(log).toEqual([`subscribe ${UI_WS_TOPIC}`, "open a", "open b", "close a", "close b"])
    expect(UI_WS_TOPIC).toBe("ui")
  })

  test("message: строка и Buffer доходят текстом до КАЖДОГО модуля; ждём всех", async () => {
    const seen: string[] = []
    let release: () => void = () => undefined
    const slow = new Promise<void>((aResolve) => {
      release = aResolve
    })
    const handler = createHostWebSocket([
      { name: "slow", ws: { message: async (_aSocket, aText) => { seen.push(`slow ${aText}`); await slow } } },
      { name: "fast", ws: { message: (_aSocket, aText) => { seen.push(`fast ${aText}`) } } },
    ])
    const ws = socket([])

    let done = false
    const pending = Promise.resolve(handler.message(ws, Buffer.from("{\"type\":\"ui_echo\"}", "utf8") as Buffer<ArrayBuffer>)).then(() => {
      done = true
    })
    await Promise.resolve()
    // Второй модуль не ждёт первого, но обработчик сокета ждёт обоих.
    expect(seen).toEqual(["slow {\"type\":\"ui_echo\"}", "fast {\"type\":\"ui_echo\"}"])
    expect(done).toBe(false)
    release()
    await pending
    expect(done).toBe(true)

    seen.length = 0
    await handler.message(ws, "plain")
    expect(seen).toEqual(["slow plain", "fast plain"])
  })
})

describe("static.ts", () => {
  let root = ""
  let publicDir = ""

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "hostkit-static-"))
    publicDir = join(root, "public")
    await mkdir(join(publicDir, "assets"), { recursive: true })
    await writeFile(join(publicDir, "index.html"), "<html>i</html>")
    await writeFile(join(publicDir, "assets", "app.css"), "a{}")
    await writeFile(join(publicDir, "assets", "font.woff2"), "w")
    await writeFile(join(root, "secret.txt"), "s")
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test("/ → index.html; типы по расширению; no-store", async () => {
    const serveStatic = createStaticHandler(publicDir)
    const index = await serveStatic("/")
    expect(index.status).toBe(200)
    expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8")
    expect(index.headers.get("cache-control")).toBe("no-store")
    expect(await index.text()).toBe("<html>i</html>")
    expect((await serveStatic("/assets/app.css")).headers.get("content-type")).toBe("text/css; charset=utf-8")
    expect((await serveStatic("/assets/font.woff2")).headers.get("content-type")).toBe("application/octet-stream")
  })

  test("выход за каталог — 403, нет файла — 404 (текстом; SPA-фолбэка нет)", async () => {
    const serveStatic = createStaticHandler(publicDir)
    const outside = await serveStatic("/../secret.txt")
    expect([outside.status, await outside.text()]).toEqual([403, "Forbidden"])
    const missing = await serveStatic("/settings")
    expect([missing.status, await missing.text()]).toEqual([404, "Not found"])
  })
})
