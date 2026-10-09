// GCY1.7 (план gnauralcity, GCY-D29): админ-ручки «Bun-действий» каркаса — `/api/admin/bun-actions`.
// Перенесены из `MindWaveCore/server/server.ts` (были `:1013-1077`, `:1132-1183`, `:1203-1249`,
// `:1489-1527` и маршруты `:2298-2344`); тела функций побайтно, кроме трёх мест, названных ниже.
// Клиент — оболочка (`HostKitCore/ui/shell/admin-api.ts`, диалог «Действия Bun»).
//
// Ручки (поведение прежнее — тексты, коды, порядок, тело ответа):
//   * GET  /api/admin/bun-actions             → `{ canRestartBun, restartBunReason, isWatchMode }`;
//   * POST /api/admin/bun-actions             → тело `{ buildUi?, restartBun?, <расширения хоста>? }`;
//     порядок исполнения: build-ui → расширения хоста (в порядке их списка) → restart-bun; ответ
//     `{ completed, scheduled }`, 202 при restart-bun, иначе 200; ошибка — 500 с её текстом;
//   * POST /api/admin/bun-actions/build-ui    → `bun run build` в каталоге UI хоста; ошибка — 500;
//   * POST /api/admin/bun-actions/<route>     → расширение хоста (у MindWave — `restart-exe`);
//   * POST /api/admin/bun-actions/restart-bun → 202 `scheduled`; заблокировано — 409 с причиной;
//   * иное действие — 404 «API route not found», иной метод — 405.
//
// Что изменилось против переноса:
//   1) каталог UI, точка входа и каталог перезапуска — от хоста (`AdminBunActionsConfig`), а не
//      глобалы `uiDir`/`hostDir`/литерал `server.ts`;
//   2) выход после перезапуска — через цепочку останова каркаса (`shutdown.ts`), а не
//      `exitAfterAudioDispose(0)` хоста; это та же уборка (dispose модулей) и тот же `exit(0)`;
//   3) расширения хоста (GCY-D29: «с расширением от хоста»): MindWave передаёт `restart-exe`
//      (BodyMonitor.exe), каркас его не знает. Блокировка `restart-bun` — и под наблюдателем
//      HostKitCore (`watch-mode.ts`), не только под `bun --watch`.

import { spawn } from "node:child_process"

import { errorResponse, jsonResponse, parseJsonBody } from "./http"
import { isBunWatchMode, isDevWatcherChild } from "./watch-mode"

const ADMIN_COMMAND_OUTPUT_LIMIT = 4000
const BUN_RESTART_DELAY_SEC = 2

export type AdminBunActionState = "completed" | "scheduled"

/** Ответ действия; имя — `build_ui`, `restart_bun` или имя действия хоста (`restart_exe`). */
export interface AdminBunActionResponse {
  readonly action: string
  readonly status: AdminBunActionState
}

export interface AdminBunActionStatusResponse {
  readonly canRestartBun: boolean
  readonly restartBunReason: string | null
  readonly isWatchMode: boolean
}

/** Действие хоста сверх встроенных (у MindWave — перезапуск BodyMonitor.exe). */
export interface AdminBunActionExtension {
  /** Поле тела `POST /api/admin/bun-actions`, включающее действие (`restartExe`). */
  readonly bodyKey: string
  /** Хвост пути отдельной ручки `POST /api/admin/bun-actions/<route>` (`restart-exe`). */
  readonly route: string
  readonly run: () => Promise<AdminBunActionResponse>
  /** Текст ошибки отдельной ручки, когда брошено не `Error`. */
  readonly fallbackError: string
  /** Код ответа отдельной ручки по тексту ошибки; без него — 500. */
  readonly errorStatus?: (aMessage: string) => number
}

export interface AdminBunActionsConfig {
  /** Каталог UI хоста — там `bun run build` (абсолютный). */
  readonly uiDir: string
  /** Чем поднять сервер заново: `<bun> run <entry>` в каталоге `cwd` (у MindWave — `server.ts` в `server/`). */
  readonly restart: { readonly cwd: string; readonly entry: string }
  readonly extensions?: readonly AdminBunActionExtension[]
}

