// GCY4.4 (план gnauralcity, GCY-D38, GCY-D19): ОКРУЖЕНИЕ ХОСТА — ОДНОЙ ФУНКЦИЕЙ И ПОД НЕЙТРАЛЬНЫМИ ИМЕНАМИ.
//
// Переменные окружения каркаса и хостов носят префикс `HK_` (`HK_RUNTIME_DIR`, `HK_WRITE_FENCE`, `HK_DEV`,
// `HK_IDLE_TIMEOUT_SEC`; песочница uitest — `HK_UITEST_PORT`, `HK_SANDBOX_DIR`), а не имя одного продукта.
// MindWave жил под `MW_*`; на время переезда его старые имена читаются ЗАПАСНЫМИ — новое имя первым, старое
// только когда нового нет, — и каждое срабатывание запасного пишет одну строку в консоль: по этим строкам
// фаза 6 узнаёт, кто ещё запускает на старых именах, прежде чем их снять. У Gnauralcity наследия нет —
// он зовёт функцию без запасного имени.
//
// Пустая строка (и одни пробелы) — то же, что отсутствие: так читали `?.trim() ||` сервера до GCY4.4, и
// так пустое новое имя не заслоняет заданное старое. Значение возвращается обрезанным.
//
// Модуль ЧИСТЫЙ и без `Bun.*`: его зовут серверы хостов (bun) и uitest (раннер node, strip-types — без
// enum и parameter properties), включая разбор настройки сервера по исходнику (T-42,
// `MindWaveCore/uitest/src/server-idle-setting.ts`), который обязан считать значение ЭТОЙ функцией.

/** Префикс нейтральных имён окружения (GCY-D38). */
export const HOST_ENV_PREFIX = "HK_"

export interface HostEnvOptions {
  /**
   * Старое имя, которое читается, когда нового нет (MindWave: `MW_<…>`, GCY-D38). Снимается в фазе 6
   * плана gnauralcity вместе со строкой о нём.
   */
  readonly fallback?: string
  /** Откуда читать; по умолчанию — окружение процесса. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Куда сказать о срабатывании запасного имени; по умолчанию — `console.warn`. */
  readonly warn?: (aLine: string) => void
}

const present = (aRaw: string | undefined): string | undefined => {
  const value = aRaw?.trim()
  return value === undefined || value === "" ? undefined : value
}

/**
 * Значение переменной окружения хоста `aName` (`HK_…`), обрезанное; `undefined` — не задана или пуста.
 * Пуста и новая, и задано запасное `aOptions.fallback` — его значение и одна строка в `warn`.
 */
export function readHostEnv(aName: string, aOptions: HostEnvOptions = {}): string | undefined {
  if (!aName.startsWith(HOST_ENV_PREFIX) || aName.length === HOST_ENV_PREFIX.length) {
    throw new Error(`readHostEnv: «${aName}» — не имя окружения хоста: нужен префикс ${HOST_ENV_PREFIX} (GCY-D38)`)
  }
  const { fallback } = aOptions
  if (fallback !== undefined && (fallback === aName || fallback.startsWith(HOST_ENV_PREFIX))) {
    throw new Error(`readHostEnv: запасное имя «${fallback}» для ${aName} — это не старое имя (GCY-D38)`)
  }
  const env = aOptions.env ?? process.env
  const value = present(env[aName])
  if (value !== undefined || fallback === undefined) {
    return value
  }
  const legacy = present(env[fallback])
  if (legacy !== undefined) {
    const warn = aOptions.warn ?? ((aLine: string) => console.warn(aLine))
    warn(`[host-env] ${aName} не задана — прочитано запасное имя ${fallback} (GCY-D38: старые имена снимаются в фазе 6)`)
  }
  return legacy
}
