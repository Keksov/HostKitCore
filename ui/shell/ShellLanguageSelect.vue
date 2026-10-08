<template>
  <q-select
    v-model="locale"
    :options="localeOptions"
    dense
    borderless
    emit-value
    map-options
    options-dense
    dark
    style="min-width: 100px"
  />
</template>

<script setup lang="ts">
// GCY1.5 (план gnauralcity, GCY-D29): выбор языка оболочки. Перенесён из
// `MindWaveCore/ui/layouts/MainLayout.vue` без изменения логики; ключ хранения — от префикса хоста
// (`./language.ts`, у MindWave — прежний `mindwave-locale`).
import { watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { localeStorageKey } from './language'

const { locale } = useI18n()

const localeOptions = [
  { value: 'en', label: 'English' },
  { value: 'ru', label: 'Русский' }
]

watch(locale, (val) => {
  localStorage.setItem(localeStorageKey(), val)
})
</script>
