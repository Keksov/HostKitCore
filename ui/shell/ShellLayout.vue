<template>
  <q-layout :view="view">
    <slot name="header" />

    <q-page-container>
      <router-view />
    </q-page-container>

    <shell-bun-actions-dialog :bun-action-extensions="bunActionExtensions" />
  </q-layout>
</template>

<script setup lang="ts">
// GCY1.5 (план gnauralcity, GCY-D29, GCY-D21): голый макет оболочки — `q-layout` + `q-page-container`
// с `router-view`, без шапки: страница (`q-page`) работает в нём как есть. Шапку, если она нужна, хост
// отдаёт слотом `header` целиком (`q-header`; MindWave — вкладки, индикаторы, выбор языка).
//
// Сервисы оболочки смонтированы здесь, и у каждого хоста они одни и те же: диалог «Bun-действия»
// (открывается `openBunActionsDialog()` из `./bun-actions.ts` — индикатором связи в шапке или, в
// будущем, пунктом меню страницы) и плашка потери связи (поверх страницы; её ведёт наблюдатель связи
// внутри диалога — см. `ShellBunActionsDialog.vue`). Свои действия хост добавляет пропом
// `bunActionExtensions`.
//
// `router-view` здесь без `<keep-alive>`: страницы вкладок пересоздаются при каждом заходе (так было
// и в MainLayout MindWave до переезда).
import type { BunActionExtension } from './bun-actions'
import ShellBunActionsDialog from './ShellBunActionsDialog.vue'

withDefaults(defineProps<{
  /** Раскладка `q-layout` (проп `view` Quasar). */
  view?: string
  /** Действия хоста сверх встроенных «Bun-действий» (`./bun-actions.ts`). */
  bunActionExtensions?: readonly BunActionExtension[]
}>(), {
  view: 'hHh lpR fFf',
  bunActionExtensions: () => [],
})
</script>
