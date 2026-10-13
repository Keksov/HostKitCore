import { ref, type Ref } from 'vue'

import type { UiEchoRequest } from '../../server/ui-echo'

// ── GCY1.4 (план gnauralcity, GCY-D29/GCY-D2): ТРАНСПОРТ ОБОЛОЧКИ, БЕЗ ЗНАНИЯ ПРОТОКОЛОВ МОДУЛЕЙ ──────
//
// Файл переехал из `MindWaveCore/ui/services/ws.ts` побайтно (sha256 сверен) и только потом правлен:
// из него ушло то, что знало протоколы модулей, — список «отвечаемых» аудио-команд, маршрут
// `spectrogram:*` и пара `sendSpectrogram/onSpectrogram`. Вместо них — две точки регистрации:
// `registerAnsweredTypes` (какие команды заводят часы живости) и `registerPrefixChannel` (какие
// сообщения идут всем подписчикам мимо `dispatch`). Регистрирует модуль, при установке своего
// плагина; в MindWave это делает GnauralCore (`GnauralCore/ui/plugin.ts`, `ws-routes.ts`).
// Поведение не менялось: те же четыре типа, тот же префикс, тот же порядок разбора сообщения.
//
// Остались здесь (оболочка, GCY-D23): эхо живости `ui_echo`/`ui_echo_ack`, часы живости,
// переподключение, `dispatch` до первого `true`, адрес `/ws/ui`.
//
// ТИПЫ. Транспорт знает о сообщении только поле `type`. Протокол — у потребителя, с двух сторон:
//   * исходящие — потребитель смотрит на тот же объект через `WsTransport<МоиИсходящие>`, и его
//     `send` сверяется с его протоколом (присваивание `WsTransport` → `WsTransport<…>` проходит без
//     приведения: `send` — метод, а сужение принимаемого параметра для отправки безопасно);
//   * входящие — `registerHandler` и `subscribe` ОБОБЩЁННЫЕ: обработчик сам называет форму, которую
//     ждёт. Это не проверка, а объявление: формы входящего транспорт не проверяет — ровно как и до
//     переезда, где разобранный JSON просто объявлялся `ServerEvent`.

/** Любое сообщение канала: транспорт видит у него только `type`. */
export interface WsMessage {
  readonly type: string
}

export type ConnectionState = 'connecting' | 'connected' | 'disconnected'
export type WsEventHandler<TEvent extends WsMessage = WsMessage> = (event: TEvent) => boolean | void

/**
 * Префиксный канал: каждое входящее сообщение, чей `type` начинается с префикса канала, уходит ВСЕМ
 * подписчикам и НЕ попадает в `registerHandler`-обработчики. Канал живёт с момента регистрации, а не
 * с первой подписки: сообщение с префиксом, пришедшее, когда подписчиков нет, пропадает, а не
 * проваливается в `dispatch` (так было и до GCY1.4 — у `spectrogram:*`).
 */
export interface WsPrefixChannel {
  readonly prefix: string
  /** `TMessage` — форма, которую ждёт подписчик (не проверяется, см. «ТИПЫ» выше). */
  subscribe<TMessage extends WsMessage = WsMessage>(handler: (message: TMessage) => void): () => void
}

/**
 * Весь API транспорта. Объект этого типа — один на приложение (`wsService` в конце файла); модули
 * получают его от хоста через свой плагин (`createGnauralPlugin({ ws })` и т. п.).
 */
export interface WsTransport<TOut extends WsMessage = WsMessage> {
  readonly connectionState: Ref<ConnectionState>
  /** `TEvent` — форма, которую ждёт обработчик (не проверяется, см. «ТИПЫ» выше). */
  registerHandler<TEvent extends WsMessage = WsMessage>(handler: WsEventHandler<TEvent>): () => void
  send(message: TOut): boolean
  sendUiEcho(requestId: string): boolean
  watchChannelLiveness(): void
  registerAnsweredTypes(types: Iterable<string>): void
  registerPrefixChannel(prefix: string): WsPrefixChannel
  init(): void
}

// LC3.1a (LC-D13): эхо живости канала — служебное сообщение оболочки, а не протокол модуля. Форма
// (`UiEchoRequest`) с GCY3.1 объявлена один раз — рядом с ответчиком каркаса, `../../server/ui-echo.ts`
// (импорт только типа: в сборку интерфейса серверный файл не попадает).

const MAX_RECONNECT_MS = 10_000
const BASE_RECONNECT_MS = 1_000

