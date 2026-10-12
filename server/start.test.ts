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
    // Произвольное сообщение модуля (не эхо оболочки — его каркас модулям не отдаёт, тест ниже).
    const pending = Promise.resolve(handler.message(ws, Buffer.from("{\"type\":\"m_ping\"}", "utf8") as Buffer<ArrayBuffer>)).then(() => {
      done = true
    })
    await Promise.resolve()
    // Второй модуль не ждёт первого, но обработчик сокета ждёт обоих.
    expect(seen).toEqual(["slow {\"type\":\"m_ping\"}", "fast {\"type\":\"m_ping\"}"])
    expect(done).toBe(false)
    release()
    await pending
    expect(done).toBe(true)

    seen.length = 0
    await handler.message(ws, "plain")
    expect(seen).toEqual(["slow plain", "fast plain"])
  })

  // GCY2.2 (GCY-D23): эхо живости оболочки — забота каркаса. Без этого у хоста без модулей
  // (Gnauralcity) эхо оставалось без ответа, и часы живости клиента через ~4,9 с рвали сокет.
  describe("эхо живости оболочки (ui_echo)", () => {
    interface EchoSocketLog {
      readonly sent: string[]
      readonly published: string[]
    }
    const echoSocket = (aLog: EchoSocketLog): HostSocket =>
      ({
        data: { kind: "ui", clientIp: "127.0.0.1" },
        send: (aText: string) => { aLog.sent.push(aText) },
        publish: (aTopic: string, aText: string) => { aLog.published.push(`${aTopic} ${aText}`) },
      }) as unknown as HostSocket

    const run = async (aMessage: string | Buffer<ArrayBuffer>, aModules = 2): Promise<{ log: EchoSocketLog; seen: string[] }> => {
      const seen: string[] = []
      const modules: HostServerModule[] = Array.from({ length: aModules }, (_aUnused, aIndex) => ({
        name: `m${aIndex}`,
        ws: { message: (_aSocket: HostSocket, aText: string) => { seen.push(`m${aIndex} ${aText}`) } },
      }))
      const log: EchoSocketLog = { sent: [], published: [] }
      await createHostWebSocket(modules).message(echoSocket(log), aMessage)
      return { log, seen }
    }

    test("годное эхо: ответ ТОМУ ЖЕ сокету, побайтно {type, requestId}; модули его не получают; publish нет", async () => {
      const echo = "{\"type\":\"ui_echo\",\"requestId\":\"lc-7-a1b2c3\"}"
      for (const message of [echo, Buffer.from(echo, "utf8") as Buffer<ArrayBuffer>]) {
        const { log, seen } = await run(message)
        expect(log.sent).toEqual(["{\"type\":\"ui_echo_ack\",\"requestId\":\"lc-7-a1b2c3\"}"])
        expect(log.published).toEqual([])
        expect(seen).toEqual([])
      }
    })

    test("хост без модулей (Gnauralcity) эхо тоже отвечает", async () => {
      const { log } = await run("{\"type\":\"ui_echo\",\"requestId\":\"x\"}", 0)
      expect(log.sent).toEqual(["{\"type\":\"ui_echo_ack\",\"requestId\":\"x\"}"])
    })

    test("лишние поля эха не мешают и в ответ не попадают", async () => {
      const { log, seen } = await run("{\"requestId\":\"r1\",\"extra\":1,\"type\":\"ui_echo\"}")
      expect(log.sent).toEqual(["{\"type\":\"ui_echo_ack\",\"requestId\":\"r1\"}"])
      expect(seen).toEqual([])
    })

    // Не эхо — значит, сообщение модулей: у MindWave такое даёт `invalid-message` и
    // `bodymonitor_error «Unknown browser message type»` (замок T-83, S7), и каркас не смеет это съесть.
    test("пустой/нестроковый/отсутствующий requestId и битый JSON — модулям, без ответа каркаса", async () => {
      const notEchoes = [
        "{\"type\":\"ui_echo\",\"requestId\":\"\"}",
        "{\"type\":\"ui_echo\",\"requestId\":5}",
        "{\"type\":\"ui_echo\",\"requestId\":null}",
        "{\"type\":\"ui_echo\"}",
        "{\"type\":\"ui_echo_ack\",\"requestId\":\"r\"}",
        "{\"type\":\"ui_echo\",\"requestId\":\"r\"",
        "null",
        "\"ui_echo\"",
        "[]",
        "plain",
      ]
      for (const message of notEchoes) {
        const { log, seen } = await run(message)
        expect(log.sent).toEqual([])
        expect(seen).toEqual([`m0 ${message}`, `m1 ${message}`])
      }
    })
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
