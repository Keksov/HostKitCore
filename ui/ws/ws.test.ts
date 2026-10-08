// GCY1.4 (план gnauralcity, GCY-D29): замки точек регистрации ws-транспорта оболочки (ws.ts) —
// того, что модули теперь кладут в транспорт сами, вместо зашитого в нём аудио-знания:
//   (а) отправка ЗАРЕГИСТРИРОВАННОГО отвечаемого типа заводит часы живости (уходит `ui_echo`),
//       незарегистрированного — нет; `ui_echo` зарегистрировать нельзя;
//   (б) сообщение с зарегистрированным префиксом уходит всем подписчикам канала и НЕ попадает в
//       `registerHandler`-обработчики (и без подписчиков тоже не попадает — канал живёт с регистрации);
//   (в) `dispatch` останавливается на первом `true` в порядке регистрации; повторная регистрация той
//       же функции её места не меняет (на этом держится идемпотентность установки плагинов).
//
// ИЗОЛЯЦИЯ. Транспорт — синглтон с состоянием модуля (сокет, обработчики, реестры), а bun гоняет все
// тестовые файлы прогона в одном процессе с общим кэшем модулей. Поэтому каждый тест берёт СВОЙ
// экземпляр модуля (`import('./ws.ts?case=N')` — bun считает адрес с другим запросом отдельным
// модулем), и общий экземпляр, который получил бы соседний файл, не трогается вовсе. Глобалы,
// которые транспорт читает в момент вызова (`WebSocket`, `location`, `setTimeout`/`clearTimeout`),
// подменяются на тест и возвращаются после; таймеры транспорта считаются, и тест обязан закончить
// без живых (часы погашены эхо-ответом; события `close` фейк не шлёт — переподключения не заводится).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

type WsModule = typeof import('./ws')

type Listener = (event: unknown) => void

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.CONNECTING
  readonly sent: Array<{ readonly type: string; readonly [key: string]: unknown }> = []
  private readonly listeners = new Map<string, Listener[]>()

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  addEventListener(aType: string, aListener: Listener): void {
    const list = this.listeners.get(aType) ?? []
    list.push(aListener)
    this.listeners.set(aType, list)
  }

  send(aData: string): void {
    this.sent.push(JSON.parse(aData) as { readonly type: string })
  }

  close(): void {
    // Нарочно без события `close`: оно завело бы таймер переподключения, переживший бы тест.
  }

  fireOpen(): void {
    this.readyState = FakeWebSocket.OPEN
    for (const listener of this.listeners.get('open') ?? []) listener({})
  }

  receive(aMessage: { readonly type: string; readonly [key: string]: unknown }): void {
    for (const listener of this.listeners.get('message') ?? []) listener({ data: JSON.stringify(aMessage) })
  }
}

const realWebSocket = globalThis.WebSocket
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const hadLocation = Object.prototype.hasOwnProperty.call(globalThis, 'location')
const realLocation: unknown = hadLocation ? (globalThis as { location?: unknown }).location : undefined

/** Таймеры, заведённые за тест и ещё не сработавшие/не снятые. */
const liveTimers = new Set<unknown>()
let caseCounter = 0

