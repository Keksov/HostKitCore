// GCY1.7: админ-ручки «Bun-действий» каркаса — без процессов: сборка, перезапуск и выход подменены.
// Тексты, коды и порядок — те же, что были в MindWaveCore/server/server.ts до переезда (клиент —
// HostKitCore/ui/shell/admin-api.ts; проба uitest probe-rtc32-shutdown-temp.ts шлёт POST {restartBun}).

import { afterEach, describe, expect, test } from "bun:test"

import { createAdminBunActions, type AdminBunActionExtension, type AdminBunActionsDeps } from "./admin"
import { DEV_WATCHER_ENV } from "./watch-mode"

const URL_BASE = "http://127.0.0.1:3391"

const request = (aPath: string, aMethod = "GET", aBody?: string): Request =>
  new Request(`${URL_BASE}${aPath}`, aBody === undefined ? { method: aMethod } : { method: aMethod, body: aBody })

interface Harness {
  readonly events: string[]
  readonly deps: AdminBunActionsDeps
}

const harness = (aOverrides: Partial<AdminBunActionsDeps> = {}): Harness => {
  const events: string[] = []
  return {
    events,
    deps: {
      exitAfterDispose: (aCode) => events.push(`exit(${aCode})`),
      runBunCommand: async (aArgs, aCwd) => {
        events.push(`bun ${aArgs.join(" ")} @ ${aCwd}`)
        return { exitCode: 0, output: "" }
      },
      spawnDetachedRestart: (aCwd, aEntry) => events.push(`restart ${aEntry} @ ${aCwd}`),
      getBlockedReason: () => null,
      isWatchMode: () => false,
      schedule: (aCallback, aDelayMs) => {
        events.push(`schedule ${aDelayMs}ms`)
        aCallback()
      },
      ...aOverrides,
    },
  }
}

const config = (aExtensions: readonly AdminBunActionExtension[] = []) => ({
  uiDir: "C:/host/ui",
  restart: { cwd: "C:/host/server", entry: "server.ts" },
  extensions: aExtensions,
})

const restartExe = (aEvents: string[], aFail?: unknown): AdminBunActionExtension => ({
  bodyKey: "restartExe",
  route: "restart-exe",
  run: async () => {
    aEvents.push("restart-exe")
    if (aFail !== undefined) {
      throw aFail
    }
    return { action: "restart_exe", status: "completed" }
  },
  fallbackError: "BodyMonitor.exe restart failed",
  errorStatus: (aMessage) => (aMessage.includes("Replay is active") ? 409 : 500),
})

const body = async (aResponse: Response | null): Promise<{ status: number; json: unknown }> => {
  if (aResponse === null) {
    throw new Error("expected a response, got null")
  }
  return { status: aResponse.status, json: await aResponse.json() }
}

