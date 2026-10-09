// GCY1.7 (GCY-D30): наблюдатель горячего перезапуска — машина состояний без процессов и файловой
// системы (порождение, добивание, порт, подписка, проверка и таймеры подставлены), снимок подписей и
// разбор аргументов; отдельно — настоящий fs.watch на временном каталоге и порт настоящим
// TCP-слушателем на 127.0.0.1 (не HTTP: прокси тут ни при чём, NO_PROXY не нужен).

import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises"
import { createServer, type Server as NetServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { pathKey } from "./import-graph"
import {
  createDevWatcher,
  detectChanges,
  isPortFree,
  parseDevWatchArgs,
  planWatch,
  subscribeFs,
  type DevWatcherDeps,
  type WatchedChild,
  type WatchPlan,
} from "./dev-watch"

const sleep = (aMs: number): Promise<void> => new Promise((aResolve) => setTimeout(aResolve, aMs))

describe("planWatch + detectChanges — снимок подписей на подложенном дереве", () => {
  let root = ""

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "hostkit-plan-"))
    const files: Record<string, string> = {
      "host/server/entry.ts": "import { m } from \"../../mod/ui/m\"\nexport const e = m\n",
      "host/server/neighbour.ts": "export const n = 1\n",
      "host/server/var/ui-diag.log": "line\n",
      "mod/ui/m.ts": "export const m = 1\n",
      "extra/a.ts": "export const a = 1\n",
      "extra/sub/b.tsx": "export const b = 1\n",
      "extra/sub/b.test.ts": "export const t = 1\n",
      "extra/notes.md": "n\n",
      "extra/var/c.ts": "export const c = 1\n",
      "extra/node_modules/p/d.ts": "export const d = 1\n",
      "extra/.git/e.ts": "export const e = 1\n",
    }
    for (const [path, content] of Object.entries(files)) {
      const full = join(root, path)
      await mkdir(join(full, ".."), { recursive: true })
      await writeFile(full, content)
    }
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const rel = (aPaths: Iterable<string>): string[] =>
    [...aPaths].map((aPath) => aPath.slice(root.length + 1).replaceAll("\\", "/")).sort()

  test("снимок — граф точки входа и исходники --watch без тестов и служебных каталогов; каталоги — без исключённых", () => {
    const plan = planWatch(join(root, "host/server/entry.ts"), [join(root, "extra")])
    expect(rel([...plan.snapshot.values()].map((aEntry) => aEntry.path))).toEqual([
      "extra/a.ts",
      "extra/sub/b.tsx",
      "host/server/entry.ts",
      "mod/ui/m.ts",
    ])
    expect(rel(plan.dirs)).toEqual(["extra", "extra/sub", "host/server", "mod/ui"])
  })

  test("правка, удаление и касание — изменение; соседи, логи, тесты и служебные каталоги — нет", () => {
    const plan = planWatch(join(root, "host/server/entry.ts"), [join(root, "extra")])
    const signatures = new Map([...plan.snapshot.values()].map((aEntry) => [aEntry.path, aEntry.signature]))
    const signature = (aOverrides: Record<string, string>) => (aPath: string): string =>
      aOverrides[rel([aPath])[0] ?? ""] ?? signatures.get(aPath) ?? "missing"

    expect(detectChanges(plan, [], signature({}))).toEqual([])
    // Подсказки чужих файлов ничего не меняют: решают подписи.
    const noise = ["host/server/neighbour.ts", "host/server/var", "extra/sub/b.test.ts", "extra/var/c.ts", "extra/notes.md"].map((aPath) => join(root, aPath))
    expect(detectChanges(plan, noise, (aPath) => (signatures.get(aPath) ?? "1:1"))).toEqual([])

    expect(rel(detectChanges(plan, [], signature({ "mod/ui/m.ts": "2:2" })))).toEqual(["mod/ui/m.ts"])
    expect(rel(detectChanges(plan, [], signature({ "extra/sub/b.tsx": "missing" })))).toEqual(["extra/sub/b.tsx"])
    // Подсказка может быть ЧУЖОЙ (Bun теряет второе событие пачки) — правка всё равно найдена.
    expect(rel(detectChanges(plan, [join(root, "host/server/var")], signature({ "host/server/entry.ts": "9:9" })))).toEqual(["host/server/entry.ts"])
  })

  test("новый .ts под --watch — изменение по подсказке; новый тест или файл в var/ — нет", () => {
    const plan = planWatch(join(root, "host/server/entry.ts"), [join(root, "extra")])
    const exists = (aPath: string): string => plan.snapshot.get(pathKey(aPath))?.signature ?? "1:1"
    expect(rel(detectChanges(plan, [join(root, "extra/sub/new.ts")], exists))).toEqual(["extra/sub/new.ts"])
    expect(detectChanges(plan, [join(root, "extra/sub/new.test.ts"), join(root, "extra/var/new.ts"), join(root, "host/server/new.ts")], exists)).toEqual([])
    expect(detectChanges(plan, [join(root, "extra/gone.ts")], () => "missing")).toHaveLength(4) // все из снимка «пропали»
  })
})

