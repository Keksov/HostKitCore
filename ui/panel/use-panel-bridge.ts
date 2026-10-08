// panel-window (PW2.2, PW-D5): the parent<->child bridge for a detached panel window, over
// BroadcastChannel('<prefix>panel:<id>') — same-origin is guaranteed because the child is the same
// SPA opened via window.open (PW-D1). The prefix is the host's (GCY-D22, panel-kit.ts): both ends
// are the same bundle, so they always agree on it.
//
// Protocol:
//   parent -> 'parent-hello' (on create + replying to child-ready), 'heartbeat' (every 2s),
//             'parent-gone' (pagehide), 'close-panel' (main side closes the panel)
//   child  -> 'child-ready' (on create), 'child-closed' (its own pagehide),
//             'panel-event' {name, payload} (domain events, e.g. file-open's 'open')
//   child <-> parent: 'panel-request' {requestId, name, payload} / 'panel-response'
//             {requestId, ok, result|error} — TD2.1 (TD-D3), see below.
//
// Request-response (TD2.1, TD-D3). Everything above is fire-and-forget, which cannot express «ask
// the main window and wait for the answer». The track editor's XML hatch needs exactly that (it
// fetches the document and asks `gnaural --validate-strict`), and only the main window may do it:
// the child holds no file state and must not become a second writer. So the child correlates a
// request by id and awaits a response, with a TIMEOUT on its own side — a parent that signed up no
// handlers must degrade into a readable error, never into an eternal spinner. The extension is
// GENERIC: nothing here knows what a voice or an XML block is.
//
// Child-depends-on-parent (PW-D2): the child self-closes when (a) 'parent-gone' arrives and no
// fresh hello follows within the grace period — an F5/hot-reload of the main window re-adopts
// the child in time, so it survives; or (b) it was adopted and the heartbeat goes silent (covers
// a crashed main tab where pagehide never fired). A never-adopted child (a tab opened by hand
// for debugging) is left alone. window.close() works because the real child is script-opened.

import { panelKitName } from './panel-kit'

export type PanelEventPayload = readonly unknown[]

interface BridgeMessage {
  readonly type:
    | 'parent-hello'
    | 'heartbeat'
    | 'parent-gone'
    | 'close-panel'
    | 'child-ready'
    | 'child-closed'
    | 'panel-event'
    | 'panel-state'
    | 'panel-title'
    | 'panel-request'
    | 'panel-response'
    // TD4.2 (TD-D10): parent -> child, the companion panels that should share the child's window
    // right now; and child -> parent, «the user closed this panel inside my window».
    | 'panel-companions'
    | 'child-close-panel'
  readonly name?: string
  readonly payload?: PanelEventPayload
  // TD2.1: correlation of one request with one answer. The id is minted by the child.
  readonly requestId?: string
  readonly ok?: boolean
  readonly result?: unknown
  readonly error?: string
  // PW5.7: parent -> child state snapshot for remote-control panels (e.g. «Список треков»), whose
  // child window holds NO state and renders whatever the parent pushes.
  readonly state?: unknown
  // VS2.8: parent -> child window caption. PanelWindow's :title can be DYNAMIC (e.g. «Параметры:
  // <голос>: Спектр» retargets per lane); the manifest titleKey is only the pre-push fallback.
  readonly title?: string
  // TD4.2 (TD-D10): panel ids travelling in the host's window besides the host itself.
  readonly companions?: readonly string[]
}

const HEARTBEAT_MS = 2000
const SILENCE_MS = 7000
const GONE_GRACE_MS = 5000
const WATCHDOG_MS = 1000
/**
 * TD2.1: how long the CHILD waits for an answer. Generous, because a request may run a real job in
 * the main window (the XML hatch reads the document and shells out to Gnaural), but finite: the
 * failure mode this bounds is a parent that never answers at all.
 */
const REQUEST_TIMEOUT_MS = 15000

