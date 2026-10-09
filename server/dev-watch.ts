// GCY1.7 (план gnauralcity, GCY-D30): наблюдатель горячего перезапуска сервера хоста — замена
// `bun --watch` в дев-скрипте. Замер GCY1.1: на Windows `bun --watch` следит только за файлами под
// cwd процесса, а сервер хоста — это код пяти репозиториев; `--hot` не годится — у сервера побочные
// эффекты верхнего уровня (сессии, BodyMonitor.exe, таймеры), повторять их в живом процессе нельзя.
//
// Запуск (из каталога сервера хоста, дев-скрипт его package.json):
//   bun <HostKitCore>/server/dev-watch.ts --entry server.ts [--default-port 3300] [--watch <каталог>]…
//     [--debounce-ms 150] [-- <аргументы точки входа>]
//
// Что делает:
//   * порождает ребёнка `<тот же bun> run <entry>` — обычного потомка (без detached), в том же
//     каталоге, с окружением наблюдателя плюс `HK_DEV_WATCHER=1` (`watch-mode.ts`: под ним
//     `restart-bun` заблокирован, как под `--watch`); вывод ребёнка — прямо в консоль наблюдателя
//     (stdio inherit: лог AppCore и окно терминала видят его как раньше);
//   * следит за ГРАФОМ ИМПОРТОВ точки входа (`import-graph.ts`) и за `.ts` в каталогах `--watch`
//     (кроме `node_modules`, `var`, `tmp`, `public`, `vendor`, `build`, скрытых каталогов и тестов:
//     сервер сам пишет в `var/`, без исключений перезапуск был бы вечным); граф, каталоги и снимок
//     подписей пересчитываются на каждом (пере)запуске;
//   * правка → проверка подписей → ДОБИТЬ ДЕРЕВО ребёнка по его PID (`taskkill /PID <pid> /T /F`:
//     движок, BodyMonitor.exe и воркер спектра — его потомки, гаснут вместе с ним, звук тоже) →
//     дождаться выхода и освобождения порта → поднять снова (новый PID);
//   * ребёнок вышел сам (ошибка старта, синтаксис) — сообщить и ждать правки, как `--watch`;
//   * SIGINT/SIGTERM наблюдателю — дать ребёнку уйти штатно (Ctrl+C в консоли получает и он, и его
//     цепочка останова гасит звук), затем добить дерево, если жив, и выйти.
//
// СОБЫТИЕ — ПОДСКАЗКА, ПОДПИСЬ — ПРАВДА. `fs.watch` Bun на Windows (1.3.11 и 1.3.13, замер GCY1.7)
// ненадёжен дважды: рекурсивный о записи в файл подкаталога называет КАТАЛОГ, а не файл; и даже
// без рекурсии из двух записей в один каталог подряд (~1 мс) доходит только первая. Поэтому:
// каждый каталог слушается БЕЗ рекурсии (подкаталоги `--watch` перечисляются явно), событие с
// ЛЮБЫМ именем лишь взводит проверку, а проверка сравнивает подписи (mtime + размер) отслеживаемых
// файлов со снимком, снятым при запуске ребёнка. Запись сервера в `var/` взводит проверку (событие
// «var» в каталоге сервера), но подписи не меняет — перезапуска нет.
//
// PID берётся только у СВОЕГО ребёнка и только пока тот жив (держим его дескриптор — Windows не
// отдаёт PID другому процессу, пока дескриптор открыт); никакого поиска процессов по имени.
// Дерево остаётся прежней формы: `cmd` → `bun run dev` → наблюдатель → сервер → движок/воркер;
// AppCore (`killRegisteredPorts`) поднимается от слушателя порта к `cmd.exe` и гасит всё дерево.

import { spawn } from "node:child_process"
import { readdirSync, statSync, watch, type Dirent, type FSWatcher } from "node:fs"
import { connect } from "node:net"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

import { pathKey, scanImportGraph } from "./import-graph"
import { resolveServerPort } from "./port"
import { DEV_WATCHER_ENV } from "./watch-mode"

// --- что отслеживается ---------------------------------------------------------------------------

/** Каталоги, правки в которых не перезапускают сервер (в каталогах `--watch`). */
export const EXCLUDED_DIR_NAMES: ReadonlySet<string> = new Set(["node_modules", "var", "tmp", "public", "vendor", "build"])