describe("parseDevWatchArgs", () => {
  test("точка входа, умолчание порта, каталоги, хвост после --", () => {
    expect(parseDevWatchArgs(["--entry", "server.ts", "--default-port", "3300", "--watch", "a", "--watch", "b", "--", "--port=3391", "x"])).toEqual({
      entry: "server.ts",
      defaultPort: 3300,
      extraRoots: ["a", "b"],
      debounceMs: 150,
      passThrough: ["--port=3391", "x"],
    })
  })

  test("отказы: нет --entry, неизвестный аргумент, аргумент без значения, плохой порт", () => {
    expect(() => parseDevWatchArgs([])).toThrow("--entry")
    expect(() => parseDevWatchArgs(["--entry", "s.ts", "--hot"])).toThrow("unknown argument")
    expect(() => parseDevWatchArgs(["--entry"])).toThrow("needs a value")
    expect(() => parseDevWatchArgs(["--entry", "s.ts", "--default-port", "x"])).toThrow("--default-port")
  })
})

// --- машина состояний ----------------------------------------------------------------------------

interface FakeChild extends WatchedChild {
  exit(aCode: number | null): void
}

const fakeChild = (aPid: number): FakeChild => {
  let resolveExit: (aCode: number | null) => void = () => undefined
  const exited = new Promise<number | null>((aResolve) => {
    resolveExit = aResolve
  })
  return { pid: aPid, exited, exit: (aCode) => resolveExit(aCode) }
}

const EMPTY_PLAN: WatchPlan = { snapshot: new Map(), dirs: [], extraRoots: [] }

interface Rig {
  readonly deps: DevWatcherDeps
  readonly events: string[]
  readonly children: FakeChild[]
  /** Что «изменилось на диске» к следующей проверке (проверка сбрасывает). */
  changed: string[]
  /** Подсказки, с которыми звали проверку. */
  readonly checks: string[][]
  /** Запустить взведённые таймеры с данной задержкой; вернуть их число. */
  fire(aDelayMs: number): number
  pendingTimers(): number
  /** Пусть kill сам роняет ребёнка (как taskkill /F). */
  killExits: boolean
  /** Пусть requestStop роняет ребёнка (штатный уход). */
  stopExits: boolean
  plans: number
}

const flush = async (): Promise<void> => {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve()
  }
}

