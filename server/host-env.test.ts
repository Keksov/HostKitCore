// GCY4.4 (GCY-D38): чтение окружения хоста — новое имя первым, старое запасным со строкой о нём.
// Замки держат то, на что опираются серверы хостов (MindWave — с запасными `MW_*`, Gnauralcity — без них)
// и разбор настройки сервера по исходнику (T-42), который считает значение этой же функцией.

import { describe, expect, test } from "bun:test"

import { readHostEnv } from "./host-env"

const collect = (): { lines: string[]; warn: (aLine: string) => void } => {
  const lines: string[] = []
  return { lines, warn: (aLine) => lines.push(aLine) }
}

describe("readHostEnv", () => {
  test("новое имя задано — его значение, обрезанное; запасное не читается и строки нет", () => {
    const sink = collect()
    const env = { HK_RUNTIME_DIR: "  C:\\rt  ", MW_RUNTIME_DIR: "C:\\old" }
    expect(readHostEnv("HK_RUNTIME_DIR", { fallback: "MW_RUNTIME_DIR", env, warn: sink.warn })).toBe("C:\\rt")
    expect(sink.lines).toEqual([])
  })

  test("нового нет — запасное имя и ровно одна строка о нём (по ней фаза 6 найдёт, кто ещё на старых)", () => {
    const sink = collect()
    expect(readHostEnv("HK_WRITE_FENCE", { fallback: "MW_WRITE_FENCE", env: { MW_WRITE_FENCE: "C:\\f" }, warn: sink.warn }))
      .toBe("C:\\f")
    expect(sink.lines).toHaveLength(1)
    expect(sink.lines[0]).toContain("HK_WRITE_FENCE")
    expect(sink.lines[0]).toContain("MW_WRITE_FENCE")
    expect(sink.lines[0]).toStartWith("[host-env] ")
  })

  // Как `?.trim() ||` до GCY4.4: пустое значение — отсутствие, и пустое НОВОЕ не заслоняет заданное старое.
  test("пустая строка и одни пробелы — как отсутствие, у нового и у запасного", () => {
    const sink = collect()
    expect(readHostEnv("HK_DEV", { fallback: "MW_DEV", env: { HK_DEV: "", MW_DEV: "1" }, warn: sink.warn })).toBe("1")
    expect(sink.lines).toHaveLength(1)
    expect(readHostEnv("HK_DEV", { fallback: "MW_DEV", env: { HK_DEV: "   ", MW_DEV: " " }, warn: sink.warn })).toBeUndefined()
    expect(readHostEnv("HK_DEV", { env: { HK_DEV: "" }, warn: sink.warn })).toBeUndefined()
    expect(sink.lines).toHaveLength(1)
  })

  test("не задано ни одно — undefined и без строки", () => {
    const sink = collect()
    expect(readHostEnv("HK_IDLE_TIMEOUT_SEC", { fallback: "MW_IDLE_TIMEOUT_SEC", env: {}, warn: sink.warn })).toBeUndefined()
    expect(sink.lines).toEqual([])
  })

  // Gnauralcity: наследия нет — старое имя не читается, даже если стоит в окружении.
  test("без запасного имени старое не читается", () => {
    const sink = collect()
    expect(readHostEnv("HK_RUNTIME_DIR", { env: { MW_RUNTIME_DIR: "C:\\old" }, warn: sink.warn })).toBeUndefined()
    expect(sink.lines).toEqual([])
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

  test("имя без префикса HK_ и запасное, не являющееся старым, — отказ", () => {
    expect(() => readHostEnv("MW_RUNTIME_DIR")).toThrow(/HK_/)
    expect(() => readHostEnv("HK_")).toThrow(/HK_/)
    expect(() => readHostEnv("HK_DEV", { fallback: "HK_DEV" })).toThrow(/запасное/)
    expect(() => readHostEnv("HK_DEV", { fallback: "HK_DEV_OLD" })).toThrow(/запасное/)
  })
})
