<template>
  <router-view />
</template>

<script setup lang="ts">
// GCY2.1 (план gnauralcity, GCY-D17): корневой компонент приложения хоста. Переехал сюда из
// `MindWaveCore/ui/src/App.vue` без изменений (кроме пути импорта транспорта): у каждого хоста он один
// и тот же — `router-view` и запуск ws-транспорта оболочки при монтировании. Хост его не пишет: фабрика
// UI (`../factory/quasar-config.ts`) отдаёт этот файл quasar как `sourceFiles.rootComponent`.
import { onMounted } from 'vue'
import { wsService } from '../ws/ws'

onMounted(() => {
  wsService.init()
})
</script>