const rig = (): Rig => {
  const events: string[] = []
  const children: FakeChild[] = []
  const timers = new Map<number, { readonly callback: () => void; readonly delayMs: number }>()
  let nextTimer = 1
  let nextPid = 100
  const state: Rig = {
    events,
    children,
    changed: [],
    checks: [],
    killExits: true,
    stopExits: true,
    plans: 0,
    fire(aDelayMs) {
      const due = [...timers].filter(([, aTimer]) => aTimer.delayMs === aDelayMs)
      for (const [id, aTimer] of due) {
        timers.delete(id)
        aTimer.callback()
      }
      return due.length
    },
    pendingTimers: () => timers.size,
    deps: {
      spawnChild: () => {
        const child = fakeChild(nextPid)
        nextPid += 1
        children.push(child)
        events.push(`spawn ${child.pid}`)
        return child
      },
      killTree: async (aPid) => {
        events.push(`kill ${aPid}`)
        if (state.killExits) {
          children.find((aChild) => aChild.pid === aPid)?.exit(1)
        }
      },
      requestStop: (aPid) => {
        events.push(`request-stop ${aPid}`)
        if (state.stopExits) {
          children.find((aChild) => aChild.pid === aPid)?.exit(0)
        }
      },
      waitPortFree: async () => {
        events.push("port-free")
        return true
      },
      planWatch: () => {
        state.plans += 1
        return EMPTY_PLAN
      },
      detectChanges: (_aPlan, aHints) => {
        state.checks.push([...aHints])
        const changed = state.changed
        state.changed = []
        return changed
      },
      subscribe: () => {
        const id = state.plans
        events.push(`subscribe ${id}`)
        return () => events.push(`unsubscribe ${id}`)
      },
      log: () => undefined,
      setTimer: (aCallback, aDelayMs) => {
        const id = nextTimer
        nextTimer += 1
        timers.set(id, { callback: aCallback, delayMs: aDelayMs })
        return id
      },
      clearTimer: (aHandle) => {
        timers.delete(aHandle as number)
      },
      debounceMs: 150,
      exitWaitMs: 5000,
    },
  }
  return state
}

