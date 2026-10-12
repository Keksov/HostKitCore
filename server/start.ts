// GCY1.7 (план gnauralcity, GCY-D29): фабрика старта сервера хоста. Хост (точка входа — у MindWave
// `MindWaveCore/server/server.ts`) готовит свои сессии и сторы и зовёт `startHostServer` с
// конфигурацией: порт, idleTimeout, каталог статики, админ-ручки (каталог UI, перезапуск, свои
// действия) и СПИСОК МОДУЛЕЙ. Каркас не знает ни продукта, ни модулей (GCY-D19): модуль — это три
// необязательные части, HTTP, ws и `dispose`.
//
// Что делает каркас — ровно то, что делал `Bun.serve` в `server.ts` до GCY1.7 (было `:2894-2999`):
//   * `Bun.serve` на `127.0.0.1` (AR1.1, AR-D1: только loopback — весь доступ к файлам машины безопасен
//     лишь за ним), порт и idleTimeout — от хоста (у MindWave idleTimeout 0 — починка F-0026, замок T-42);
//   * `fetch`: upgrade `/ws/ui` (данные сокета `{ kind: "ui", clientIp }`) → админ-ручки
//     `/api/admin/bun-actions*` → HTTP-обработчики модулей ПО ПОРЯДКУ списка (первый не-`null` ответ
//     выигрывает) → статика. Админ-ручки раньше модулей: у хоста бывает общий хвост «нет такой
//     /api-ручки — 404» (у MindWave — `handleApiRequest`), и он съел бы их. До GCY1.7 они стояли
//     внутри `handleApiRequest`; пути у них свои, ни одна другая ручка их не принимает, так что
//     порядок для запроса не изменился;
//   * ws: `open` — подписка на тему `"ui"` (её публикуют модули: `server.publish("ui", …)`), затем
//     `open` модулей по порядку; `message` — текст (Buffer → utf8); эхо живости оболочки (`ui_echo`
//     с непустым `requestId`) каркас отвечает сам, тому же сокету, и модулям не отдаёт (GCY2.2,
//     GCY-D23 — `./ui-echo.ts`); всё прочее — `message` КАЖДОГО модуля (каждый сам решает, его ли
//     это тип; ждём всех); `close` — модулям по порядку;
//   * цепочка останова (`shutdown.ts`): SIGINT/SIGTERM/beforeExit — сразу после `Bun.serve`, как было.
// Возвращает тот же объект `Bun.Server`, что отдал `Bun.serve`, — хосту он нужен для `publish`.

import type { Server, ServerWebSocket, WebSocketHandler } from "bun"

import { createAdminBunActions, type AdminBunActions, type AdminBunActionsConfig } from "./admin"
import { createShutdownChain, registerShutdownHandlers, type ModuleDisposer, type ShutdownChain } from "./shutdown"
import { createStaticHandler } from "./static"
import { uiEchoAckFor } from "./ui-echo"

/** Путь ws-канала оболочки (клиент — `HostKitCore/ui/ws/ws.ts`). */
export const UI_WS_PATH = "/ws/ui"
/** Тема, на которую подписан каждый ws-клиент оболочки; модули публикуют в неё свои события. */
export const UI_WS_TOPIC = "ui"

/** Данные ws-сокета: адрес клиента запоминается при upgrade — модули сужают по нему доступ (loopback). */
export interface HostSocketData {
  readonly kind: "ui"
  readonly clientIp: string | null
}

export type HostServerInstance = Server<HostSocketData>
export type HostSocket = ServerWebSocket<HostSocketData>

export interface HostServerModuleWs {
  open?(aSocket: HostSocket): void
  message?(aSocket: HostSocket, aText: string): void | Promise<void>
  close?(aSocket: HostSocket): void
}

export interface HostServerModule {
  /** Имя для диагностики. */
  readonly name: string
  /** HTTP: ответ, или `null` — «не моё», запрос идёт следующему модулю, затем статике. */
  readonly fetch?: (aRequest: Request, aServer: HostServerInstance) => Response | null | Promise<Response | null>
  readonly ws?: HostServerModuleWs
  /** Уборка при останове (цепочка `shutdown.ts`, по порядку списка модулей). */
  readonly dispose?: ModuleDisposer
}