// ── FSC3.2a (план file-selection-command, решение FSC-D9) — ПРИЗНАК ЖИВОСТИ КАНАЛА ─────────────
//
// ЗАЧЕМ ОН ВООБЩЕ ПОЯВИЛСЯ. Фаза 1 плана доказала замером (FSC1.1): у клиента НЕ БЫЛО НИ ОДНОГО
// способа узнать, что канал умер. `send()` вернул `true` 19 раз из 19 за 150 с по каналу, куда не
// доехало ни байта; события `close` не наступило ни разу; `scheduleReconnect` живёт только внутри
// обработчика `close`, поэтому переподключения не было бы вовсе; сервер не шлёт ping (idleTimeout:
// 0 — НАМЕРЕННОЕ решение по F-0026 «зомби idle-сокеты», трогать его нельзя); `connectionState` всё
// это время показывал `connected`. Это и есть корень F-0043: команда уходит в пустоту, и никто об
// этом не узнаёт.
//
// КАК УСТРОЕНО. Никакого своего ping: сервер на него не отвечает, а править сервер этот шаг не
// может. Вместо этого используется то, что УЖЕ ЕСТЬ: часть команд сервер гарантированно чем-нибудь
// отвечает. Отправили такую команду — включили часы. Пришло ЛЮБОЕ сообщение с сервера — часы
// сброшены (канал жив, что бы там ни было). Часы дотикали — канал объявляется мёртвым.
//
// ── GCY1.4: КАКИЕ КОМАНДЫ ЗАВОДЯТ ЧАСЫ — РЕШАЕТ МОДУЛЬ, А НЕ ТРАНСПОРТ ──────────────────────────
//
// Часы заводит отправка через `send()` сообщения, чей тип зарегистрирован как «отвечаемый»
// (`registerAnsweredTypes`). До GCY1.4 здесь стоял постоянный список из четырёх аудио-команд
// (`ANSWERED_MESSAGE_TYPES`); он переехал к своему владельцу вместе с обоснованием состава. ПОЧЕМУ
// ИМЕННО ЭТИ ЧЕТЫРЕ (замер), почему без собственного замера список не расширяется (LC-D7) и во что
// обходится каждое взведение (одно `ui_echo`, LC-D13 п.4) — читать в `GnauralCore/ui/ws-routes.ts`,
// ПРЕЖДЕ чем регистрировать новый тип из любого модуля. Механизм от переезда не изменился: тип либо
// в реестре, либо нет, и `send()` сверяется с реестром в момент отправки. Регистрация идёт при
// установке плагинов (boot), то есть раньше первой отправки.
//
// `ui_echo` зарегистрировать НЕЛЬЗЯ — `registerAnsweredTypes` бросает. Эхо само уходит через `send()`
// из `startDeadChannelWatch`, и «отвечаемое» эхо заводило бы часы, которые шлют эхо, которое заводит
// часы, — бесконечная рекурсия раньше, чем часы успеют взвестись (см. комментарий у `sendUiEcho`).
const answeredMessageTypes = new Set<string>()

