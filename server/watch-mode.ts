// GCY1.7 (план gnauralcity, GCY-D30, GCY-D38): идёт ли сервер под наблюдателем горячего перезапуска.
// Нужно админ-ручке `restart-bun`: под наблюдателем отсоединённый перезапуск поднял бы ВТОРОЙ сервер
// мимо него (наблюдатель держит своего ребёнка и сам перезапускает его на правке).
//
// Два признака. `--watch` в `execArgv` — прежний `bun --watch` (дев-скрипт хоста до GCY1.7; проверка
// перенесена из `MindWaveCore/server/server.ts:1059` как была). Переменная `HK_DEV_WATCHER=1` — её
// ставит ребёнку наблюдатель HostKitCore (`dev-watch.ts`): у ребёнка в `execArgv` никакого `--watch`
// нет, это обычный `bun run <entry>`. Имя — с нейтральным префиксом `HK_` сразу (GCY-D38: новые
// переменные каркаса не получают имён продукта).

export const DEV_WATCHER_ENV = "HK_DEV_WATCHER"

export const isBunWatchMode = (): boolean => {
  return process.execArgv.includes("--watch")
}

export const isDevWatcherChild = (): boolean => {
  return process.env[DEV_WATCHER_ENV] === "1"
}
