// track-editor-detach TD2.1 (TD-D3): unit tests for the transport-free half of the bridge's
// request-response — the pending-by-id registry. The transport itself (BroadcastChannel + window
// timers) is not exercised here; what IS pinned down is every way an answer can fail to arrive,
// because that is the part a detached panel shows the user.
// Run (part of the verify procedure, see AGENTS.md):
//   cd HostKitCore && bun test
import { describe, expect, test } from 'bun:test'

import { createPendingPanelRequests } from './use-panel-bridge'

/** A hand-driven clock: the timeout fires exactly when the test says so, never by wall time. */
function manualTimers(): { setTimer: (fn: () => void, ms: number) => unknown; clearTimer: (h: unknown) => void; fire: () => void; armed: () => number } {
  const timers = new Map<number, () => void>()
  let seq = 0
  return {
    setTimer: (fn): unknown => {
      seq += 1
      timers.set(seq, fn)
      return seq
    },
    clearTimer: (handle): void => {
      timers.delete(handle as number)
    },
    fire: (): void => {
      for (const [id, fn] of [...timers]) {
        timers.delete(id)
        fn()
      }
    },
    armed: (): number => timers.size,
  }
}

describe('createPendingPanelRequests (TD2.1)', () => {
  test('ok:true resolves the waiting promise with the result', async () => {
    const clock = manualTimers()
    const pending = createPendingPanelRequests(clock)
    const answer = pending.create('r1')
    pending.settle({ requestId: 'r1', ok: true, result: '<voice>…</voice>' })
    expect(await answer).toBe('<voice>…</voice>')
    expect(pending.pendingCount()).toBe(0)
    // The timer is disarmed with the request — a settled id must not fire later.
    expect(clock.armed()).toBe(0)
  })

  test('ok:false rejects with the parent’s own message', async () => {
    const pending = createPendingPanelRequests(manualTimers())
    const answer = pending.create('r1')
    pending.settle({ requestId: 'r1', ok: false, error: 'voice 3 is not in the document' })
    await expect(answer).rejects.toThrow('voice 3 is not in the document')
  })

  test('a refusal with no message still rejects (never resolves with undefined)', async () => {
    const pending = createPendingPanelRequests(manualTimers())
    const answer = pending.create('r1')
    pending.settle({ requestId: 'r1', ok: false })
    await expect(answer).rejects.toThrow('panel-request failed')
  })

  test('an answer nobody waits for is ignored, and a late duplicate cannot settle twice', async () => {
    const pending = createPendingPanelRequests(manualTimers())
    const answer = pending.create('r1')
    pending.settle({ requestId: 'r1', ok: true, result: 1 })
    // Both of these used to be the same bug in disguise: a second settle for a live id, and an
    // answer for an id from a previous life of the child window.
    pending.settle({ requestId: 'r1', ok: false, error: 'too late' })
    pending.settle({ requestId: 'unknown', ok: true, result: 2 })
    pending.settle({ ok: true, result: 3 })
    expect(await answer).toBe(1)
  })

  test('silence rejects on the timeout, naming the wait', async () => {
    const clock = manualTimers()
    const pending = createPendingPanelRequests({ ...clock, timeoutMs: 15000 })
    const answer = pending.create('r1')
    expect(pending.pendingCount()).toBe(1)
    clock.fire()
    await expect(answer).rejects.toThrow('no answer in 15000 ms')
    expect(pending.pendingCount()).toBe(0)
  })

  test('a late answer after the timeout is harmless', async () => {
    const clock = manualTimers()
    const pending = createPendingPanelRequests(clock)
    const answer = pending.create('r1')
    clock.fire()
    await expect(answer).rejects.toThrow(/no answer/u)
    pending.settle({ requestId: 'r1', ok: true, result: 'слишком поздно' })
    expect(pending.pendingCount()).toBe(0)
  })

  test('dispose rejects everything still waiting — no promise is left hanging', async () => {
    const clock = manualTimers()
    const pending = createPendingPanelRequests(clock)
    const first = pending.create('r1')
    const second = pending.create('r2')
    pending.rejectAll('panel bridge disposed')
    await expect(first).rejects.toThrow('panel bridge disposed')
    await expect(second).rejects.toThrow('panel bridge disposed')
    expect(pending.pendingCount()).toBe(0)
    expect(clock.armed()).toBe(0)
  })

  test('requests are independent: one id settling leaves the others waiting', async () => {
    const clock = manualTimers()
    const pending = createPendingPanelRequests(clock)
    const first = pending.create('r1')
    const second = pending.create('r2')
    pending.settle({ requestId: 'r2', ok: true, result: 'вторая' })
    expect(await second).toBe('вторая')
    expect(pending.pendingCount()).toBe(1)
    pending.settle({ requestId: 'r1', ok: true, result: 'первая' })
    expect(await first).toBe('первая')
  })
})
