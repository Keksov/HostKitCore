// GCY1.7 (план gnauralcity, GCY-D4, GCY-D29): общие сетевые охранники каркаса сервера. Обе функции
// переехали из `MindWaveCore/server/fs-browser-server.ts` (были `:37` и `:54`) вместе со своими
// комментариями, телами побайтно; `fs-browser-server.ts` реэкспортирует их, чтобы его потребители и
// тест не менялись. `isLoopbackOrigin` (судит Origin страницы, а не адрес сокета) остался там — он
// нужен только гейту записи файлового браузера.

// Bun's fetch honors HTTP_PROXY/NO_PROXY. On machines with a local proxy tool (e.g.
// HTTP_PROXY=http://127.0.0.1:2080) same-machine loopback requests would be routed through the
// proxy and fail (ECONNRESET/502) — breaking the loopback file-browse server (FB-D2) and its tests.
// Ensure the loopback hosts are always in NO_PROXY so loopback is reachable, while leaving the proxy
// intact for genuine external hosts (bun install, etc.). Bun does NOT override env vars already set
// in the environment from a .env file, so this must mutate process.env in-process, early at startup.
// F-0012 (ИЗМЕРЕНО 2026-08-08, Bun 1.3.11): эта функция НЕ чинит fetch внутри УЖЕ ЗАПУЩЕННОГО
// процесса. Bun читает прокси-настройки один раз на старте, поэтому после мутации process.env
// собственный fetch по-прежнему уходит в прокси и получает 502; проверено втроём: как есть — 502,
// с `proxy: ""` в опциях запроса — 502, и только NO_PROXY, выставленный ДО старта процесса, — 200.
// Отсюда `"test": "NO_PROXY=… bun test"` в package.json: четыре теста fs-browser падали именно на
// этом, а не на своём предмете. Функция оставлена: она приводит окружение в порядок для ДОЧЕРНИХ
// процессов (их Bun/node стартуют уже с исправленным NO_PROXY) и безвредна.
export const ensureLoopbackNoProxy = (): void => {
  const loopbackHosts = ["localhost", "127.0.0.1", "::1"]
  for (const key of ["NO_PROXY", "no_proxy"] as const) {
    const existing = (process.env[key] ?? "")
      .split(",")
      .map((token) => token.trim())
      .filter((token) => token !== "")
    const merged = new Set(existing)
    for (const host of loopbackHosts) {
      merged.add(host)
    }
    process.env[key] = [...merged].join(",")
  }
}

// Loopback detection for /api/fs/info on the main (LAN-facing) server. Covers IPv4, IPv6, and the
// IPv4-mapped-IPv6 form Bun may report.
export const isLoopbackAddress = (aAddress: string | null | undefined): boolean => {
  if (aAddress === null || aAddress === undefined || aAddress === "") {
    return false
  }
  return (
    aAddress === "127.0.0.1" ||
    aAddress.startsWith("127.") ||
    aAddress === "::1" ||
    aAddress === "::ffff:127.0.0.1" ||
    aAddress.startsWith("::ffff:127.")
  )
}