/**
 * СРОК, ПОСЛЕ КОТОРОГО МОЛЧАНИЕ СЧИТАЕТСЯ СМЕРТЬЮ КАНАЛА.
 *
 * ОБОСНОВАНИЕ ПЕРЕПИСАНО НА ШАГЕ FSC3.6: рецензент (FSC4.1, вопрос 1) разобрал прежнее и показал,
 * что оно складное, но не выдерживает проверки. Число оставлено — оно безопасно, — а объяснение
 * теперь честное. Что было неверно:
 *   1. прежний текст ссылался на комментарий `gnaural-session.ts:255`, которого НЕТ в
 *      закоммиченном дереве: он живёт только в незакоммиченной рабочей копии параллельной сессии.
 *      Ссылка была непроверяемой, и я её убрал;
 *   2. «самый долгий ИЗМЕРЕННЫЙ случай» — неправда. Первичная запись замера: «4912 мс, ДВАЖДЫ не
 *      дождались за 8000 мс». Значит 4912 — самый долгий ДОСЧИТАННЫЙ, а два наблюдения были
 *      ДЛИННЕЕ и оборваны по потолку. Порог стоит НИЖЕ двух наблюдавшихся;
 *   3. и главное — то обоснование относилось не к этим часам. Залипание `listRoots()` живёт в
 *      обработчике `audio_start`, а часы заводят ТОЛЬКО четыре команды из ANSWERED_MESSAGE_TYPES
 *      (с GCY1.4 — реестр `registerAnsweredTypes`; GnauralCore кладёт в него те же четыре).
 *
 * ── LC4.1: ОБОСНОВАНИЕ ПЕРЕПИСАНО ВТОРОЙ РАЗ, И ПО ТОЙ ЖЕ ПРИЧИНЕ, ЧТО ПЕРВЫЙ. ────────────────
 *
 * Рецензент (LC4.1, вопрос 5) заметил то, чего не заметил никто из чинивших: `git diff` за всю
 * починку не изменил в этом блоке НИ ОДНОЙ строки, а между тем блок аргументировал ЧУЖОЙ теперь
 * величиной. Он объяснял, почему срок безопасен, откликом сервера на четыре команды
 * `audio_stop/pause/resume/seek` — но после LC3.2 эти команды часы БОЛЬШЕ НЕ ГАСЯТ. Гасит только
 * `ui_echo_ack`, и значит срок сторожит оборот эха, а не отклик на команду. Текст остался верным
 * про мир, которого больше нет; ровно так же в родительском плане пережило починку неверное
 * происхождение самого числа.
 *
 * ПОЧЕМУ ЧИСЛО ВСЁ РАВНО БЕЗОПАСНО — ТЕПЕРЬ ПРО ТО, ЧТО ДЕЙСТВИТЕЛЬНО ГАСИТ ЧАСЫ:
 *   * обработчик `ui_echo` на сервере не делает НИКАКОЙ работы — принял и ответил тому же сокету
 *     (`ui-ws-handler.ts`); ни файловой системы, ни движка, ни очереди на его пути нет;
 *   * ветка эха стоит ПЕРВОЙ в разборе сообщения — до `replayManager.isActive()` и до записи в
 *     архив, то есть чужая работа её не задерживает;
 *   * ОБОРОТ ЭХА ИЗМЕРЕН ПОД НАСТОЯЩИМ ФОНОМ (LC4.1): медиана 14 мс, худший 35 мс — при играющем
 *     движке и живой спектрограмме, то есть в 30 раз хуже, чем 1.2 мс на пустой сессии (LC3.1a).
 *     До срока 4912 мс запас 140-кратный;
 *   * залипший `audio_start` эху не мешает: Bun не сериализует сообщения вебсокета за ждущим
 *     обработчиком (измерено в родительском плане: медленный обработчик держал 3000 мс, ответ на
 *     быстрое сообщение пришёл через 31 мс; рецензент независимо получил 2 мс против 3000).
 *
 * ЧТО ИЗ ЭТОГО СЛЕДУЕТ ЧЕСТНО: 4912 мс теперь ЗАВЕДОМО С ИЗБЫТКОМ — оно унаследовано, а не
 * выведено из оборота эха. Число НЕ ТРОГАЕМ (решение LC-D5 и слово владельца: подогнанные числа
 * отвергаются, менять только с собственным замером происхождения), но знать про избыток надо: он
 * означает, что окно расхождения на мёртвом канале ~5 с, хотя механизм позволил бы меньше.
 *
 * ЦЕНА ЛОЖНОГО СРАБАТЫВАНИЯ — ОДНО ЛИШНЕЕ ПЕРЕПОДКЛЮЧЕНИЕ, а не потеря данных: клиент закроет
 * живой сокет, тут же поднимет новый, снимок вернёт состояние, а долг остановки (если он был)
 * доедет. Поэтому «запас» здесь и не нужен: важна не точность порога, а то, что промах дёшев.
 *
 * Цена НЕсрабатывания названа прямо: на мёртвом канале расхождение живёт эти ~5 с — против
 * «неограниченно», как было измерено до починки (FSC1.1).
 *
 * Менять число можно, но не на глазок: нижняя граница — измеренный отклик (1-107 мс), верхняя —
 * терпимость пользователя к окну расхождения. Подгонять его под красивое нельзя.
 */
const DEAD_CHANNEL_SILENCE_MS = 4912

const connectionState: Ref<ConnectionState> = ref('disconnected')
const eventHandlers = new Set<WsEventHandler>()
// Prefix-channel messages are multicast to ALL subscribers. The single-consumer `dispatch`
// (stop-at-first-true) would otherwise deliver every such message to only the first-registered
// handler. The case this was built for (before GCY1.4 it was hard-wired to `spectrogram:`): each
// SpectrogramView has its own composable and a stereo split has two, so the second view (e.g. the
// right channel) would never receive its responses and spin forever.
// Key = prefix, in registration order (the first matching prefix wins); value = its subscribers.
const prefixChannels = new Map<string, Set<(message: WsMessage) => void>>()
let socket: WebSocket | null = null
let reconnectAttempt = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