/** Внешний мир админ-ручек; тест подставляет свой, чтобы не порождать процессов. */
export interface AdminBunActionsDeps {
  /** Уборка модулей и выход — цепочка останова каркаса. */
  readonly exitAfterDispose: (aExitCode: number) => void
  readonly runBunCommand?: (aArgs: readonly string[], aCwd: string) => Promise<{ readonly exitCode: number | null; readonly output: string }>
  /** Породить отсоединённый перезапуск (без выхода — выход планирует сама ручка). */
  readonly spawnDetachedRestart?: (aCwd: string, aEntry: string) => void
  readonly getBlockedReason?: () => string | null
  readonly isWatchMode?: () => boolean
  readonly schedule?: (aCallback: () => void, aDelayMs: number) => void
}

export interface AdminBunActions {
  /** Ответ на запрос к `/api/admin/bun-actions[/…]`; `null` — запрос не к админ-ручкам. */
  handleRequest(aRequest: Request): Promise<Response | null>
  getStatus(): AdminBunActionStatusResponse
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null
}

const trimCommandOutput = (aValue: string): string => {
  const normalized = aValue.trim()
  if (normalized.length <= ADMIN_COMMAND_OUTPUT_LIMIT) {
    return normalized
  }

  return normalized.slice(normalized.length - ADMIN_COMMAND_OUTPUT_LIMIT)
}

const collectCommandOutput = (aStdout: string, aStderr: string): string => {
  return trimCommandOutput([aStdout, aStderr].filter((value) => value.trim() !== "").join("\n"))
}

const runBunCommand = async (aArgs: readonly string[], aCwd: string): Promise<{
  readonly exitCode: number | null
  readonly output: string
}> => {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, aArgs, {
      cwd: aCwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })

    let stdout = ""
    let stderr = ""

    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk
    })

    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk
    })

    child.once("error", (error) => {
      rejectPromise(error)
    })

    child.once("close", (code) => {
      resolvePromise({
        exitCode: code,
        output: collectCommandOutput(stdout, stderr),
      })
    })
  })
}

const getRestartBunBlockedReason = (): string | null => {
  if (isBunWatchMode()) {
    return "Restart bun is disabled while the server is running with --watch"
  }

  return isDevWatcherChild()
    ? "Restart bun is disabled while the server is running under the dev watcher (it restarts the server on edits itself)"
    : null
}