/** GCY1.3: exported so the parametrisation lock (panel-kit.test.ts) can see it follow the prefix. */
export const panelChannelName = (panelId: string): string => panelKitName(`:${panelId}`)

/**
 * TD2.1: the transport-free half of request-response — who is waiting for which id, and what happens
 * when the answer never comes. Kept separate from BroadcastChannel and from `window` so the rule can
 * be unit-tested on bare `bun test` (there is no DOM there), which is where every branch below is
 * pinned down.
 */
export interface PendingPanelRequests {
  /** Register an id and hand back the promise the caller awaits. */
  readonly create: (requestId: string) => Promise<unknown>
  /** Settle by id. An id nobody waits for (a late duplicate, an answer after dispose) is ignored. */
  readonly settle: (response: { requestId?: string; ok?: boolean; result?: unknown; error?: string }) => void
  /** Reject everything still waiting — the transport is going away. */
  readonly rejectAll: (reason: string) => void
  readonly pendingCount: () => number
}

export interface PendingPanelRequestsOptions {
  readonly timeoutMs?: number
  /** Injected in tests; defaults to the ambient timers (window's in the app, Bun's in tests). */
  readonly setTimer?: (fn: () => void, ms: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
}

export function createPendingPanelRequests(options: PendingPanelRequestsOptions = {}): PendingPanelRequests {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))

  interface Pending {
    readonly resolve: (value: unknown) => void
    readonly reject: (error: Error) => void
    readonly timer: unknown
  }
  const pending = new Map<string, Pending>()

  const take = (requestId: string): Pending | undefined => {
    const entry = pending.get(requestId)
    if (entry === undefined) {
      return undefined
    }
    pending.delete(requestId)
    clearTimer(entry.timer)
    return entry
  }

  return {
    create: (requestId: string): Promise<unknown> =>
      new Promise<unknown>((resolve, reject) => {
        const timer = setTimer(() => {
          const entry = pending.get(requestId)
          if (entry === undefined) {
            return
          }
          pending.delete(requestId)
          reject(new Error(`panel-request "${requestId}": no answer in ${timeoutMs} ms`))
        }, timeoutMs)
        pending.set(requestId, { resolve, reject, timer })
      }),
    settle: (response): void => {
      if (response.requestId === undefined) {
        return
      }
      const entry = take(response.requestId)
      if (entry === undefined) {
        return
      }
      if (response.ok === true) {
        entry.resolve(response.result)
      } else {
        entry.reject(new Error(response.error ?? 'panel-request failed'))
      }
    },
    rejectAll: (reason: string): void => {
      for (const [requestId, entry] of [...pending]) {
        pending.delete(requestId)
        clearTimer(entry.timer)
        entry.reject(new Error(reason))
      }
    },
    pendingCount: (): number => pending.size,
  }
}

export interface PanelBridgeParentHandlers {
  readonly onChildReady?: () => void
  readonly onChildClosed?: () => void
  readonly onPanelEvent?: (name: string, payload: PanelEventPayload) => void
  /**
   * TD4.2 (TD-D10): the user closed THIS panel inside the child window that hosts it. Different from
   * onChildClosed, which is about the window going away: here the window lives on without us.
   */
  readonly onClosedByChild?: () => void
  /**
   * TD2.1 (TD-D3): answer a child's request. Whatever it returns must survive structuredClone; a
   * throw comes back to the child as a rejected promise carrying the message.
   */
  readonly onRequest?: (name: string, payload: PanelEventPayload) => unknown
}

export interface PanelBridgeParent {
  /** Ask the child window to close (main-side close, PW-D6). */
  readonly requestClose: () => void
  /** PW5.7: push a state snapshot to the child (remote-control panels). */
  readonly sendState: (state: unknown) => void
  /** VS2.8: push the (possibly dynamic) panel title — becomes the child's document.title. */
  readonly sendTitle: (title: string) => void
  /** TD4.2 (TD-D10): push the companion panels the child window should host alongside this one. */
  readonly sendCompanions: (ids: readonly string[]) => void
  readonly dispose: () => void
}

