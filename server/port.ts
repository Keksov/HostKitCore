// GCY1.7 (план gnauralcity, GCY-D29): порт сервера хоста. Тело переехало из
// `MindWaveCore/server/server.ts` (`getPort`, было `:2729`) побайтно, кроме последней строки:
// умолчание (у MindWave — 3300) теперь называет хост. Порядок прежний: `--port=N` в argv процесса,
// затем переменная `PORT` (её ставят AppCore и песочница uitest), затем умолчание хоста.
// Тем же правилом порт узнаёт наблюдатель (`dev-watch.ts`) — ему надо дождаться освобождения порта.

export const resolveServerPort = (aDefaultPort: number): number => {
  const cliPortArg = Bun.argv.find((arg) => arg.startsWith("--port="))
  const cliPort = cliPortArg ? Number(cliPortArg.slice("--port=".length)) : Number.NaN
  if (Number.isFinite(cliPort) && cliPort > 0) {
    return cliPort
  }

  const envPort = Number(Bun.env.PORT ?? "")
  if (Number.isFinite(envPort) && envPort > 0) {
    return envPort
  }

  return aDefaultPort
}
