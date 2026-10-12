// GCY2.1 (план gnauralcity, GCY-D17): маршрутизатор приложения хоста. Хост остаётся конфигурацией —
// СВОЙ список маршрутов (макет, его страницы, маршрут отсоединённой панели `panelHostRoute`); всё, что у
// хостов одинаково, — здесь:
//   * `hostRouter(routes)` — то, что `src/router/index.ts` хоста отдаёт quasar: хэш-история и прокрутка
//     в начало при переходе. Тело переехало из `MindWaveCore/ui/src/router/index.ts` без изменений
//     (обёртка `route()` из `quasar/wrappers` — тождественная функция, её здесь нет);
//   * `moduleRouteRecords(moduleRoutes)` — маршруты модулей (`assembleModules`, `./module-registry.ts`)
//     в виде записей vue-router: имя, путь, компонент. Переехало из `MindWaveCore/ui/src/router/routes.ts`.
import { createRouter, createWebHashHistory, type RouteRecordRaw, type Router } from 'vue-router'

import type { CoreModuleRouteContribution } from './module-registry'

/** Записи vue-router для маршрутов модулей — детьми макета хоста, в порядке списка модулей. */
export function moduleRouteRecords(moduleRoutes: readonly CoreModuleRouteContribution[]): RouteRecordRaw[] {
  return moduleRoutes.map((route) => ({
    name: route.name,
    path: route.path,
    component: route.component,
  }))
}

/** Фабрика маршрутизатора для `export default` в `src/router/index.ts` хоста. */
export function hostRouter(routes: readonly RouteRecordRaw[]): () => Router {
  return function () {
    const Router = createRouter({
      scrollBehavior: () => ({ left: 0, top: 0 }),
      routes,
      history: createWebHashHistory()
    })

    return Router
  }
}