describe("admin.ts — маршруты", () => {
  test("чужие пути — null (дальше модули и статика)", async () => {
    const { deps } = harness()
    const admin = createAdminBunActions(config(), deps)
    for (const path of ["/", "/api/logs", "/x/admin/bun-actions", "/api/admin", "/api/admin/bun-actions/a/b"]) {
      expect({ path, response: await admin.handleRequest(request(path)) }).toEqual({ path, response: null })
    }
  })

  test("GET статус; иной метод — 405; неизвестное действие — 404", async () => {
    const { deps } = harness()
    const admin = createAdminBunActions(config(), deps)
    expect(await body(await admin.handleRequest(request("/api/admin/bun-actions")))).toEqual({
      status: 200,
      json: { canRestartBun: true, restartBunReason: null, isWatchMode: false },
    })
    // Хвостовой слэш и двойной слэш — тот же маршрут (сегменты фильтруются, как было).
    expect((await admin.handleRequest(request("/api//admin/bun-actions/")))?.status).toBe(200)
    expect(await body(await admin.handleRequest(request("/api/admin/bun-actions", "PUT")))).toEqual({ status: 405, json: { error: "Method not allowed" } })
    expect(await body(await admin.handleRequest(request("/api/admin/bun-actions/build-ui")))).toEqual({ status: 405, json: { error: "Method not allowed" } })
    expect(await body(await admin.handleRequest(request("/api/admin/bun-actions/nope", "POST")))).toEqual({ status: 404, json: { error: "API route not found" } })
  })

  test("заблокированный restart-bun: статус с причиной, ручка — 409, перезапуска нет", async () => {
    const { deps, events } = harness({ getBlockedReason: () => "blocked: watcher", isWatchMode: () => true })
    const admin = createAdminBunActions(config(), deps)
    expect(await body(await admin.handleRequest(request("/api/admin/bun-actions")))).toEqual({
      status: 200,
      json: { canRestartBun: false, restartBunReason: "blocked: watcher", isWatchMode: true },
    })
    expect(await body(await admin.handleRequest(request("/api/admin/bun-actions/restart-bun", "POST")))).toEqual({ status: 409, json: { error: "blocked: watcher" } })
    // В POST со списком — та же ошибка, но 500 (как было: общий catch).
    expect(await body(await admin.handleRequest(request("/api/admin/bun-actions", "POST", JSON.stringify({ restartBun: true }))))).toEqual({ status: 500, json: { error: "blocked: watcher" } })
    expect(events).toEqual([])
  })

  test("restart-bun: 202 scheduled, отсоединённый перезапуск точки входа хоста, затем выход через цепочку", async () => {
    const { deps, events } = harness()
    const admin = createAdminBunActions(config(), deps)
    expect(await body(await admin.handleRequest(request("/api/admin/bun-actions/restart-bun", "POST")))).toEqual({
      status: 202,
      json: { action: "restart_bun", status: "scheduled" },
    })
    expect(events).toEqual(["restart server.ts @ C:/host/server", "schedule 50ms", "exit(0)"])
  })

  test("build-ui: bun run build в каталоге UI хоста; провал — 500 с выводом или с кодом", async () => {
    const ok = harness()
    expect(await body(await createAdminBunActions(config(), ok.deps).handleRequest(request("/api/admin/bun-actions/build-ui", "POST")))).toEqual({
      status: 200,
      json: { action: "build_ui", status: "completed" },
    })
    expect(ok.events).toEqual(["bun run build @ C:/host/ui"])

    const silent = harness({ runBunCommand: async () => ({ exitCode: 1, output: "" }) })
    expect(await body(await createAdminBunActions(config(), silent.deps).handleRequest(request("/api/admin/bun-actions/build-ui", "POST")))).toEqual({
      status: 500,
      json: { error: "UI build failed with exit code 1" },
    })
    const loud = harness({ runBunCommand: async () => ({ exitCode: null, output: "vite: boom" }) })
    expect(await body(await createAdminBunActions(config(), loud.deps).handleRequest(request("/api/admin/bun-actions/build-ui", "POST")))).toEqual({
      status: 500,
      json: { error: "vite: boom" },
    })
  })

  test("расширение хоста: своя ручка, свой код по тексту ошибки, запасной текст для не-Error", async () => {
    const okEvents: string[] = []
    const ok = harness()
    expect(await body(await createAdminBunActions(config([restartExe(okEvents)]), ok.deps).handleRequest(request("/api/admin/bun-actions/restart-exe", "POST")))).toEqual({
      status: 200,
      json: { action: "restart_exe", status: "completed" },
    })

    const cases: readonly [unknown, number, string][] = [
      [new Error("Replay is active but could not be stopped before restarting BodyMonitor.exe"), 409, "Replay is active but could not be stopped before restarting BodyMonitor.exe"],
      [new Error("spawn failed"), 500, "spawn failed"],
      ["not an error", 500, "BodyMonitor.exe restart failed"],
    ]
    for (const [thrown, status, message] of cases) {
      const events: string[] = []
      const admin = createAdminBunActions(config([restartExe(events, thrown)]), harness().deps)
      expect(await body(await admin.handleRequest(request("/api/admin/bun-actions/restart-exe", "POST")))).toEqual({ status, json: { error: message } })
    }
  })
})

