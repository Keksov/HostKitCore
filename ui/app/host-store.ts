// GCY2.1 (план gnauralcity, GCY-D17): хранилище pinia приложения хоста. Переехало сюда из
// `MindWaveCore/ui/src/stores/index.ts` без изменений: у каждого хоста оно одно и то же (сторы заводят
// модули — GnauralCore, BodyMonitorCore — и сам хост, а pinia на всё приложение одна). Хост его не пишет:
// фабрика UI (`../factory/quasar-config.ts`) отдаёт этот файл quasar как `sourceFiles.store`; копия
// pinia — хоста (пин `SHELL_PINS`, `../factory/pins.ts`).
import { store } from 'quasar/wrappers'
import { createPinia } from 'pinia'

export default store(function () {
  return createPinia()
})