describe("createDevWatcher", () => {
  test("событие → проверка → изменение → добить дерево по PID → выход и порт → новый ребёнок с новым снимком", async () => {
    const r = rig()
    const watcher = createDevWatcher(r.deps)
    watcher.start()
    expect(r.events).toEqual(["subscribe 1", "spawn 100"])

    watcher.onEvent("C:/h/server.ts")
    expect(r.events).toEqual(["subscribe 1", "spawn 100"])
    r.changed = ["C:/h/server.ts"]
    expect(r.fire(150)).toBe(1)
    await flush()
    expect(r.checks).toEqual([["C:/h/server.ts"]])
    expect(r.events).toEqual(["subscribe 1", "spawn 100", "kill 100", "port-free", "subscribe 2", "unsubscribe 1", "spawn 101"])
    expect(watcher.state()).toEqual({ childPid: 101, childAlive: true, restarting: false, stopped: false })
    expect(r.plans).toBe(2)
  })

  test("событие без изменения подписей (лог в var/, тест, соседний файл) — проверка есть, перезапуска нет", async () => {
    const r = rig()
    const watcher = createDevWatcher(r.deps)
    watcher.start()
    watcher.onEvent("C:/h/var")
    watcher.onEvent("C:/h/server.test.ts")
    r.fire(150)
    await flush()
    expect(r.checks).toEqual([["C:/h/var", "C:/h/server.test.ts"]])
    expect(r.events).toEqual(["subscribe 1", "spawn 100"])
  })

  test("поток событий не душит проверку: срок — от первого события, не сбрасывается", async () => {
    const r = rig()
    const watcher = createDevWatcher(r.deps)
    watcher.start()
    watcher.onEvent("C:/h/var")
    watcher.onEvent("C:/h/var")
    watcher.onEvent("C:/h/server.ts")
    expect(r.pendingTimers()).toBe(1)
    r.changed = ["C:/h/server.ts"]
    r.fire(150)
    await flush()
    expect(r.checks).toEqual([["C:/h/var", "C:/h/server.ts"]])
    expect(r.events.filter((aEvent) => aEvent.startsWith("kill") || aEvent.startsWith("spawn"))).toEqual(["spawn 100", "kill 100", "spawn 101"])
  })

  test("событие во время перезапуска поглощается: новый ребёнок и снимок — после него", async () => {
    const r = rig()
    r.killExits = false
    const watcher = createDevWatcher(r.deps)
    watcher.start()
    watcher.onEvent("C:/h/server.ts")
    r.changed = ["C:/h/server.ts"]
    r.fire(150)
    await flush()
    expect(r.events.at(-1)).toBe("kill 100")
    expect(watcher.state().restarting).toBe(true)

    watcher.onEvent("C:/h/server.ts")
    expect(r.pendingTimers()).toBe(1) // только срок ожидания выхода, не новая проверка
    r.children[0]?.exit(1)
    await flush()
    expect(r.events.slice(-3)).toEqual(["subscribe 2", "unsubscribe 1", "spawn 101"])
    expect(r.pendingTimers()).toBe(0)
    expect(r.checks).toHaveLength(1)
  })

  test("ребёнок вышел сам — ждём правки; правка поднимает нового без добивания", async () => {
    const r = rig()
    const watcher = createDevWatcher(r.deps)
    watcher.start()
    r.children[0]?.exit(1)
    await flush()
    expect(watcher.state().childAlive).toBe(false)

    watcher.onEvent("C:/h/server.ts")
    r.changed = ["C:/h/server.ts"]
    r.fire(150)
    await flush()
    expect(r.events).toEqual(["subscribe 1", "spawn 100", "port-free", "subscribe 2", "unsubscribe 1", "spawn 101"])
  })

  test("не дождались выхода после добивания — сказать и всё равно поднять (порт решит)", async () => {
    const r = rig()
    r.killExits = false
    const lines: string[] = []
    const watcher = createDevWatcher({ ...r.deps, log: (aLine) => lines.push(aLine) })
    watcher.start()
    watcher.onEvent("C:/h/server.ts")
    r.changed = ["C:/h/server.ts"]
    r.fire(150)
    await flush()
    expect(r.fire(5000)).toBe(1)
    await flush()
    expect(r.events.slice(-2)).toEqual(["unsubscribe 1", "spawn 101"])
    expect(lines.some((aLine) => aLine.includes("did not exit within 5000 ms"))).toBe(true)
  })

  test("останов: штатный уход ребёнка без добивания; не ушёл — добить дерево; после — глух", async () => {
    const graceful = rig()
    const first = createDevWatcher(graceful.deps)
    first.start()
    first.onEvent("C:/h/server.ts")
    await first.stop()
    expect(graceful.events).toEqual(["subscribe 1", "spawn 100", "unsubscribe 1", "request-stop 100"])
    expect(graceful.pendingTimers()).toBe(0)
    first.onEvent("C:/h/server.ts")
    expect(graceful.pendingTimers()).toBe(0)

    const stubborn = rig()
    stubborn.stopExits = false
    const second = createDevWatcher(stubborn.deps)
    second.start()
    const stopping = second.stop()
    await flush()
    expect(stubborn.fire(5000)).toBe(1)
    await stopping
    expect(stubborn.events).toEqual(["subscribe 1", "spawn 100", "unsubscribe 1", "request-stop 100", "kill 100"])
    expect(second.state()).toEqual({ childPid: 100, childAlive: false, restarting: false, stopped: true })
  })
})