describe("admin.ts — POST со списком действий", () => {
  test("порядок build-ui → расширения → restart-bun; 202 при restart-bun", async () => {
    const { deps, events } = harness()
    const admin = createAdminBunActions(config([restartExe(events)]), deps)
    const response = await admin.handleRequest(request("/api/admin/bun-actions", "POST", JSON.stringify({ restartBun: true, restartExe: true, buildUi: true })))
    expect(await body(response)).toEqual({ status: 202, json: { completed: ["build_ui", "restart_exe"], scheduled: ["restart_bun"] } })
    expect(events).toEqual(["bun run build @ C:/host/ui", "restart-exe", "restart server.ts @ C:/host/server", "schedule 50ms", "exit(0)"])
  })

  test("без restart-bun — 200; поле расширения без расширения — не действие", async () => {
    const { deps, events } = harness()
    const withExe = createAdminBunActions(config([restartExe(events)]), deps)
    expect(await body(await withExe.handleRequest(request("/api/admin/bun-actions", "POST", JSON.stringify({ restartExe: true }))))).toEqual({
      status: 200,
      json: { completed: ["restart_exe"], scheduled: [] },
    })

    const bare = createAdminBunActions(config(), harness().deps)
    expect(await body(await bare.handleRequest(request("/api/admin/bun-actions", "POST", JSON.stringify({ restartExe: true }))))).toEqual({
      status: 400,
      json: { error: "At least one admin action must be selected" },
    })
  })

  test("отказы тела: не объект — 400, не JSON — 500 «Invalid JSON body» (как было), ошибка действия — 500", async () => {
    const admin = createAdminBunActions(config(), harness().deps)
    expect(await body(await admin.handleRequest(request("/api/admin/bun-actions", "POST", "\"text\"")))).toEqual({ status: 400, json: { error: "Invalid admin action payload" } })
    expect(await body(await admin.handleRequest(request("/api/admin/bun-actions", "POST", "{}")))).toEqual({ status: 400, json: { error: "At least one admin action must be selected" } })
    expect(await body(await admin.handleRequest(request("/api/admin/bun-actions", "POST", "{oops")))).toEqual({ status: 500, json: { error: "Invalid JSON body" } })

    const failing = createAdminBunActions(config([restartExe([], "boom")]), harness().deps)
    expect(await body(await failing.handleRequest(request("/api/admin/bun-actions", "POST", JSON.stringify({ restartExe: true }))))).toEqual({ status: 500, json: { error: "Admin action failed" } })
  })

  test("расширение не может занять имя встроенного действия", () => {
    const clash = (aRoute: string, aKey: string): AdminBunActionExtension => ({ ...restartExe([]), route: aRoute, bodyKey: aKey })
    expect(() => createAdminBunActions(config([clash("restart-bun", "x")]), harness().deps)).toThrow()
    expect(() => createAdminBunActions(config([clash("x", "buildUi")]), harness().deps)).toThrow()
    expect(() => createAdminBunActions(config([clash("x", "y"), clash("x", "z")]), harness().deps)).toThrow()
  })
})

describe("admin.ts — блокировка restart-bun под наблюдателем (настоящие признаки)", () => {
  const saved = process.env[DEV_WATCHER_ENV]
  afterEach(() => {
    if (saved === undefined) {
      delete process.env[DEV_WATCHER_ENV]
    } else {
      process.env[DEV_WATCHER_ENV] = saved
    }
  })

  test(`${DEV_WATCHER_ENV}=1 — restart-bun заблокирован, isWatchMode true; без него — свободен`, async () => {
    const { exitAfterDispose, runBunCommand, spawnDetachedRestart, schedule } = harness().deps
    const deps = { exitAfterDispose, runBunCommand, spawnDetachedRestart, schedule }

    delete process.env[DEV_WATCHER_ENV]
    const free = await body(await createAdminBunActions(config(), deps).handleRequest(request("/api/admin/bun-actions")))
    // `bun test` не идёт под --watch: без переменной ручка свободна.
    expect(free).toEqual({ status: 200, json: { canRestartBun: true, restartBunReason: null, isWatchMode: false } })

    process.env[DEV_WATCHER_ENV] = "1"
    const blocked = await body(await createAdminBunActions(config(), deps).handleRequest(request("/api/admin/bun-actions")))
    expect(blocked).toEqual({
      status: 200,
      json: {
        canRestartBun: false,
        restartBunReason: "Restart bun is disabled while the server is running under the dev watcher (it restarts the server on edits itself)",
        isWatchMode: true,
      },
    })
  })
})