export function createPanelBridgeParent(
  panelId: string,
  handlers: PanelBridgeParentHandlers = {},
): PanelBridgeParent {
  const channel = new BroadcastChannel(panelChannelName(panelId))
  const post = (msg: BridgeMessage): void => channel.postMessage(msg)

  // TD2.1: one request in, one response out — always exactly one, whatever the handler does. The
  // successful post sits INSIDE the try on purpose: a result that cannot be cloned throws here, and
  // the child must learn that as an error rather than wait out the timeout.
  const answerRequest = async (requestId: string, name: string, payload: PanelEventPayload): Promise<void> => {
    try {
      if (handlers.onRequest === undefined) {
        throw new Error(`panel-request "${name}": the main window signed up no handlers`)
      }
      const result = await handlers.onRequest(name, payload)
      post({ type: 'panel-response', requestId, ok: true, result })
    } catch (error) {
      post({
        type: 'panel-response',
        requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  channel.onmessage = (event: MessageEvent<BridgeMessage>): void => {
    const msg = event.data
    if (msg.type === 'panel-request' && msg.name !== undefined && msg.requestId !== undefined) {
      void answerRequest(msg.requestId, msg.name, msg.payload ?? [])
      return
    }
    if (msg.type === 'child-ready') {
      // Adopt immediately — don't make a freshly opened child wait a heartbeat tick.
      post({ type: 'parent-hello' })
      handlers.onChildReady?.()
    } else if (msg.type === 'child-closed') {
      handlers.onChildClosed?.()
    } else if (msg.type === 'child-close-panel') {
      handlers.onClosedByChild?.()
    } else if (msg.type === 'panel-event' && msg.name !== undefined) {
      handlers.onPanelEvent?.(msg.name, msg.payload ?? [])
    }
  }

  // Covers the reload case: a child orphaned by 'parent-gone' is re-adopted by this hello.
  post({ type: 'parent-hello' })
  const heartbeat = window.setInterval(() => post({ type: 'heartbeat' }), HEARTBEAT_MS)
  const onPageHide = (): void => post({ type: 'parent-gone' })
  window.addEventListener('pagehide', onPageHide)

  return {
    requestClose: (): void => post({ type: 'close-panel' }),
    sendState: (state: unknown): void => post({ type: 'panel-state', state }),
    sendTitle: (title: string): void => post({ type: 'panel-title', title }),
    sendCompanions: (ids: readonly string[]): void => post({ type: 'panel-companions', companions: [...ids] }),
    dispose: (): void => {
      window.clearInterval(heartbeat)
      window.removeEventListener('pagehide', onPageHide)
      channel.close()
    },
  }
}

export interface PanelBridgeChild {
  /** Forward a content-component event (e.g. 'open') to the main window. */
  readonly sendEvent: (name: string, payload: PanelEventPayload) => void
  /**
   * TD2.1 (TD-D3): ask the main window and await its answer. Rejects with the parent's own message
   * when the handler refused, and after REQUEST_TIMEOUT_MS when nobody answered at all.
   */
  readonly request: (name: string, payload: PanelEventPayload) => Promise<unknown>
  /**
   * TD4.2 (TD-D10): the user closed this panel inside a window it SHARES with others. The window
   * stays; only this panel goes away, so the parent closes it on its side too.
   */
  readonly closeByChild: () => void
  readonly dispose: () => void
}

export interface PanelBridgeChildHandlers {
  /** PW5.7: a state snapshot pushed by the parent (remote-control panels). */
  readonly onState?: (state: unknown) => void
  /** VS2.8: a window caption pushed by the parent (dynamic panel titles). */
  readonly onTitle?: (title: string) => void
  /** TD4.2 (TD-D10): the companion panels this window should host alongside the host panel. */
  readonly onCompanions?: (ids: readonly string[]) => void
  /**
   * TD4.3 (TD-D11): the parent asked this panel to go away, and the window is NOT ours to close
   * (see `ownsWindow`) — drop the panel from the window instead.
   */
  readonly onCloseRequested?: () => void
}

export interface PanelBridgeChildOptions {
  /**
   * TD4.3 (TD-D11): does this bridge own the OS window it runs in?
   *
   * A window hosts one bridge per panel now (the host panel plus its companions), and only the HOST
   * may act on the window: obey 'close-panel' by closing it, and self-close when the parent falls
   * silent (PW-D2). A companion doing either would take the whole window down with it — including
   * the editor its user is in the middle of typing into.
   */
  readonly ownsWindow?: boolean
}

export function createPanelBridgeChild(
  panelId: string,
  handlers: PanelBridgeChildHandlers = {},
  options: PanelBridgeChildOptions = {},
): PanelBridgeChild {
  const ownsWindow = options.ownsWindow !== false
  const channel = new BroadcastChannel(panelChannelName(panelId))
  const post = (msg: BridgeMessage): void => channel.postMessage(msg)

  let adopted = false
  let lastSeen = 0
  let goneDeadline: number | null = null

  // TD2.1: the child mints request ids. The instance token matters — a child that was reloaded
  // starts its counter over, and a stale answer to the previous life's «1» must not settle the new
  // life's «1».
  const pendingRequests = createPendingPanelRequests()
  const instanceToken = `${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffff).toString(36)}`
  let requestSeq = 0

  channel.onmessage = (event: MessageEvent<BridgeMessage>): void => {
    const msg = event.data
    if (msg.type === 'panel-response') {
      pendingRequests.settle(msg)
      return
    }
    if (msg.type === 'parent-hello' || msg.type === 'heartbeat') {
      adopted = true
      lastSeen = Date.now()
      goneDeadline = null
    } else if (msg.type === 'parent-gone') {
      goneDeadline = Date.now() + GONE_GRACE_MS
    } else if (msg.type === 'close-panel') {
      if (ownsWindow) window.close()
      else handlers.onCloseRequested?.()
    } else if (msg.type === 'panel-state') {
      handlers.onState?.(msg.state)
    } else if (msg.type === 'panel-title' && msg.title !== undefined) {
      handlers.onTitle?.(msg.title)
    } else if (msg.type === 'panel-companions') {
      handlers.onCompanions?.(msg.companions ?? [])
    }
  }

  // Only the window's owner runs the liveness watchdog (TD4.3): a companion whose parent panel was
  // closed in the main window is SUPPOSED to fall silent, and closing the shared window over that
  // would kill the host panel too.
  const watchdog = ownsWindow
    ? window.setInterval(() => {
        const now = Date.now()
        if (goneDeadline !== null && now >= goneDeadline) {
          window.close()
          return
        }
        if (adopted && now - lastSeen > SILENCE_MS) {
          window.close()
        }
      }, WATCHDOG_MS)
    : null

  const onPageHide = (): void => post({ type: 'child-closed' })
  window.addEventListener('pagehide', onPageHide)

  post({ type: 'child-ready' })

  return {
    sendEvent: (name: string, payload: PanelEventPayload): void =>
      post({ type: 'panel-event', name, payload }),
    request: (name: string, payload: PanelEventPayload): Promise<unknown> => {
      requestSeq += 1
      const requestId = `${instanceToken}-${requestSeq}`
      const answer = pendingRequests.create(requestId)
      try {
        post({ type: 'panel-request', requestId, name, payload })
      } catch (error) {
        // An argument that cannot be cloned would otherwise sit out the whole timeout: postMessage
        // throws in the SENDER, and nobody on the other side ever hears about the request.
        pendingRequests.settle({
          requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return answer
    },
    closeByChild: (): void => post({ type: 'child-close-panel' }),
    dispose: (): void => {
      if (watchdog !== null) window.clearInterval(watchdog)
      window.removeEventListener('pagehide', onPageHide)
      pendingRequests.rejectAll('panel bridge disposed')
      channel.close()
    },
  }
}