describe("наблюдатель на настоящей файловой системе (процессы подставлены)", () => {
  // Настоящие planWatch, subscribeFs, detectChanges и таймеры — та же сборка, что в CLI; подставлены
  // только порождение, добивание и порт. Ловит то, чего не видят подстановки выше. Замер GCY1.7:
  // рекурсивный fs.watch Bun на Windows вместо файла подкаталога называет каталог, а из двух записей
  // в один каталог в пределах ~1 мс доходит одна (через 2 мс и дальше — обе). Правило «верить имени
  // из события» на этой последовательности теряло правку файла графа 4 раза из 6
  // (scratchpad gcy1.7/redbefore-name-trust.log); первая редакция этого теста краснела 4 из 5.
  test("лог в var/ — не перезапуск; лог + сосед + файл графа одной пачкой — перезапуск; .ts в подкаталоге --watch — перезапуск", async () => {
    const root = await mkdtemp(join(tmpdir(), "hostkit-watch-"))
    let watcher: ReturnType<typeof createDevWatcher> | null = null
    try {
      await mkdir(join(root, "host", "var"), { recursive: true })
      await mkdir(join(root, "mod", "deep"), { recursive: true })
      await mkdir(join(root, "extra", "sub"), { recursive: true })
      await writeFile(join(root, "host", "entry.ts"), "import { m } from \"../mod/deep/m\"\nexport const e = m\n")
      await writeFile(join(root, "mod", "deep", "m.ts"), "export const m = 1\n")
      await writeFile(join(root, "mod", "deep", "unrelated.ts"), "export const u = 1\n")
      await writeFile(join(root, "extra", "sub", "x.ts"), "export const x = 1\n")
      // Подписи с прошлым временем: запись «той же» секунды не должна совпасть с ними случайно.
      const past = new Date(Date.now() - 60_000)
      for (const file of [join(root, "mod", "deep", "m.ts"), join(root, "extra", "sub", "x.ts")]) {
        await utimes(file, past, past)
      }

      const lines: string[] = []
      const children: FakeChild[] = []
      watcher = createDevWatcher({
        spawnChild: () => {
          const child = fakeChild(children.length + 1)
          children.push(child)
          return child
        },
        killTree: async (aPid) => {
          children[aPid - 1]?.exit(1)
        },
        requestStop: (aPid) => {
          children[aPid - 1]?.exit(0)
        },
        waitPortFree: async () => true,
        planWatch: () => planWatch(join(root, "host", "entry.ts"), [join(root, "extra")]),
        detectChanges: (aPlan, aHints) => detectChanges(aPlan, aHints),
        subscribe: subscribeFs((aLine) => lines.push(aLine)),
        log: (aLine) => lines.push(aLine),
        setTimer: (aCallback, aDelayMs) => setTimeout(aCallback, aDelayMs),
        clearTimer: (aHandle) => clearTimeout(aHandle as ReturnType<typeof setTimeout>),
        debounceMs: 150,
        exitWaitMs: 2000,
      })
      watcher.start()
      // fs.watch на Windows начинает слышать не мгновенно.
      await sleep(200)

      const waitForChildren = async (aCount: number): Promise<boolean> => {
        for (let index = 0; index < 60; index += 1) {
          if (children.length >= aCount && !watcher?.state().restarting) {
            return true
          }
          await sleep(50)
        }
        return false
      }

      // Сервер пишет лог: событие («var» в каталоге host) есть, перезапуска нет.
      await writeFile(join(root, "host", "var", "ui-diag.log"), "line\n")
      await sleep(500)
      expect(children).toHaveLength(1)

      // Три записи одной пачкой: до наблюдателя доходит в лучшем случае первая — лог.
      await writeFile(join(root, "host", "var", "ui-diag.log"), "line 2\n")
      await writeFile(join(root, "mod", "deep", "unrelated.ts"), "export const u = 2\n")
      await writeFile(join(root, "mod", "deep", "m.ts"), "export const m = 2\n")
      expect(await waitForChildren(2)).toBe(true)
      expect(lines.some((aLine) => aLine.includes("changed:") && aLine.includes("m.ts"))).toBe(true)
      await sleep(400)
      expect(children).toHaveLength(2)

      await writeFile(join(root, "extra", "sub", "x.ts"), "export const x = 2\n")
      expect(await waitForChildren(3)).toBe(true)
      expect(lines.some((aLine) => aLine.includes("changed:") && aLine.includes("x.ts"))).toBe(true)
      await sleep(400)
      expect(children).toHaveLength(3)
      expect(lines.filter((aLine) => aLine.startsWith("[dev-watch] cannot watch"))).toEqual([])
    } finally {
      await watcher?.stop()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("isPortFree", () => {
  test("занят, пока слушают; свободен после закрытия", async () => {
    const server: NetServer = createServer()
    await new Promise<void>((aResolve) => server.listen(0, "127.0.0.1", () => aResolve()))
    const address = server.address()
    const port = typeof address === "object" && address !== null ? address.port : 0
    expect(port).toBeGreaterThan(0)
    expect(await isPortFree(port)).toBe(false)
    await new Promise<void>((aResolve) => server.close(() => aResolve()))
    expect(await isPortFree(port)).toBe(true)
  })
})
