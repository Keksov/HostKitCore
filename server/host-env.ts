// План gnauralcity, GCY-D38: ОКРУЖЕНИЕ ХОСТА — ОДНОЙ ФУНКЦИЕЙ И ПОД НЕЙТРАЛЬНЫМИ ИМЕНАМИ.
//
// Переменные окружения каркаса и хостов носят префикс `HK_` (`HK_RUNTIME_DIR`, `HK_WRITE_FENCE`, `HK_DEV`,
// `HK_IDLE_TIMEOUT_SEC`; песочница uitest — `HK_UITEST_PORT`, `HK_SANDBOX_DIR`, `HK_UITEST_HOST`), а не имя
// одного продукта. Пустая строка (и одни пробелы) — то же, что отсутствие; значение возвращается обрезанным.
//
// Прежние имена MindWave (`MW_*`) с GCY4.4 читались запасными, в GCY6.1 (фаза 6) сняты: их не читает никто.
// Запасного чтения больше нет — `readHostEnv` с `fallback` отказывает, а не молча читает одно новое имя. Чтобы
// человек с привычкой к старому имени не работал молча на умолчаниях, хост объявляет свои снятые имена
// `noticeRetiredHostEnv`: заданное снятое имя даёт одну строку `[host-env] …` и ни на что не влияет. Имена
// снятых переменных — хоста (MindWave), не каркаса: HostKitCore хостов не знает (GCY-D19).
//
// Модуль ЧИСТЫЙ и без `Bun.*`: его зовут серверы хостов (bun) и uitest (раннер node, strip-types — без
// enum и parameter properties), включая разбор настройки сервера по исходнику (T-42,
// `MindWaveCore/uitest/src/server-idle-setting.ts`), который обязан считать значение ЭТОЙ функцией.

/** Префикс нейтральных имён окружения (GCY-D38). */
export const HOST_ENV_PREFIX = "HK_"

export interface HostEnvOptions {
  /** Откуда читать; по умолчанию — окружение процесса. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

export interface RetiredHostEnvOptions extends HostEnvOptions {
  /** Куда сказать о заданном снятом имени; по умолчанию — `console.warn`. */
  readonly warn?: (aLine: string) => void
}

const present = (aRaw: string | undefined): string | undefined => {
  const value = aRaw?.trim()
  return value === undefined || value === "" ? undefined : value
}

const assertHostEnvName = (aCaller: string, aName: string): void => {
  if (!aName.startsWith(HOST_ENV_PREFIX) || aName.length === HOST_ENV_PREFIX.length) {
    throw new Error(`${aCaller}: «${aName}» — не имя окружения хоста: нужен префикс ${HOST_ENV_PREFIX} (GCY-D38)`)
  }
}

/** Значение переменной окружения хоста `aName` (`HK_…`), обрезанное; `undefined` — не задана или пуста. */
export function readHostEnv(aName: string, aOptions: HostEnvOptions = {}): string | undefined {
  assertHostEnvName("readHostEnv", aName)
  // Запасные имена сняты в GCY6.1. Опция, которую функция больше не исполняет, — отказ: иначе вызов,
  // рассчитывающий на старое имя, тихо получил бы умолчание.
  if ("fallback" in aOptions) {
    throw new Error(
      `readHostEnv: запасных имён больше нет — ${aName} читается только под своим именем ` +
        "(GCY-D38, сняты в GCY6.1); о снятом старом имени говорит noticeRetiredHostEnv",
    )
  }
  return present((aOptions.env ?? process.env)[aName])
}

/**
 * Снятые имена окружения хоста — `{ старое: "HK_новое" }`. Каждое заданное (непустое) старое имя — одна строка
 * в `warn`: оно больше не читается, действует только новое. Значения не читаются и ничего не меняют.
 * Возвращает заданные старые имена.
 */
export function noticeRetiredHostEnv(
  aRetired: Readonly<Record<string, string>>,
  aOptions: RetiredHostEnvOptions = {},
): string[] {
  const env = aOptions.env ?? process.env
  const warn = aOptions.warn ?? ((aLine: string) => console.warn(aLine))
  const found: string[] = []
  for (const [retired, name] of Object.entries(aRetired)) {
    assertHostEnvName("noticeRetiredHostEnv", name)
    if (retired === name || retired.startsWith(HOST_ENV_PREFIX)) {
      throw new Error(`noticeRetiredHostEnv: «${retired}» для ${name} — это не снятое старое имя (GCY-D38)`)
    }
    if (present(env[retired]) !== undefined) {
      found.push(retired)
      warn(`[host-env] ${retired} задана, но больше не читается — используйте ${name} (GCY-D38)`)
    }
  }
  return found
}