export interface HostServerConfig {
  readonly port: number
  /** Секунды; 0 — таймаут отключён. */
  readonly idleTimeout: number
  /** Каталог собранного UI (абсолютный). */
  readonly publicDir: string
  readonly admin: AdminBunActionsConfig
  readonly modules: readonly HostServerModule[]
}

export interface HostServer {
  readonly server: HostServerInstance
  readonly shutdown: ShutdownChain
}

export interface HostFetchParts {
  readonly admin: Pick<AdminBunActions, "handleRequest">
  readonly modules: readonly HostServerModule[]
  readonly serveStatic: (aPathname: string) => Promise<Response>
}

/** `fetch` сервера хоста; отдельно от `Bun.serve`, чтобы его порядок проверялся без сокетов. */
export const createHostFetch = (aParts: HostFetchParts) => {
  return async (aRequest: Request, aServer: HostServerInstance): Promise<Response | undefined> => {
    const url = new URL(aRequest.url)

    if (url.pathname === UI_WS_PATH) {
      const ok = aServer.upgrade(aRequest, {
        // AC3.2 (audio-panel-cleanup): remember the client's address so the spectrogram-open handler
        // (which reads whole-machine files via the fs-browser roots) can restrict itself to loopback.
        data: { kind: "ui", clientIp: aServer.requestIP(aRequest)?.address ?? null }
      })
      return ok ? undefined : new Response("WebSocket upgrade failed", { status: 400 })
    }

    const adminResponse = await aParts.admin.handleRequest(aRequest)
    if (adminResponse !== null) {
      return adminResponse
    }

    for (const hostModule of aParts.modules) {
      if (hostModule.fetch === undefined) {
        continue
      }

      const moduleResponse = await hostModule.fetch(aRequest, aServer)
      if (moduleResponse !== null) {
        return moduleResponse
      }
    }

    return aParts.serveStatic(url.pathname)
  }
}

/** ws-обработчик сервера хоста: подписка на тему оболочки и раздача модулям. */
export const createHostWebSocket = (aModules: readonly HostServerModule[]): WebSocketHandler<HostSocketData> => {
  return {
    open(aSocket) {
      aSocket.subscribe(UI_WS_TOPIC)
      for (const hostModule of aModules) {
        hostModule.ws?.open?.(aSocket)
      }
    },
    async message(aSocket, aMessage) {
      const text = typeof aMessage === "string" ? aMessage : Buffer.from(aMessage).toString("utf8")
      // GCY2.2 (GCY-D23): эхо живости оболочки отвечает каркас — тому же сокету, модулям не отдаёт
      // (правило и форма ответа — `./ui-echo.ts`).
      const echoAck = uiEchoAckFor(text)
      if (echoAck !== null) {
        aSocket.send(echoAck)
        return
      }
      await Promise.all(aModules.map((aModule) => aModule.ws?.message?.(aSocket, text)))
    },
    close(aSocket) {
      for (const hostModule of aModules) {
        hostModule.ws?.close?.(aSocket)
      }
    }
  }
}

export const startHostServer = (aConfig: HostServerConfig): HostServer => {
  const shutdown = createShutdownChain(
    aConfig.modules.flatMap((aModule) => (aModule.dispose === undefined ? [] : [aModule.dispose])),
  )
  const admin = createAdminBunActions(aConfig.admin, { exitAfterDispose: shutdown.exitAfterDispose })

  const server = Bun.serve<HostSocketData>({
    port: aConfig.port,
    // access-preset-root AR1.1 (AR-D1): bind loopback-only. The whole-machine file access a host
    // grants is safe behind 127.0.0.1 — no LAN client can reach it. Per-endpoint loopback gates of the
    // modules (`isLoopbackAddress`, ./loopback.ts) stay as defense in depth.
    hostname: "127.0.0.1",
    idleTimeout: aConfig.idleTimeout,
    fetch: createHostFetch({ admin, modules: aConfig.modules, serveStatic: createStaticHandler(aConfig.publicDir) }),
    websocket: createHostWebSocket(aConfig.modules),
  })

  registerShutdownHandlers(shutdown)

  return { server, shutdown }
}