/** Отсоединённый перезапуск: через `BUN_RESTART_DELAY_SEC` секунд `<bun> run <entry>` в `aCwd`. */
const spawnDetachedServerRestart = (aCwd: string, aEntry: string): void => {
  const bunExecutablePath = process.execPath

  if (process.platform === "win32") {
    const child = spawn("cmd.exe", [
      "/d",
      "/s",
      "/c",
      `timeout /t ${BUN_RESTART_DELAY_SEC} /nobreak >nul && "${bunExecutablePath}" run ${aEntry}`,
    ], {
      cwd: aCwd,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    })
    child.unref()
  } else {
    const escapedExecutablePath = bunExecutablePath.replace(/'/gu, `'\\''`)
    const child = spawn("sh", [
      "-lc",
      `sleep ${BUN_RESTART_DELAY_SEC} && exec '${escapedExecutablePath}' run ${aEntry}`,
    ], {
      cwd: aCwd,
      detached: true,
      stdio: "ignore",
    })
    child.unref()
  }
}

const RESERVED_ROUTES = new Set(["build-ui", "restart-bun"])
const RESERVED_BODY_KEYS = new Set(["buildUi", "restartBun"])

export const createAdminBunActions = (aConfig: AdminBunActionsConfig, aDeps: AdminBunActionsDeps): AdminBunActions => {
  const extensions = aConfig.extensions ?? []
  for (const extension of extensions) {
    if (RESERVED_ROUTES.has(extension.route) || RESERVED_BODY_KEYS.has(extension.bodyKey)) {
      throw new Error(`admin action extension "${extension.route}" (${extension.bodyKey}) clashes with a built-in action`)
    }
  }
  if (new Set(extensions.map((aExtension) => aExtension.route)).size !== extensions.length
    || new Set(extensions.map((aExtension) => aExtension.bodyKey)).size !== extensions.length) {
    throw new Error("admin action extensions must have distinct routes and body keys")
  }

  const runCommand = aDeps.runBunCommand ?? runBunCommand
  const spawnRestart = aDeps.spawnDetachedRestart ?? spawnDetachedServerRestart
  const blockedReason = aDeps.getBlockedReason ?? getRestartBunBlockedReason
  const watchMode = aDeps.isWatchMode ?? (() => isBunWatchMode() || isDevWatcherChild())
  const schedule = aDeps.schedule ?? ((aCallback: () => void, aDelayMs: number) => {
    setTimeout(aCallback, aDelayMs)
  })

  const getAdminBunActionStatus = (): AdminBunActionStatusResponse => {
    const restartBunReason = blockedReason()

    return {
      canRestartBun: restartBunReason === null,
      restartBunReason,
      isWatchMode: watchMode(),
    }
  }

  const executeBuildUiAction = async (): Promise<AdminBunActionResponse> => {
    const buildResult = await runCommand(["run", "build"], aConfig.uiDir)
    if (buildResult.exitCode !== 0) {
      throw new Error(
        buildResult.output === ""
          ? `UI build failed with exit code ${buildResult.exitCode ?? -1}`
          : buildResult.output,
      )
    }

    return {
      action: "build_ui",
      status: "completed",
    }
  }

  const scheduleDetachedServerRestart = (): void => {
    spawnRestart(aConfig.restart.cwd, aConfig.restart.entry)

    schedule(() => {
      aDeps.exitAfterDispose(0)
    }, 50)
  }

  const executeRestartBunAction = (): AdminBunActionResponse => {
    const blockedReasonText = blockedReason()
    if (blockedReasonText !== null) {
      throw new Error(blockedReasonText)
    }

    scheduleDetachedServerRestart()

    return {
      action: "restart_bun",
      status: "scheduled",
    }
  }

  const executeAdminBunActions = async (aRequest: Request): Promise<Response> => {
    try {
      const body = await parseJsonBody(aRequest)
      if (!isRecord(body)) {
        return errorResponse(400, "Invalid admin action payload")
      }

      const buildUi = body.buildUi === true
      const restartBun = body.restartBun === true
      const selectedExtensions = extensions.filter((aExtension) => body[aExtension.bodyKey] === true)

      if (!buildUi && !restartBun && selectedExtensions.length === 0) {
        return errorResponse(400, "At least one admin action must be selected")
      }

      const completed: string[] = []
      const scheduled: string[] = []

      if (buildUi) {
        completed.push((await executeBuildUiAction()).action)
      }

      for (const extension of selectedExtensions) {
        completed.push((await extension.run()).action)
      }

      if (restartBun) {
        scheduled.push(executeRestartBunAction().action)
      }

      return jsonResponse({
        completed,
        scheduled,
      }, restartBun ? 202 : 200)
    } catch (error) {
      const message = error instanceof Error ? error.message : "Admin action failed"
      return errorResponse(500, message)
    }
  }

  const handleRequest = async (aRequest: Request): Promise<Response | null> => {
    const url = new URL(aRequest.url)
    const segments = url.pathname.split("/").filter(Boolean)

    if (segments[0] !== "api") {
      return null
    }

    if (segments.length === 3 && segments[1] === "admin" && segments[2] === "bun-actions") {
      if (aRequest.method === "GET") {
        return jsonResponse(getAdminBunActionStatus())
      }

      if (aRequest.method !== "POST") {
        return errorResponse(405, "Method not allowed")
      }

      return executeAdminBunActions(aRequest)
    }

    if (segments.length === 4 && segments[1] === "admin" && segments[2] === "bun-actions") {
      if (aRequest.method !== "POST") {
        return errorResponse(405, "Method not allowed")
      }

      if (segments[3] === "build-ui") {
        try {
          return jsonResponse(await executeBuildUiAction())
        } catch (error) {
          const message = error instanceof Error ? error.message : "UI build failed"
          return errorResponse(500, message)
        }
      }

      for (const extension of extensions) {
        if (segments[3] === extension.route) {
          try {
            return jsonResponse(await extension.run())
          } catch (error) {
            const message = error instanceof Error ? error.message : extension.fallbackError
            const status = extension.errorStatus?.(message) ?? 500
            return errorResponse(status, message)
          }
        }
      }

      if (segments[3] === "restart-bun") {
        try {
          return jsonResponse(executeRestartBunAction(), 202)
        } catch (error) {
          const message = error instanceof Error ? error.message : "Bun restart failed"
          return errorResponse(409, message)
        }
      }

      return errorResponse(404, "API route not found")
    }

    return null
  }

  return {
    handleRequest,
    getStatus: getAdminBunActionStatus,
  }
}
