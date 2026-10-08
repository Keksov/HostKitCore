// GCY1.4 (план gnauralcity, GCY-D2/GCY-D29): контракт модуля (`CoreModuleDescriptor`) и сборка
// приложения из списка модулей хоста — маршруты, вкладки настроек, панели. Типы переехали из
// `MindWaveCore/ui/src/modules/index.ts` без изменений; хост остаётся конфигурацией: свой список
// модулей по порядку → `assembleModules` здесь. Порядок списка значим — по нему идут навигация,
// вкладки, поиск панели по id и склейка сообщений (`app-messages.ts`).
//
// Модули этих типов не импортируют: их манифесты (`gnauralModule`, `bodyMonitorModule`) совпадают с
// контрактом структурно, а проверяет совпадение аннотация списка у хоста.
import type { Component } from 'vue'
import type { RouteRecordRaw } from 'vue-router'
import type { PanelContribution } from '../panel/panel-registry'

export type MessageTree = Record<string, unknown>
export type LocaleMessages = Record<string, MessageTree>

export interface CoreModuleRouteContribution {
  readonly name: string
  readonly path: string
  readonly navLabelKey: string
  readonly component: NonNullable<RouteRecordRaw['component']>
}

export interface CoreModuleSettingsTabContribution {
  readonly name: string
  readonly icon: string
  readonly labelKey: string
  readonly component: Component
}

export interface CoreModuleDescriptor {
  readonly id: string
  readonly messages: LocaleMessages
  readonly routes: readonly CoreModuleRouteContribution[]
  readonly settingsTabs: readonly CoreModuleSettingsTabContribution[]
  // PW2.1 (PW-D4): panels the module can show in a detached child window (PanelHostPage).
  readonly panels?: readonly PanelContribution[]
}

/** То, что хост раздаёт своему роутеру, макету, странице настроек и странице отсоединённой панели. */
export interface AssembledModules {
  readonly routes: CoreModuleRouteContribution[]
  readonly settingsTabs: CoreModuleSettingsTabContribution[]
  readonly panels: readonly PanelContribution[]
}

/** Вклады модулей подряд, в порядке списка хоста (как прежние `flatMap` в `src/modules/index.ts`). */
export function assembleModules(modules: readonly CoreModuleDescriptor[]): AssembledModules {
  return {
    routes: modules.flatMap((module) => module.routes),
    settingsTabs: modules.flatMap((module) => module.settingsTabs),
    panels: modules.flatMap((module) => module.panels ?? []),
  }
}