beforeEach(() => {
  FakeWebSocket.instances = []
  liveTimers.clear()
  ;(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket
  Object.defineProperty(globalThis, 'location', {
    value: { protocol: 'http:', host: 'hostkit-ws-test.invalid' },
    configurable: true,
    writable: true,
  })
  ;(globalThis as { setTimeout: unknown }).setTimeout = (aCallback: () => void, aMs?: number): unknown => {
    const id: unknown = realSetTimeout(() => {
      liveTimers.delete(id)
      aCallback()
    }, aMs)
    liveTimers.add(id)
    return id
  }
  ;(globalThis as { clearTimeout: unknown }).clearTimeout = (aId: unknown): void => {
    liveTimers.delete(aId)
    realClearTimeout(aId as Parameters<typeof clearTimeout>[0])
  }
})

afterEach(() => {
  // Сначала снимаем всё, что вдруг осталось (упавший тест), — потом возвращаем глобалы.
  for (const id of liveTimers) realClearTimeout(id as Parameters<typeof clearTimeout>[0])
  liveTimers.clear()
  ;(globalThis as { WebSocket: unknown }).WebSocket = realWebSocket
  ;(globalThis as { setTimeout: unknown }).setTimeout = realSetTimeout
  ;(globalThis as { clearTimeout: unknown }).clearTimeout = realClearTimeout
  if (hadLocation) {
    Object.defineProperty(globalThis, 'location', { value: realLocation, configurable: true, writable: true })
  } else {
    delete (globalThis as { location?: unknown }).location
  }
})

/** Свой экземпляр модуля транспорта на тест — общий не трогается (см. «ИЗОЛЯЦИЯ»). */
async function freshTransport(): Promise<WsModule['wsService']> {
  caseCounter += 1
  const specifier = `./ws.ts?case=${caseCounter}`
  const module = (await import(specifier)) as WsModule
  return module.wsService
}

/** Подключает экземпляр к фейковому сокету и открывает его. */
function connect(aTransport: WsModule['wsService']): FakeWebSocket {
  aTransport.init()
  const socket = FakeWebSocket.instances.at(-1)
  if (socket === undefined) throw new Error('transport did not open a socket')
  expect(socket.url).toBe('ws://hostkit-ws-test.invalid/ws/ui')
  socket.fireOpen()
  expect(aTransport.connectionState.value).toBe('connected')
  return socket
}

describe('ws transport (GCY1.4): answered types arm the liveness clock', () => {
  test('a registered answered type sends ui_echo and arms the clock; an unregistered one does not', async () => {
    const transport = await freshTransport()
    transport.registerAnsweredTypes(['test_answered'])
    const socket = connect(transport)

    expect(transport.send({ type: 'test_plain' })).toBe(true)
    expect(socket.sent.map((m) => m.type)).toEqual(['test_plain'])
    expect(liveTimers.size).toBe(0)

    expect(transport.send({ type: 'test_answered' })).toBe(true)
    expect(socket.sent.map((m) => m.type)).toEqual(['test_plain', 'test_answered', 'ui_echo'])
    expect(liveTimers.size).toBe(1)

    // Ответ на НАШЕ эхо гасит часы — тест кончается без живых таймеров.
    const echo = socket.sent[2]!
    expect(typeof echo['requestId']).toBe('string')
    socket.receive({ type: 'ui_echo_ack', requestId: echo['requestId'] })
    expect(liveTimers.size).toBe(0)
  })

  test('the registry starts empty: nothing arms the clock until a module registers it', async () => {
    const transport = await freshTransport()
    const socket = connect(transport)

    // До GCY1.4 это была постоянная часть транспорта; теперь — только то, что зарегистрировано.
    expect(transport.send({ type: 'audio_stop' })).toBe(true)
    expect(socket.sent.map((m) => m.type)).toEqual(['audio_stop'])
    expect(liveTimers.size).toBe(0)
  })

  test("'ui_echo' is refused as an answered type, and nothing from that call is registered", async () => {
    const transport = await freshTransport()
    expect(() => transport.registerAnsweredTypes(['test_answered', 'ui_echo'])).toThrow()
    const socket = connect(transport)

    expect(transport.send({ type: 'test_answered' })).toBe(true)
    expect(socket.sent.map((m) => m.type)).toEqual(['test_answered'])
    expect(liveTimers.size).toBe(0)
  })
})

describe('ws transport (GCY1.4): prefix channels multicast past dispatch', () => {
  test('a prefixed message reaches every channel subscriber and no registerHandler handler', async () => {
    const transport = await freshTransport()
    const channel = transport.registerPrefixChannel('test-pfx:')
    const first: string[] = []
    const second: string[] = []
    const handled: string[] = []
    const offFirst = channel.subscribe((m) => { first.push(m.type) })
    const offSecond = channel.subscribe((m) => { second.push(m.type) })
    transport.registerHandler((event) => {
      handled.push(event.type)
      return false
    })
    const socket = connect(transport)

    socket.receive({ type: 'test-pfx:one' })
    socket.receive({ type: 'plain' })
    expect(first).toEqual(['test-pfx:one'])
    expect(second).toEqual(['test-pfx:one'])
    expect(handled).toEqual(['plain'])

    // Без подписчиков сообщение канала пропадает, а не проваливается в обработчики.
    offFirst()
    offSecond()
    socket.receive({ type: 'test-pfx:two' })
    expect(first).toEqual(['test-pfx:one'])
    expect(second).toEqual(['test-pfx:one'])
    expect(handled).toEqual(['plain'])
  })

  test('registering the same prefix again returns the same channel (same subscribers)', async () => {
    const transport = await freshTransport()
    const seen: string[] = []
    transport.registerPrefixChannel('test-pfx:').subscribe((m) => { seen.push(m.type) })
    const again = transport.registerPrefixChannel('test-pfx:')
    expect(again.prefix).toBe('test-pfx:')
    const socket = connect(transport)

    socket.receive({ type: 'test-pfx:x' })
    expect(seen).toEqual(['test-pfx:x'])
  })
})

describe('ws transport: dispatch', () => {
  test('stops at the first handler returning true, in registration order; re-registering keeps the place', async () => {
    const transport = await freshTransport()
    const calls: string[] = []
    const first = (): boolean => {
      calls.push('first')
      return false
    }
    transport.registerHandler(first)
    transport.registerHandler(() => {
      calls.push('second')
      return true
    })
    transport.registerHandler(() => {
      calls.push('third')
      return true
    })
    // Повторная регистрация той же функции — no-op: `first` остаётся первым, а не уезжает в конец.
    transport.registerHandler(first)
    const socket = connect(transport)

    socket.receive({ type: 'any' })
    expect(calls).toEqual(['first', 'second'])
  })
})
