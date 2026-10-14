// GCY1.7: HTTP-утилиты и охранники loopback каркаса сервера (перенесены из MindWave без изменения
// поведения — эти замки держат контракт, на который опираются клиенты и хосты).

import { afterEach, describe, expect, test } from "bun:test"

import { errorResponse, jsonResponse, parseBooleanQuery, parseJsonBody } from "./http"
import { ensureLoopbackNoProxy, isLoopbackAddress } from "./loopback"

describe("http.ts", () => {
  test("jsonResponse: тело JSON, статус, тип и no-store", async () => {
    const response = jsonResponse({ a: 1 }, 202)
    expect(response.status).toBe(202)
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({ a: 1 })
    expect(jsonResponse(null).status).toBe(200)
  })

  test("errorResponse: { error } — его читает клиентский requestJson", async () => {
    const response = errorResponse(409, "busy")
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: "busy" })
  })

  test("parseJsonBody: разбирает тело; не-JSON — ровно «Invalid JSON body» с причиной", async () => {
    expect(await parseJsonBody(new Request("http://x/", { method: "POST", body: "{\"k\":[1]}" }))).toEqual({ k: [1] })
    let caught: unknown = null
    try {
      await parseJsonBody(new Request("http://x/", { method: "POST", body: "{nope" }))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe("Invalid JSON body")
    expect((caught as Error).cause).toBeInstanceOf(Error)
  })

  // GCY3.6: перенесена из MindWaveCore/server/server.ts побайтно; её зовут ручка логов хоста (favorite)
  // и /api/audio/file компонента (singleLoop). Отказ — прежний текст, включая слово «favorite».
  test("parseBooleanQuery: пусто — undefined; 1/true и 0/false без учёта регистра; иное — прежний отказ", () => {
    expect(parseBooleanQuery(null)).toBeUndefined()
    expect(parseBooleanQuery("")).toBeUndefined()
    expect(["1", "true", "TRUE", "True"].map(parseBooleanQuery)).toEqual([true, true, true, true])
    expect(["0", "false", "FALSE", "False"].map(parseBooleanQuery)).toEqual([false, false, false, false])
    for (const bad of ["yes", "2", " 1", "on"]) {
      expect(() => parseBooleanQuery(bad)).toThrow(new Error("favorite must be true/false or 1/0"))
    }
  })
})

describe("loopback.ts", () => {
  test("isLoopbackAddress: формы loopback да, сеть и пусто — нет", () => {
    for (const address of ["127.0.0.1", "127.5.6.7", "::1", "::ffff:127.0.0.1", "::ffff:127.9.9.9"]) {
      expect({ address, ok: isLoopbackAddress(address) }).toEqual({ address, ok: true })
    }
    for (const address of ["192.168.1.20", "10.0.0.5", "::ffff:10.0.0.1", "", null, undefined]) {
      expect({ address, ok: isLoopbackAddress(address) }).toEqual({ address, ok: false })
    }
  })

  describe("ensureLoopbackNoProxy", () => {
    const saved = { upper: process.env.NO_PROXY, lower: process.env.no_proxy }
    afterEach(() => {
      // Процесс тестов общий для всех файлов — окружение возвращается как было.
      for (const [key, value] of [["NO_PROXY", saved.upper], ["no_proxy", saved.lower]] as const) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    })

    test("дописывает loopback-хосты, не теряя своих и не дублируя", () => {
      process.env.NO_PROXY = "example.org, localhost"
      ensureLoopbackNoProxy()
      const tokens = (process.env.NO_PROXY ?? "").split(",")
      expect(tokens).toContain("example.org")
      for (const host of ["localhost", "127.0.0.1", "::1"]) {
        expect(tokens.filter((aToken) => aToken === host)).toHaveLength(1)
      }
    })
  })
})
