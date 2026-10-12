// gnauralcity GCY2.2 (GCY-D23, GCY-D29): ЭХО ЖИВОСТИ КАНАЛА ОБОЛОЧКИ — серверная половина. Клиентская
// живёт в `HostKitCore/ui/ws/ws.ts` (часы живости шлют `ui_echo { requestId }` и гаснут на
// `ui_echo_ack` с тем же `requestId`). Это служебное сообщение ОБОЛОЧКИ, а не протокол модуля, — и
// отвечает на него каркас (`createHostWebSocket`, `./start.ts`), чтобы канал был жив у любого хоста,
// даже без единого модуля (Gnauralcity до GCY3.8). До GCY2.2 отвечал хост MindWave
// (`MindWaveCore/server/ui-ws-handler.ts`, ветка LC3.1a); форма ответа перенесена побайтно.
//
// Правило решения (LC-D13, прежде — `isBrowserMessage` из `SharedPasCore/ts/protocol.ts`): эхо — это
// JSON-объект с `type === "ui_echo"` и НЕПУСТЫМ строковым `requestId` (пустой не отличить от
// отсутствующего, а на нём держится вся корреляция «наш запрос — наш ответ»). Только такое сообщение
// каркас отвечает сам и модулям не отдаёт. Всё прочее — и битый JSON, и `ui_echo` без годного
// `requestId` — уходит модулям как раньше: у MindWave такое по-прежнему даёт `invalid-message` и
// `bodymonitor_error «Unknown browser message type»` (замок T-83, S7).
//
// Ответ — ТОМУ ЖЕ сокету (`send`, не `publish`): чужое окно ответа с нашим `requestId` получить не
// может. Работы никакой и строки в лог нет: клиент шлёт эхо на каждую отвечаемую команду, а сведений
// сверх «канал жив» в нём нет (LC-D11).

/** Ответ каркаса на эхо живости: тому же сокету, с тем же `requestId`. */
export interface UiEchoAck {
  readonly type: "ui_echo_ack"
  readonly requestId: string
}

/**
 * Текст ответа, если `aText` — эхо живости оболочки; иначе `null` (текст идёт модулям). Порядок ключей
 * ответа — `type`, затем `requestId`: ровно тот JSON, что слал прежний ответчик MindWave.
 */
export const uiEchoAckFor = (aText: string): string | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(aText)
  } catch {
    return null
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null
  }

  const message = parsed as { readonly type?: unknown; readonly requestId?: unknown }
  if (message.type !== "ui_echo" || typeof message.requestId !== "string" || message.requestId === "") {
    return null
  }

  const ack: UiEchoAck = { type: "ui_echo_ack", requestId: message.requestId }
  return JSON.stringify(ack)
}
