// GCY1.7: цепочка останова каркаса — порядок, идемпотентность, выход; сигналы — от подставного
// источника событий (обработчики в процессе тестов не регистрируются).

import { EventEmitter } from "node:events"
import { describe, expect, test } from "bun:test"

import { createShutdownChain, registerShutdownHandlers, type ShutdownSignalSource } from "./shutdown"

const tick = (): Promise<void> => new Promise((aResolve) => setTimeout(aResolve, 0))

describe("shutdown.ts", () => {
  test("модули убираются по порядку и последовательно; первый — синхронно внутри вызова", async () => {
    const log: string[] = []
    let releaseFirst: () => void = () => undefined
    const chain = createShutdownChain([
      () => {
        log.push("a start")
        return new Promise<void>((aResolve) => {
          releaseFirst = () => {
            log.push("a end")
            aResolve()
          }
        })
      },
      () => {
        log.push("b")
      },
    ], () => log.push("exit"))

    const done = chain.dispose()
    expect(log).toEqual(["a start"])
    await tick()
    expect(log).toEqual(["a start"])
    releaseFirst()
    await done
    expect(log).toEqual(["a start", "a end", "b"])
  })

  test("идемпотентна: повторный вызов — тот же промис, модули не убираются дважды", async () => {
    let calls = 0
    const chain = createShutdownChain([() => {
      calls += 1
    }], () => undefined)
    const first = chain.dispose()
    const second = chain.dispose()
    expect(second).toBe(first)
    await first
    await chain.dispose()
    expect(calls).toBe(1)
  })

  test("отказ одного модуля не останавливает остальные, выход всё равно наступает", async () => {
    const log: string[] = []
    const originalError = console.error
    console.error = (aLine: unknown) => {
      log.push(`stderr ${String(aLine)}`)
    }
    try {
      const chain = createShutdownChain([
        () => {
          throw new Error("module a broke")
        },
        async () => {
          log.push("b disposed")
        },
      ], (aCode) => log.push(`exit ${aCode}`))
      chain.exitAfterDispose(3)
      await tick()
      await tick()
    } finally {
      console.error = originalError
    }
    expect(log).toEqual(["stderr [server] module a broke", "b disposed", "exit 3"])
  })

  test("SIGINT/SIGTERM — уборка и exit(0); beforeExit — уборка без выхода; подписка once", async () => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const log: string[] = []
      const source = new EventEmitter()
      const chain = createShutdownChain([() => {
        log.push("dispose")
      }], (aCode) => log.push(`exit ${aCode}`))
      registerShutdownHandlers(chain, source as unknown as ShutdownSignalSource)
      source.emit(signal)
      await tick()
      expect({ signal, log }).toEqual({ signal, log: ["dispose", "exit 0"] })
      expect(source.listenerCount(signal)).toBe(0)
    }

    const log: string[] = []
    const source = new EventEmitter()
    const chain = createShutdownChain([() => {
      log.push("dispose")
    }], (aCode) => log.push(`exit ${aCode}`))
    registerShutdownHandlers(chain, source as unknown as ShutdownSignalSource)
    source.emit("beforeExit")
    await tick()
    expect(log).toEqual(["dispose"])
    // Сигнал после beforeExit: уборка уже была (идемпотентность), выход — да.
    source.emit("SIGTERM")
    await tick()
    expect(log).toEqual(["dispose", "exit 0"])
  })
})
