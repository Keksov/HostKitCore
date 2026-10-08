// GCY1.4 (план gnauralcity, GCY-D29/GCY-D2): маршрут отсоединённого окна панели. Страница
// (`PanelHostPage.vue`) переехала сюда из `MindWaveCore/ui/pages/`; маршрут хост берёт отсюда.
import type { RouteRecordRaw } from 'vue-router'
import type { PanelContribution } from '../panel/panel-registry'

/**
 * `#/panel/<id>` — содержимое отсоединённого окна (PW2.1, PW-D4); стоит ВНЕ макета хоста (без
 * навигации и шапки). Адрес не менять: его строит `PanelWindow.vue` при отсоединении, и по нему
 * узнают дочернее окно пробы и сценарии uitest.
 *
 * Список панелей страница получает от хоста пропом маршрута (`props` — объект), а не импортом хоста
 * и не через глобальное состояние: хост отдаёт сюда свои `modulePanels` (`assembleModules`).
 *
 * ТРЕБОВАНИЕ К ХОСТУ: ключ `app.title` в его локалях — см. `app-messages.ts`.
 */
export function panelHostRoute(panels: readonly PanelContribution[]): RouteRecordRaw {
  return {
    path: '/panel/:panelId',
    component: () => import('./PanelHostPage.vue'),
    props: { panels },
  }
}