// FSC3.2a. ПОКОЛЕНИЕ ПОДКЛЮЧЕНИЯ, А НЕ ФЛАГ (урок QA-I48: флаг переживает ровно одну гонку).
// Нужно потому, что теперь мы закрываем сокет САМИ и тут же поднимаем следующий: события `close` и
// `open` мёртвого сокета могут догнать нас уже после того, как поднялся новый, и без сверки
// поколений старый `close` обнулил бы ЖИВОЙ сокет и запустил второе подключение параллельно.
let connectionGeneration = 0
/** Когда ушла первая НЕПОДТВЕРЖДЁННАЯ команда из списка отвечаемых; null — часы не идут. */
let unconfirmedSince: number | null = null
let deadChannelTimer: ReturnType<typeof setTimeout> | null = null
/**
 * LC3.2. `requestId` эха, ответа на которое ждут часы; null — часы не идут.
 *
 * Их РОВНО ОДИН, и это не упрощение, а следствие правила «часы считаются от ПЕРВОЙ
 * неподтверждённой команды»: пока часы идут, новое эхо не уходит (см. `startDeadChannelWatch`),
 * поэтому неподтверждённое эхо никогда не бывает двух сразу и сопоставлять их между собой нечем и
 * незачем. Отсюда и сверка — простым равенством, без очереди и без карты ожидающих.
 *
 * Идентификатор УНИКАЛЕН на каждое взведение (счётчик + случайный хвост). Это не украшение:
 * опоздавший `ui_echo_ack` от ПРЕДЫДУЩЕГО, уже погашенного цикла обязан пройти мимо, иначе он
 * погасил бы СЛЕДУЮЩИЕ часы, ничего не доказав про канал. Свойство проверено мутацией M1 (LC3.4) и
 * стережётся пробой `uitest/src/probe-lc34-guards.ts`.
 *
 * ── LC3.4, ПОПРАВКА К СОБСТВЕННОМУ ОБОСНОВАНИЮ: ОБНУЛЕНИЕ ЭТОЙ ПЕРЕМЕННОЙ в `stopDeadChannelWatch`
 * ИЗБЫТОЧНО, и прежний текст, объяснявший его необходимость, был неверен. Мутация M5 (обнуление
 * убрано) не уронила НИ ОДНОЙ проверки, и перебор всех входов показал почему: попасть в ветку
 * гашения с протухшим идентификатором невозможно — `startDeadChannelWatch` всегда перезаписывает
 * его перед стартом таймера, а `stopDeadChannelWatch` идемпотентен. Строка оставлена НЕ как
 * охранник, а как гигиена состояния: «часы не идут» и «ждать нечего» должны быть видны в коде одним
 * фактом, а не двумя. Держится эта избыточность ровно пока живы M1 (сверка идентификатора) и M2
 * (сверка поколения); тронете их — перечитайте это место.
 */
let pendingEchoRequestId: string | null = null
let echoCounter = 0

function nextEchoRequestId(): string {
  echoCounter += 1
  return `lc-${echoCounter}-${Math.random().toString(36).slice(2, 8)}`
}

function getWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/ws/ui`
}

function dispatch(event: WsMessage): void {
  for (const handler of eventHandlers) {
    if (handler(event) === true) {
      return
    }
  }
}

function registerHandler<TEvent extends WsMessage>(aHandler: WsEventHandler<TEvent>): () => void {
  // GCY1.4: форму входящего обработчик объявляет сам (см. «ТИПЫ» в начале файла).
  const handler = aHandler as WsEventHandler
  eventHandlers.add(handler)

  return () => {
    eventHandlers.delete(handler)
  }
}

/**
 * GCY1.4. Типы, отправка которых через `send()` заводит часы живости (см. блок над
 * `answeredMessageTypes`). Повторная регистрация того же типа безвредна (множество). `ui_echo` —
 * отказ, и тогда не регистрируется ничего из переданного.
 */
function registerAnsweredTypes(types: Iterable<string>): void {
  const list = [...types]
  if (list.includes('ui_echo')) {
    throw new Error("ws: 'ui_echo' cannot be an answered type — the echo is sent through send() by the liveness clock itself, so it would re-arm the clock forever")
  }
  for (const type of list) {
    answeredMessageTypes.add(type)
  }
}

/**
 * GCY1.4. Заводит префиксный канал (см. `WsPrefixChannel`). Идемпотентна: тот же префикс — тот же
 * канал, с теми же подписчиками; повторная регистрация ничего не меняет в разборе сообщений.
 */
function registerPrefixChannel(prefix: string): WsPrefixChannel {
  let subscribers = prefixChannels.get(prefix)
  if (subscribers === undefined) {
    subscribers = new Set()
    prefixChannels.set(prefix, subscribers)
  }
  const channelSubscribers = subscribers
  return {
    prefix,
    subscribe<TMessage extends WsMessage>(aHandler: (message: TMessage) => void): () => void {
      const handler = aHandler as (message: WsMessage) => void
      channelSubscribers.add(handler)
      return () => {
        channelSubscribers.delete(handler)
      }
    },
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return
  const delay = Math.min(BASE_RECONNECT_MS * Math.pow(2, reconnectAttempt), MAX_RECONNECT_MS)
  reconnectAttempt++
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, delay)
}

/** FSC3.2a. Канал подал признак жизни (или ждать больше нечего) — часы остановлены. */
function stopDeadChannelWatch(): void {
  unconfirmedSince = null
  // LC3.2. Ожидаемое эхо забывается ВМЕСТЕ с часами: иначе его опоздавший ответ погасил бы
  // следующие часы (см. комментарий у `pendingEchoRequestId`).
  pendingEchoRequestId = null
  if (deadChannelTimer !== null) {
    clearTimeout(deadChannelTimer)
    deadChannelTimer = null
  }
}

/**
 * FSC3.2a + LC3.2. Ушла команда, доставку которой мы хотим проверить. Часы считаются от ПЕРВОЙ
 * неподтверждённой: очередь команд не продлевает срок, иначе на мёртвом канале его можно было бы
 * отодвигать бесконечно, просто продолжая нажимать кнопки.
 *
 * LC3.2 — ГЛАВНОЕ СВОЙСТВО ЭТОЙ ФУНКЦИИ: ВЗВЕДЕНИЕ ЧАСОВ И ОТПРАВКА ЭХА — ОДНО ДЕЙСТВИЕ, И РАЗНЯТЬ
 * ИХ НЕЛЬЗЯ. Ловушка названа в решении LC-D13 п.4 ДО починки: раз гасит только `ui_echo_ack`, то
 * часы, взведённые без парного эха, гасить будет НЕЧЕМ — они дотикают на СОВЕРШЕННО ЗДОРОВОМ
 * канале и порвут живую связь. По слову владельца это исход ХУЖЕ нераспознанного обрыва: он бьёт
 * всех, а не только тех, у кого сломан транспорт.
 *
 * Поэтому эхо шлётся ЗДЕСЬ, а не у вызывающего. Забыть его нельзя не потому, что кто-то помнит о
 * правиле, а потому, что другого способа взвести часы в этом модуле не существует: таймер
 * заводится только на этой строке, и до неё исполнение доходит только через `sendUiEcho` выше.
 * Это единственная защита, которая переживёт следующего правщика.
 *
 * ЕСЛИ ЭХО НЕ УШЛО — ЧАСЫ НЕ ЗАВОДЯТСЯ ВОВСЕ. `sendUiEcho` вернёт `false`, когда сокета нет или он
 * не в `OPEN` (закрывается, ещё не открыт). Заводить часы в этом случае значило бы ровно ту самую
 * ложную тревогу; а смерть такого сокета и без часов будет замечена штатно — событием `close`,
 * которое на НЕполуоткрытом сокете приходит исправно.
 */
function startDeadChannelWatch(): void {
  if (unconfirmedSince !== null) return
  const requestId = nextEchoRequestId()
  if (!sendUiEcho(requestId)) return
  pendingEchoRequestId = requestId
  unconfirmedSince = Date.now()
  deadChannelTimer = setTimeout(onDeadChannelDeadline, DEAD_CHANNEL_SILENCE_MS)
}

function onDeadChannelDeadline(): void {
  deadChannelTimer = null
  if (unconfirmedSince === null) return
  const silentFor = Date.now() - unconfirmedSince
  if (silentFor < DEAD_CHANNEL_SILENCE_MS) {
    // Таймер разбудили раньше срока (спящая вкладка, сдвиг часов) — досчитываем остаток, а не
    // объявляем смерть по недосчитанному сроку.
    deadChannelTimer = setTimeout(onDeadChannelDeadline, DEAD_CHANNEL_SILENCE_MS - silentFor)
    return
  }
  dropDeadSocket(silentFor)
}

/**
 * FSC3.2a, п.3 решения FSC-D9: РАСПОЗНАВ СМЕРТЬ, КЛИЕНТ ЗАКРЫВАЕТ СОКЕТ САМ.
 *
 * Ждать события `close` нельзя: измерено (FSC1.1), что на полуоткрытом сокете оно не наступает
 * вовсе — ни за 150 с. Поэтому состояние сервиса приводится в «нет связи» РУКАМИ, и только потом
 * зовётся `close()` — как попытка попрощаться, результат которой ни на что не влияет. Дальше
 * работает уже существующая лестница переподключения (1-2-4-8-10 с), измеренная в FSC1.2.
 */
function dropDeadSocket(aSilentForMs: number): void {
  const dead = socket
  stopDeadChannelWatch()
  if (dead === null) return
  // Поколение поднимается ДО закрытия: события мёртвого сокета, которые придут после, обязаны
  // пройти мимо (иначе они обнулят уже поднятый следующий сокет).
  connectionGeneration += 1
  socket = null
  connectionState.value = 'disconnected'
  // НАРОЧНО `info`, а не `warn`. Ворота на предупреждения консоли (VWG-D4) роняют прогон на ЛЮБОМ
  // `console.warn`, а списка исключений заводить нельзя (VWG-D6). Обрыв канала — штатно
  // обрабатываемое событие, и ронять им сценарии (в том числе замки F-0043, которые рвут канал
  // НАМЕРЕННО) было бы неверно. След при этом остаётся.
  console.info(`[ws] канал молчал ${aSilentForMs} мс при неподтверждённой команде — считаю его мёртвым, закрываю сокет и переподключаюсь (FSC3.2a)`)
  try {
    dead.close()
  } catch {
    // Прощание не обязано удаться: сокет уже мёртв, мы просто не оставляем его открытым.
  }
  scheduleReconnect()
}

function connect(): void {
  if (socket !== null) return

  connectionGeneration += 1
  const generation = connectionGeneration
  connectionState.value = 'connecting'
  const ws = new WebSocket(getWsUrl())

  ws.addEventListener('open', () => {
    if (generation !== connectionGeneration) {
      // Это подключение уже отменено (сокет объявлен мёртвым, поднят следующий) — не подменяем им
      // текущий, а закрываем за собой.
      try {
        ws.close()
      } catch {
        // ничего: этот сокет нам больше не нужен
      }
      return
    }
    socket = ws
    connectionState.value = 'connected'
    reconnectAttempt = 0
    stopDeadChannelWatch()
  })

  ws.addEventListener('close', () => {
    if (generation !== connectionGeneration) return
    socket = null
    connectionState.value = 'disconnected'
    stopDeadChannelWatch()
    scheduleReconnect()
  })

  ws.addEventListener('error', () => {
    ws.close()
  })

  ws.addEventListener('message', (ev: MessageEvent) => {
    // ── LC3.2 (план liveness-clock) — ПОЧИНКА F-0049. ЗДЕСЬ БЫЛА ДЫРА. ───────────────────────────
    //
    // БЫЛО: часы гасило ЛЮБОЕ входящее сообщение, и гасило их до `JSON.parse` — рассуждение было
    // такое, что любые пришедшие байты доказывают живость канала. Рассуждение верное ровно наполовину
    // и потому негодное: входящие байты доказывают живость направления «сервер → клиент», а часы
    // сторожат ПРОТИВОПОЛОЖНОЕ направление — дошла ли до сервера НАША команда. Односторонняя смерть
    // «клиент → сервер» именно так и не распознавалась НИКОГДА (F-0049): при играющем движке фоновый
    // `audio_progress` идёт каждые ~1088 мс (медиана замера LC1.1, худший промежуток 1098 мс) при
    // сроке 4912 мс, то есть часы физически не могли дотикать.
    //
    // СТАЛО: гасит ТОЛЬКО `ui_echo_ack` с ТЕМ `requestId`, который мы сами послали и ждём.
    //
    // ПОЧЕМУ НЕ СУЖЕНИЕ ПО СОДЕРЖИМОМУ ОБЫЧНЫХ СООБЩЕНИЙ — ЗАМЕРЕНО, А НЕ ВЫВЕДЕНО (LC1.1/LC1.2,
    // repro-f0049.md §4.1 и §7): признака «следствие нашей команды» в аудио-протоколе НЕТ ВОВСЕ. Ни
    // `runId` (он один на всю серверную аудио-сессию), ни `filePath`, ни `transportState`, ни время
    // отклика не отличают ответ на НАШУ команду от чужого статуса. Причина в сервере:
    // `publishAudioEvent` делает `server.publish("ui", …)` — один и тот же байт-в-байт текст уходит
    // всем ui-сокетам сразу, отправитель не выделен ничем. Наивная привязка «гасит `audio_status`»
    // отвергнута ПРОГОНОМ: 4 из 4 чужих маршрутов запуска (чужое окно, альфа-расслабление, запрос
    // BodyMonitor, реплей) кладут `audio_status` в молчавшее окно за 4-185 мс — ложная зелень часов,
    // та же дыра в профиль.
    //
    // `ui_echo_ack` свободен от этого по построению: сервер отвечает им ТОЛЬКО отправителю
    // (`aSocket.send`, без `publish`), и `requestId` в нём наш. Измерено на стенде (LC3.1a §13.5):
    // за прогон в чужое окно пришло 95 сообщений, `ui_echo_ack` среди них — 0.
    //
    // ЦЕНА ЭТОГО СУЖЕНИЯ И ЧЕМ ОНА ОПЛАЧЕНА: часы стало нечем гасить «попутно», поэтому каждое их
    // взведение обязано слать эхо. Это обеспечено В ОДНОМ МЕСТЕ — в `startDeadChannelWatch`, где
    // взведение и отправка эха слиты в одно действие; см. комментарий там.
    let parsed: unknown
    try {
      parsed = JSON.parse(String(ev.data))
    } catch {
      return
    }
    if (typeof parsed === 'object' && parsed !== null && 'type' in parsed) {
      const type = (parsed as { type?: unknown }).type
      if (type === 'ui_echo_ack') {
        // Сверка поколения — та же, что у `close`/`open`: ответ, догнавший нас с УЖЕ ОБЪЯВЛЕННОГО
        // мёртвым сокета, ничего не говорит о живости текущего и гасить его часы не вправе.
        if (
          generation === connectionGeneration &&
          pendingEchoRequestId !== null &&
          (parsed as { requestId?: unknown }).requestId === pendingEchoRequestId
        ) {
          stopDeadChannelWatch()
        }
        // Дальше не пускаем: потребителей у `ui_echo_ack` нет — это служебное эхо живости канала, а
        // не событие продукта.
        return
      }
      // GCY1.4: префиксные каналы, зарегистрированные модулями (до GCY1.4 здесь был один зашитый
      // `spectrogram:`), — всем подписчикам и мимо `dispatch`. Первый подходящий по порядку регистрации.
      if (typeof type === 'string') {
        for (const [prefix, subscribers] of prefixChannels) {
          if (!type.startsWith(prefix)) continue
          for (const handler of subscribers) {
            handler(parsed as WsMessage)
          }
          return
        }
      }
      dispatch(parsed as WsMessage)
    }
  })
}

function send(msg: WsMessage): boolean {
  if (socket === null || socket.readyState !== WebSocket.OPEN) return false
  socket.send(JSON.stringify(msg))
  // FSC3.2a. Возврат `true` НЕ означает доставку (измерено: 19 из 19 `true` на мёртвом канале) —
  // поэтому здесь же включаются часы ожидания ответа. Только для команд, на которые сервер
  // измеренно отвечает: реестр — `answeredMessageTypes` выше, список и замеры — у регистрирующего
  // модуля (GCY1.4).
  if (answeredMessageTypes.has(msg.type)) {
    startDeadChannelWatch()
  }
  return true
}

/**
 * LC3.1a (план liveness-clock, решение LC-D13 — форма выбрана владельцем 2026-08-29).
 * ЭХО ЖИВОСТИ КАНАЛА: шлём `ui_echo { requestId }`, сервер отвечает `ui_echo_ack` с ТЕМ ЖЕ
 * `requestId` и ТОЛЬКО этому сокету (`aSocket.send`, без `publish`).
 *
 * ЗАЧЕМ. Замер (LC1.1/LC1.2) показал: корреляции «запрос-ответ» в аудио-протоколе НЕТ ВОВСЕ —
 * `audio_status` порождают шесть чужих маршрутов, и от ответа на нашу команду чужой статус
 * неотличим даже по полям. Часы живости выше гасятся сегодня ЛЮБЫМ входящим сообщением, то есть
 * их гасит и чужой поток. Ответ с НАШИМ `requestId` чужое окно породить не может — вот на нём
 * правило гашения и будет построено.
 *
 * LC3.2 — КЕМ ОНА ТЕПЕРЬ ЗОВЁТСЯ. На шаге LC3.1a ручка только существовала и никем не
 * использовалась. Теперь её основной вызывающий — `startDeadChannelWatch()`: взведение часов и
 * отправка эха слиты там в одно действие (ловушка LC-D13 п.4, разобрана в комментарии у той
 * функции). Сама по себе эта функция часов по-прежнему НЕ ЗАВОДИТ и ничего не ждёт — она только
 * шлёт. `'ui_echo'` не входит в `ANSWERED_MESSAGE_TYPES`, поэтому `send()` ниже на нём
 * `startDeadChannelWatch()` не зовёт, и рекурсии «эхо заводит часы, часы шлют эхо» не возникает.
 * (GCY1.4: списка больше нет, есть реестр `answeredMessageTypes`, и это свойство держит отказ
 * `registerAnsweredTypes` на `'ui_echo'`.)
 *
 * Идентификатор задаёт вызывающий: он же и сверяет ответ, поэтому выдумывать его здесь нельзя.
 * Ручка остаётся экспортированной для проб (`uitest/src/probe-lc31a-ui-echo.ts`). Эхо, посланное
 * СНАРУЖИ, часов не гасит: его `requestId` не совпадёт с `pendingEchoRequestId`, и обработчик
 * `message` пропустит ответ мимо — проба не может случайно подтвердить живость за продукт.
 */
function sendUiEcho(aRequestId: string): boolean {
  const echo: UiEchoRequest = { type: 'ui_echo', requestId: aRequestId }
  return send(echo)
}

/**
 * LC3.3 (план liveness-clock) — ПОЧИНКА F-0050: ЗАВЕСТИ ЧАСЫ, КОГДА ОТПРАВЛЯТЬ НЕЧЕГО.
 *
 * ЗАЧЕМ. До этого шага часы заводились ТОЛЬКО как побочный эффект отправки одной из четырёх команд
 * `ANSWERED_MESSAGE_TYPES`. Значит был целый класс жестов, после которых окно оставалось слепым
 * навсегда: выбор файла при ПОДТВЕРЖДЁННОМ простое серверу не шлёт ничего (останавливать, по
 * сведениям клиента, нечего), поэтому неотвеченной команды не возникает и смерть канала распознать
 * НЕЧЕМ. Измерено: 45 222 мс без единого следа `dropDeadSocket` при сроке 4912 мс, а движок в это
 * время играет чужой файл (F-0050).
 *
 * ЧТО ЭТА ФУНКЦИЯ ДЕЛАЕТ — И ЧЕГО НЕ ДЕЛАЕТ. Она НЕ шлёт движку ничего: ни `audio_stop`, ни любой
 * другой команды. Уходит ровно одно служебное `ui_echo`, у которого на сервере нет действия кроме
 * ответа отправителю. В этом и был смысл формы, выбранной владельцем (LC-D13): чужую живую сессию
 * такой зонд не трогает — а `audio_pause`, например, поставил бы её на паузу за 2 мс, что было бы
 * новой редакцией вето чужого запуска (T-75).
 *
 * ПОЧЕМУ ТЕЛО — ОДИН ДЕЛЕГИРУЮЩИЙ ВЫЗОВ, И ПОЧЕМУ ЕГО НЕЛЬЗЯ «ОПТИМИЗИРОВАТЬ». Часы ВЗВОДЯТСЯ одной
 * строкой на весь модуль — `unconfirmedSince = Date.now()` в `startDeadChannelWatch`, — и исполнение
 * доходит до неё только через `if (!sendUiEcho(requestId)) return`. Это и есть та конструкция,
 * которой держится ловушка LC-D13 п.4: взвести часы без парного эха в этом модуле НЕВОЗМОЖНО, и
 * невозможно не потому, что кто-то помнит о правиле. Завести здесь своё взведение значит сделать
 * ложный обрыв на здоровом канале — исход, который по слову владельца ХУЖЕ нераспознанного (LC-D4).
 *
 * ── LC4.1, ПОПРАВКА РЕЦЕНЗЕНТА, ВАЖНАЯ ДЛЯ ТОГО, КТО ПРИДЁТ УБИРАТЬСЯ. Прежняя редакция этого
 * абзаца говорила «часы взводятся одной строкой — `setTimeout`». Про `setTimeout` это НЕПРАВДА:
 * их для этих часов ДВА (`startDeadChannelWatch` и `onDeadChannelDeadline`), и второй — не
 * взведение, а ДОСЧЁТ ОСТАТКА, когда таймер разбудили раньше срока (спящая вкладка, сдвиг часов).
 * Он нарочно НЕ трогает `unconfirmedSince` и потому эха не шлёт — и не должен.
 * СЛИВАТЬ ЭТИ ДВА `setTimeout` В ОДИН НЕЛЬЗЯ: «уборка» уберёт вместе с ними досчёт остатка, и для
 * спящей вкладки вернётся ровно F-0049 — часы, которые не дотикивают. Этой ветки не стережёт ни
 * один замок (её нечем воспроизвести в песочнице), поэтому она держится только этим абзацем.
 * Взведение — это присваивание `unconfirmedSince`, а не заведение таймера; их и надо считать.
 *
 * ЧТО ОТКРЫТО НАРУЖУ — ИМЕННО КНОПКА, А НЕ РЫЧАГ. У функции нет параметров и нет возврата: подсунуть
 * свой `requestId` или попросить «взвести, но эхо не слать» через неё нельзя, такого API нет. Что
 * именно происходит при нажатии, решает модуль, а не вызывающий.
 *
 * ПОВТОРНЫЙ ВЫЗОВ БЕЗВРЕДЕН. `startDeadChannelWatch()` первой строкой выходит, если часы уже идут
 * (правило «часы считаются от ПЕРВОЙ неподтверждённой команды»). Поэтому вызывающему не нужно —
 * и НЕ НАДО — гадать, ушла ли перед этим настоящая команда: если ушла, она часы уже завела, и
 * второго эха не будет.
 *
 * ЕДИНСТВЕННЫЙ ВЫЗЫВАЮЩИЙ В ПРОДУКТЕ — точка выбора файла (`GnauralCore/ui/composables/
 * use-audio-file-selection.ts`, `selectWith`), то есть жест человека. Ставить эту кнопку в цикл,
 * в таймер или в обработчик потока НЕЛЬЗЯ: часы дешёвые, но не бесплатные — каждое их взведение
 * стоит одного `ui_echo`.
 */
function watchChannelLiveness(): void {
  startDeadChannelWatch()
}

function init(): void {
  if (socket !== null || connectionState.value === 'connecting') return
  connect()
}

// GCY1.4: `sendSpectrogram/onSpectrogram` отсюда ушли — GnauralCore строит их сам поверх `send` и
// своего префиксного канала `spectrogram:` (`GnauralCore/ui/plugin.ts`).
export const wsService: WsTransport = {
  connectionState,
  registerHandler,
  send,
  // LC3.1a: ручка эха живости канала (LC-D13). Часов не заводит — см. комментарий у sendUiEcho.
  sendUiEcho,
  // LC3.3 (F-0050): «проверь, жив ли канал» — заводит часы и шлёт парное эхо ОДНИМ действием.
  // Движку не шлёт ничего. См. комментарий у watchChannelLiveness.
  watchChannelLiveness,
  // GCY1.4: точки регистрации модулей — см. `registerAnsweredTypes` и `WsPrefixChannel`.
  registerAnsweredTypes,
  registerPrefixChannel,
  init
}

