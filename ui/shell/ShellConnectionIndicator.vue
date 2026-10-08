<template>
  <q-icon name="check_circle" :color="bunStatusColor" size="20px" class="q-mr-xs cursor-pointer" @click.stop="handleBunStatusClick">
    <app-tooltip>{{ bunStatusLabel }}</app-tooltip>
  </q-icon>
</template>

<script setup lang="ts">
// GCY1.5 (план gnauralcity, GCY-D29): индикатор связи с сервером (Bun) для шапки хоста. Перенесён из
// `MindWaveCore/ui/layouts/MainLayout.vue` без изменения логики. Ctrl+клик открывает диалог
// «Bun-действия» — тот, что смонтирован в голом макете оболочки (`./bun-actions.ts`).
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import AppTooltip from '@tooltip/AppTooltip.vue'
import { wsService } from '../ws/ws'
import { openBunActionsDialog } from './bun-actions'

const { t } = useI18n()

function handleBunStatusClick(event: MouseEvent): void {
  if (!event.ctrlKey) {
    return
  }

  openBunActionsDialog()
}

const bunStatusColor = computed(() => {
  switch (wsService.connectionState.value) {
    case 'connected': return 'positive'
    default: return 'negative'
  }
})

const bunStatusLabel = computed(() => {
  switch (wsService.connectionState.value) {
    case 'connected': return t('common.bunConnected')
    case 'connecting': return t('common.bunConnecting')
    default: return t('common.bunDisconnected')
  }
})
</script>