const isTestFile = (aName: string): boolean => /(?:\.|_)(?:test|spec)\.[cm]?[jt]sx?$/u.test(aName)
const isWatchedSource = (aName: string): boolean => /\.(?:ts|tsx|mts)$/u.test(aName) && !isTestFile(aName)
const isExcludedDirName = (aName: string): boolean => EXCLUDED_DIR_NAMES.has(aName.toLowerCase()) || aName.startsWith(".")

/** Подпись файла: mtime и размер; `missing` — файла нет. */
export const fileSignature = (aPath: string): string => {
  try {
    const info = statSync(aPath)
    return `${info.mtimeMs}:${info.size}`
  } catch {
    return "missing"
  }
}

export interface WatchPlan {
  /** Отслеживаемые файлы (ключ `pathKey`) → путь и подпись на момент снимка. */
  readonly snapshot: ReadonlyMap<string, { readonly path: string; readonly signature: string }>
  /**
   * Каталоги, за которыми следим, — ВСЕ без рекурсии: каталоги файлов графа и каждый подкаталог
   * каталогов `--watch` (кроме исключённых). Подкаталог, созданный после (пере)запуска, слышен со
   * следующего перезапуска.
   */
  readonly dirs: readonly string[]
  /** Каталоги `--watch` (абсолютные): новый `.ts` под ними (не из снимка) — тоже правка. */
  readonly extraRoots: readonly string[]
}

/** Каталог и все его подкаталоги, кроме исключённых (и того, что внутри них); с файлами-исходниками. */
const walkWatchDirs = (aRoot: string): { dirs: string[]; sources: string[] } => {
  const dirs: string[] = []
  const sources: string[] = []
  const queue = [aRoot]
  while (queue.length > 0) {
    const dir = queue.pop() as string
    dirs.push(dir)
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !isExcludedDirName(entry.name)) {
        queue.push(join(dir, entry.name))
      } else if (entry.isFile() && isWatchedSource(entry.name)) {
        sources.push(join(dir, entry.name))
      }
    }
  }
  return { dirs, sources }
}

export const planWatch = (aEntry: string, aExtraRoots: readonly string[]): WatchPlan => {
  const graph = scanImportGraph(aEntry)
  const extraRoots = aExtraRoots.map((aRoot) => resolve(aRoot))
  const walked = extraRoots.map(walkWatchDirs)

  const dirs = new Map<string, string>()
  for (const dir of [...graph.map((aFile) => dirname(aFile)), ...walked.flatMap((aWalk) => aWalk.dirs)]) {
    dirs.set(pathKey(dir), dir)
  }

  const snapshot = new Map<string, { path: string; signature: string }>()
  for (const file of [...graph, ...walked.flatMap((aWalk) => aWalk.sources)]) {
    snapshot.set(pathKey(file), { path: file, signature: fileSignature(file) })
  }

  return { snapshot, dirs: [...dirs.values()], extraRoots }
}

/** Новый (не из снимка) исходник под каталогом `--watch`, кроме исключённых подкаталогов. */
export const isNewWatchedSource = (aPath: string, aPlan: WatchPlan): boolean => {
  if (aPlan.snapshot.has(pathKey(aPath))) {
    return false
  }

  for (const root of aPlan.extraRoots) {
    const rel = relative(root, resolve(aPath))
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      continue
    }

    const segments = rel.split(/[\\/]/u)
    const name = segments[segments.length - 1] ?? ""
    if (segments.slice(0, -1).every((aSegment) => !isExcludedDirName(aSegment)) && isWatchedSource(name)) {
      return true
    }
  }

  return false
}

/**
 * Что изменилось против снимка: отслеживаемые файлы с другой подписью (правлен, удалён, тронут) и
 * новые исходники каталогов `--watch` среди подсказок событий. Пусто — перезапуска нет.
 */
export const detectChanges = (aPlan: WatchPlan, aHints: readonly string[], aSignature: (aPath: string) => string = fileSignature): string[] => {
  const changed: string[] = []
  for (const { path, signature } of aPlan.snapshot.values()) {
    if (aSignature(path) !== signature) {
      changed.push(path)
    }
  }
  for (const hint of aHints) {
    if (isNewWatchedSource(hint, aPlan) && aSignature(hint) !== "missing") {
      changed.push(hint)
    }
  }
  return changed
}

// --- машина состояний (без процессов и файловой системы: всё внешнее — в зависимостях) -----------

export interface WatchedChild {
  readonly pid: number
  /** Код выхода; `null` — убит сигналом. */
  readonly exited: Promise<number | null>
}

