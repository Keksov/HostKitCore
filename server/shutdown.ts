// GCY1.7 (план gnauralcity, GCY-D29): цепочка останова каркаса — `dispose` модулей по порядку, затем
// выход. Обобщение двух функций `MindWaveCore/server/server.ts`: `exitAfterAudioDispose` (было
// `:1483`) и `registerShutdownHandlers` (было `:1529`). Там была одна уборка — `disposeAudioSession`
// MindWave; теперь это `dispose` его модуля, а цепочка зовёт `dispose` всех модулей хоста в порядке
// их списка.
//
// Поведение прежнее:
//   * SIGINT и SIGTERM (`once`) — уборка, затем `process.exit(0)`; выход и при отказе уборки (там
//     был `.finally`);
//   * `beforeExit` (`once`) — уборка без выхода;
//   * админское «перезапустить bun» (`admin.ts`) — та же уборка и тот же выход, что у сигналов.
// Идемпотентна: повторный вызов получает тот же промис (у `disposeAudioSession` своя
// идемпотентность есть и остаётся; эта — на случай нескольких модулей и встречных сигналов).
//
// Первый `dispose` вызывается СИНХРОННО внутри обработчика сигнала (асинхронная функция исполняется
// до первого `await`), как и прежний `disposeAudioSession()` из `exitAfterAudioDispose`. Отказ
// одного модуля не останавливает уборку остальных: он пишется в stderr, и цепочка идёт дальше —
// звук (движок) обязан гаснуть, даже если соседний модуль упал на своей уборке.

export type ModuleDisposer = () => Promise<void> | void

export interface ShutdownChain {
  /** Уборка всех модулей по порядку; идемпотентна. */
  dispose(): Promise<void>
  /** Уборка, затем выход процесса с кодом `aExitCode` (и при отказе уборки). */
  exitAfterDispose(aExitCode: number): void
}

export const createShutdownChain = (
  aDisposers: readonly ModuleDisposer[],
  aExit: (aExitCode: number) => void = (aExitCode) => process.exit(aExitCode),
): ShutdownChain => {
  let disposePromise: Promise<void> | null = null

  const dispose = (): Promise<void> => {
    if (disposePromise !== null) {
      return disposePromise
    }

    disposePromise = (async () => {
      for (const disposer of aDisposers) {
        try {
          await disposer()
        } catch (error) {
          const message = error instanceof Error ? error.message : "Module dispose failed"
          console.error(`[server] ${message}`)
        }
      }
    })()
    return disposePromise
  }

  return {
    dispose,
    exitAfterDispose(aExitCode: number): void {
      void dispose().finally(() => {
        aExit(aExitCode)
      })
    },
  }
}

/** То, что нужно от `process`: подписка `once` (тест подставляет свой источник событий). */
export interface ShutdownSignalSource {
  once(aEvent: "SIGINT" | "SIGTERM" | "beforeExit", aListener: () => void): unknown
}

export const registerShutdownHandlers = (aChain: ShutdownChain, aSource: ShutdownSignalSource = process): void => {
  aSource.once("SIGINT", () => {
    aChain.exitAfterDispose(0)
  })

  aSource.once("SIGTERM", () => {
    aChain.exitAfterDispose(0)
  })

  aSource.once("beforeExit", () => {
    void aChain.dispose()
  })
}
