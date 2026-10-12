<template>
  <q-select
    v-model="selectedLocale"
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
// GCY2.2: смена языка — общая функция оболочки `selectAppLocale` (её же зовёт пункт «Язык» меню
// AudioPage у Gnauralcity): меняет язык и пишет выбор под ключом хоста. Прежний наблюдатель за
// `locale` делал то же самое, но только пока этот выбор смонтирован; других писателей языка нет.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { selectAppLocale } from './language'

const { locale } = useI18n()

const selectedLocale = computed({
  get: () => locale.value,
  set: (val: string) => {
    selectAppLocale(locale, val)
  },
})

const localeOptions = [
  { value: 'en', label: 'English' },
  { value: 'ru', label: 'Русский' }
]
</script>