export interface DevWatcherDeps {
  readonly spawnChild: () => WatchedChild
  /** Добить дерево процесса (жёстко). */
  readonly killTree: (aPid: number) => Promise<void>
  /** Попросить ребёнка уйти штатно (POSIX — SIGTERM; на Windows Ctrl+C уже дошёл до него сам). */
  readonly requestStop: (aPid: number) => void
  /** Ждать, пока порт сервера освободится; `false` — не дождались. */
  readonly waitPortFree: () => Promise<boolean>
  /** Граф, каталоги и снимок подписей — на каждый (пере)запуск ребёнка. */
  readonly planWatch: () => WatchPlan
  /** Что изменилось против снимка плана (подсказки — имена из событий с последней проверки). */
  readonly detectChanges: (aPlan: WatchPlan, aHints: readonly string[]) => string[]
  /** Подписаться на события по плану; возвращает отписку. */
  readonly subscribe: (aPlan: WatchPlan, aOnEvent: (aPath: string) => void) => () => void
  readonly log: (aLine: string) => void
  readonly setTimer: (aCallback: () => void, aDelayMs: number) => unknown
  readonly clearTimer: (aHandle: unknown) => void
  /** Задержка проверки от ПЕРВОГО события (не сбрасывается следующими — поток записей логов не душит её). */
  readonly debounceMs: number
  /** Сколько ждать выхода ребёнка после `killTree` (и штатного ухода при останове). */
  readonly exitWaitMs: number
}

export interface DevWatcher {
  start(): void
  /** Событие файловой системы (то же, что зовёт подписка); имя — только подсказка. */
  onEvent(aPath: string): void
  /** Остановить наблюдение и ребёнка. */
  stop(): Promise<void>
  /** Для тестов и диагностики. */
  readonly state: () => { readonly childPid: number | null; readonly childAlive: boolean; readonly restarting: boolean; readonly stopped: boolean }
}

export const createDevWatcher = (aDeps: DevWatcherDeps): DevWatcher => {
  let child: WatchedChild | null = null
  const exitedChildren = new WeakSet<WatchedChild>()
  let plan: WatchPlan | null = null
  let unsubscribe: (() => void) | null = null
  let checkHandle: unknown = null
  const hints = new Set<string>()
  let restarting = false
  let stopped = false

  const isAlive = (aChild: WatchedChild | null): aChild is WatchedChild => aChild !== null && !exitedChildren.has(aChild)

  /** Ждать выхода не дольше `aMs`; `true` — вышел. */
  const waitExit = async (aChild: WatchedChild, aMs: number): Promise<boolean> => {
    if (!isAlive(aChild)) {
      return true
    }
    let handle: unknown = null
    const timedOut = new Promise<false>((aResolve) => {
      handle = aDeps.setTimer(() => aResolve(false), aMs)
    })
    const result = await Promise.race([aChild.exited.then(() => true as const), timedOut])
    aDeps.clearTimer(handle)
    return result
  }

  const launch = (): void => {
    // Снимок — ДО порождения: правка, пришедшая, пока ребёнок грузит модули, отличается от снимка
    // и даёт ещё один перезапуск, а не тихо застревает в старом коде.
    plan = aDeps.planWatch()
    hints.clear()
    // Новая подписка — раньше снятия старой: событие в этот миг не теряется.
    const previous = unsubscribe
    unsubscribe = aDeps.subscribe(plan, (aPath) => watcher.onEvent(aPath))
    previous?.()

    const spawned = aDeps.spawnChild()
    child = spawned
    aDeps.log(`[dev-watch] server started, pid ${spawned.pid}; watching ${plan.snapshot.size} file(s) in ${plan.dirs.length} dir(s)` +
      (plan.extraRoots.length > 0 ? ` (import graph + ${plan.extraRoots.length} extra dir(s))` : " (its import graph)"))
    void spawned.exited.then((aCode) => {
      exitedChildren.add(spawned)
      if (!stopped && !restarting && child === spawned) {
        aDeps.log(`[dev-watch] server pid ${spawned.pid} exited (code ${aCode ?? "signal"}); waiting for a change to start it again`)
      }
    })
  }

  const restart = async (aWhat: string): Promise<void> => {
    restarting = true
    try {
      const current = child
      if (isAlive(current)) {
        aDeps.log(`[dev-watch] changed: ${aWhat} — stopping server pid ${current.pid} (whole tree)`)
        await aDeps.killTree(current.pid)
        if (!(await waitExit(current, aDeps.exitWaitMs))) {
          aDeps.log(`[dev-watch] server pid ${current.pid} did not exit within ${aDeps.exitWaitMs} ms after the kill`)
        }
      } else {
        aDeps.log(`[dev-watch] changed: ${aWhat} — starting server`)
      }

      if (!(await aDeps.waitPortFree())) {
        aDeps.log("[dev-watch] the server port is still busy; starting anyway")
      }

      if (stopped) {
        return
      }

      launch()
    } finally {
      restarting = false
    }
  }

  const check = async (): Promise<void> => {
    checkHandle = null
    if (stopped || restarting || plan === null) {
      return
    }

    const changed = aDeps.detectChanges(plan, [...hints])
    hints.clear()
    if (changed.length === 0) {
      return
    }

    const shown = changed.slice(0, 3).join(", ") + (changed.length > 3 ? ` (+${changed.length - 3})` : "")
    await restart(shown)
  }

  const watcher: DevWatcher = {
    start(): void {
      launch()
    },

    onEvent(aPath: string): void {
      // Событие во время перезапуска поглощается: новый ребёнок и его снимок — уже после него.
      if (stopped || restarting || plan === null) {
        return
      }

      hints.add(aPath)
      if (checkHandle === null) {
        checkHandle = aDeps.setTimer(() => {
          void check()
        }, aDeps.debounceMs)
      }
    },

    async stop(): Promise<void> {
      if (stopped) {
        return
      }

      stopped = true
      if (checkHandle !== null) {
        aDeps.clearTimer(checkHandle)
        checkHandle = null
      }
      unsubscribe?.()
      unsubscribe = null

      const current = child
      if (!isAlive(current)) {
        return
      }

      aDeps.requestStop(current.pid)
      if (await waitExit(current, aDeps.exitWaitMs)) {
        return
      }

      aDeps.log(`[dev-watch] server pid ${current.pid} did not stop within ${aDeps.exitWaitMs} ms — killing its tree`)
      await aDeps.killTree(current.pid)
      await waitExit(current, aDeps.exitWaitMs)
    },

    state: () => ({
      childPid: child?.pid ?? null,
      childAlive: isAlive(child),
      restarting,
      stopped,
    }),
  }

  return watcher
}

