// GCY-D38: чтение окружения хоста — только под нейтральным именем `HK_*`; прежние `MW_*` сняты в GCY6.1 и не
// читаются, а заданное снятое имя хост объявляет одной строкой. Замки держат то, на что опираются серверы
// хостов, песочница uitest и разбор настройки сервера по исходнику (T-42), который считает значение этой же
// функцией.

import { describe, expect, test } from "bun:test"

import { noticeRetiredHostEnv, readHostEnv } from "./host-env"

const collect = (): { lines: string[]; warn: (aLine: string) => void } => {
  const lines: string[] = []
  return { lines, warn: (aLine) => lines.push(aLine) }
}

describe("readHostEnv", () => {
  test("заданное имя — его значение, обрезанное", () => {
    expect(readHostEnv("HK_RUNTIME_DIR", { env: { HK_RUNTIME_DIR: "  C:\\rt  " } })).toBe("C:\\rt")
  })

  // Как `?.trim() ||` серверов до GCY4.4: пустое значение — отсутствие.
  test("пустая строка и одни пробелы — как отсутствие", () => {
    expect(readHostEnv("HK_DEV", { env: { HK_DEV: "" } })).toBeUndefined()
    expect(readHostEnv("HK_DEV", { env: { HK_DEV: "   " } })).toBeUndefined()
    expect(readHostEnv("HK_DEV", { env: {} })).toBeUndefined()
  })

  // GCY6.1: запасные имена сняты — старое не читается, даже когда нового нет.
  test("прежнее имя MW_* не читается", () => {
    expect(readHostEnv("HK_RUNTIME_DIR", { env: { MW_RUNTIME_DIR: "C:\\old" } })).toBeUndefined()
    expect(readHostEnv("HK_IDLE_TIMEOUT_SEC", { env: { MW_IDLE_TIMEOUT_SEC: "200" } })).toBeUndefined()
    expect(readHostEnv("HK_DEV", { env: { HK_DEV: "1", MW_DEV: "0" } })).toBe("1")
  })

  // Опцию, которую функция больше не исполняет, она не проглатывает: вызов, рассчитывающий на старое имя,
  // иначе тихо получил бы умолчание.
  test("опция fallback — отказ", () => {
    const options = { fallback: "MW_DEV", env: { MW_DEV: "1" } } as unknown as Parameters<typeof readHostEnv>[1]
    expect(() => readHostEnv("HK_DEV", options)).toThrow(/запасных имён больше нет/)
  })

  test("по умолчанию читает окружение процесса", () => {
    const name = "HK_HOST_ENV_TEST_PROBE"
    const saved = process.env[name]
    try {
      process.env[name] = "x"
      expect(readHostEnv(name)).toBe("x")
      delete process.env[name]
      expect(readHostEnv(name)).toBeUndefined()
    } finally {
      if (saved === undefined) delete process.env[name]
      else process.env[name] = saved
    }
  })

  test("имя без префикса HK_ — отказ", () => {
    expect(() => readHostEnv("MW_RUNTIME_DIR")).toThrow(/HK_/)
    expect(() => readHostEnv("HK_")).toThrow(/HK_/)
  })
})

describe("noticeRetiredHostEnv", () => {
  const RETIRED = { MW_RUNTIME_DIR: "HK_RUNTIME_DIR", MW_DEV: "HK_DEV" }

  test("заданное снятое имя — ровно одна строка с обоими именами; значение ни на что не влияет", () => {
    const sink = collect()
    const env = { MW_DEV: "1" }
    expect(noticeRetiredHostEnv(RETIRED, { env, warn: sink.warn })).toEqual(["MW_DEV"])
    expect(sink.lines).toEqual(["[host-env] MW_DEV задана, но больше не читается — используйте HK_DEV (GCY-D38)"])
    expect(readHostEnv("HK_DEV", { env })).toBeUndefined()
  })

  test("строка — на каждое заданное, и при заданном новом тоже (старое всё равно не действует)", () => {
    const sink = collect()
    const env = { MW_RUNTIME_DIR: "C:\\old", HK_RUNTIME_DIR: "C:\\rt", MW_DEV: "1" }
    expect(noticeRetiredHostEnv(RETIRED, { env, warn: sink.warn })).toEqual(["MW_RUNTIME_DIR", "MW_DEV"])
    expect(sink.lines).toHaveLength(2)
    expect(sink.lines[0]).toContain("MW_RUNTIME_DIR")
    expect(sink.lines[0]).toContain("HK_RUNTIME_DIR")
    expect(readHostEnv("HK_RUNTIME_DIR", { env })).toBe("C:\\rt")
  })

  test("не задано или пусто — без строки", () => {
    const sink = collect()
    expect(noticeRetiredHostEnv(RETIRED, { env: { MW_DEV: "  ", MW_RUNTIME_DIR: "" }, warn: sink.warn })).toEqual([])
    expect(noticeRetiredHostEnv(RETIRED, { env: {}, warn: sink.warn })).toEqual([])
    expect(sink.lines).toEqual([])
  })

  test("новое имя без префикса HK_ или старое, не являющееся старым, — отказ", () => {
    expect(() => noticeRetiredHostEnv({ MW_DEV: "DEV" }, { env: {} })).toThrow(/HK_/)
    expect(() => noticeRetiredHostEnv({ HK_DEV: "HK_DEV" }, { env: {} })).toThrow(/не снятое/)
    expect(() => noticeRetiredHostEnv({ HK_DEV_OLD: "HK_DEV" }, { env: {} })).toThrow(/не снятое/)
  })
})