// --- настоящие процессы, файлы и порт ------------------------------------------------------------

/** Свободен ли порт на 127.0.0.1: соединение отвергнуто — свободен; принято или нет ответа — занят. */
export const isPortFree = (aPort: number, aTimeoutMs = 1000): Promise<boolean> => {
  return new Promise((aResolve) => {
    const socket = connect({ host: "127.0.0.1", port: aPort })
    const finish = (aFree: boolean): void => {
      clearTimeout(timer)
      socket.destroy()
      aResolve(aFree)
    }
    const timer = setTimeout(() => finish(false), aTimeoutMs)
    socket.once("connect", () => finish(false))
    socket.once("error", () => finish(true))
  })
}

export const waitPortFree = async (aPort: number, aTimeoutMs: number, aPollMs = 100): Promise<boolean> => {
  const deadline = Date.now() + aTimeoutMs
  for (;;) {
    if (await isPortFree(aPort)) {
      return true
    }
    if (Date.now() >= deadline) {
      return false
    }
    await new Promise((aResolve) => setTimeout(aResolve, aPollMs))
  }
}

/** Жёстко добить дерево процесса по PID (Windows — `taskkill /T /F`; иначе — SIGKILL самому процессу). */
export const killProcessTree = (aPid: number): Promise<void> => {
  if (process.platform !== "win32") {
    try {
      process.kill(aPid, "SIGKILL")
    } catch {
      // уже вышел
    }
    return Promise.resolve()
  }

  return new Promise((aResolve) => {
    const killer = spawn("taskkill", ["/PID", String(aPid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
    killer.once("error", () => aResolve())
    killer.once("close", () => aResolve())
  })
}

/** Подписка на файловую систему по плану: каждый каталог плана — без рекурсии (см. шапку файла). */
export const subscribeFs = (aLog: (aLine: string) => void) => (aPlan: WatchPlan, aOnEvent: (aPath: string) => void): (() => void) => {
  const watchers: FSWatcher[] = []
  for (const dir of aPlan.dirs) {
    try {
      watchers.push(watch(dir, { recursive: false }, (_aEvent, aName) => {
        // Имя бывает пустым — событие всё равно повод для проверки.
        aOnEvent(aName === null || aName === undefined ? dir : join(dir, String(aName)))
      }))
    } catch (error) {
      aLog(`[dev-watch] cannot watch ${dir}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return () => {
    for (const fsWatcher of watchers) {
      fsWatcher.close()
    }
  }
}

export interface DevWatchCliOptions {
  readonly entry: string
  readonly defaultPort: number | null
  readonly extraRoots: readonly string[]
  readonly debounceMs: number
  readonly passThrough: readonly string[]
}

export const parseDevWatchArgs = (aArgs: readonly string[]): DevWatchCliOptions => {
  let entry: string | null = null
  let defaultPort: number | null = null
  let debounceMs = 150
  const extraRoots: string[] = []
  const separator = aArgs.indexOf("--")
  const own = separator < 0 ? aArgs : aArgs.slice(0, separator)
  const passThrough = separator < 0 ? [] : aArgs.slice(separator + 1)

  for (let index = 0; index < own.length; index += 1) {
    const arg = own[index]
    const value = own[index + 1]
    const needValue = (): string => {
      if (value === undefined) {
        throw new Error(`${arg} needs a value`)
      }
      index += 1
      return value
    }
    if (arg === "--entry") {
      entry = needValue()
    } else if (arg === "--default-port") {
      defaultPort = Number(needValue())
    } else if (arg === "--watch") {
      extraRoots.push(needValue())
    } else if (arg === "--debounce-ms") {
      debounceMs = Number(needValue())
    } else {
      throw new Error(`unknown argument ${arg ?? ""}`)
    }
  }

  if (entry === null) {
    throw new Error("--entry <file> is required")
  }
  if (defaultPort !== null && !(Number.isInteger(defaultPort) && defaultPort > 0)) {
    throw new Error("--default-port must be a positive integer")
  }
  if (!(Number.isFinite(debounceMs) && debounceMs >= 0)) {
    throw new Error("--debounce-ms must be a non-negative number")
  }

  return { entry, defaultPort, extraRoots, debounceMs, passThrough }
}

const runCli = (): void => {
  const options = parseDevWatchArgs(Bun.argv.slice(2))
  const cwd = process.cwd()
  const entryPath = resolve(cwd, options.entry)
  // Порт — тем же правилом, что у сервера (`--port=` в argv, затем PORT, затем умолчание хоста).
  // Без умолчания, без `--port=` и без PORT наблюдатель не знает порта и ждёт только выхода ребёнка.
  const resolvedPort = resolveServerPort(options.defaultPort ?? 0)
  const port = resolvedPort > 0 ? resolvedPort : null
  const log = (aLine: string): void => {
    console.log(aLine)
  }

  const watcher = createDevWatcher({
    spawnChild: () => {
      const proc = Bun.spawn([process.execPath, "run", options.entry, ...options.passThrough], {
        cwd,
        env: { ...process.env, [DEV_WATCHER_ENV]: "1" },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      })
      return { pid: proc.pid, exited: proc.exited.then((aCode) => (proc.signalCode !== null ? null : aCode)) }
    },
    killTree: killProcessTree,
    requestStop: (aPid) => {
      if (process.platform !== "win32") {
        try {
          process.kill(aPid, "SIGTERM")
        } catch {
          // уже вышел
        }
      }
    },
    waitPortFree: () => (port === null ? Promise.resolve(true) : waitPortFree(port, 10_000)),
    planWatch: () => planWatch(entryPath, options.extraRoots.map((aRoot) => resolve(cwd, aRoot))),
    detectChanges: (aPlan, aHints) => detectChanges(aPlan, aHints),
    subscribe: subscribeFs(log),
    log,
    setTimer: (aCallback, aDelayMs) => setTimeout(aCallback, aDelayMs),
    clearTimer: (aHandle) => clearTimeout(aHandle as ReturnType<typeof setTimeout>),
    debounceMs: options.debounceMs,
    exitWaitMs: 5000,
  })

  let exiting = false
  const shutdown = (): void => {
    if (exiting) {
      return
    }
    exiting = true
    void watcher.stop().finally(() => process.exit(0))
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
  // Наблюдатель упал или вышел мимо `shutdown` — ребёнок не должен пережить его сиротой.
  process.on("exit", () => {
    const { childPid, childAlive } = watcher.state()
    if (childAlive && childPid !== null && process.platform === "win32") {
      Bun.spawnSync(["taskkill", "/PID", String(childPid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" })
    }
  })

  log(`[dev-watch] watching ${relative(cwd, entryPath) || options.entry}` + (port === null ? "" : ` (port ${port})`))
  watcher.start()
}

if (import.meta.main) {
  runCli()
}
