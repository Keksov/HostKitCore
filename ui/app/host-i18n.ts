// GCY2.1 (план gnauralcity, GCY-D17, GCY-D22): vue-i18n приложения хоста. Тело переехало сюда из
// boot-файла `MindWaveCore/ui/src/boot/i18n.ts` без изменений: язык — сохранённый под ключом хоста
// (`<префикс>locale`, у MindWave — прежний `mindwave-locale`, `../shell/language.ts`), иначе русский;
// резервный — английский; Composition API. Хост зовёт это из своего boot-файла со СВОИМИ сообщениями
// (`assembleAppMessages`, `./app-messages.ts`) — после того, как назвал префикс ключей
// (`configureHostKeys`, `./host-keys.ts`): ключ языка строится от него.
import type { App } from 'vue'
import { createI18n } from 'vue-i18n'

import { localeStorageKey, type AppLocaleRef } from '../shell/language'
import type { LocaleMessages } from './module-registry'

/** Язык, когда сохранённого нет. */
export const DEFAULT_LOCALE = 'ru'
/** Язык, из которого берётся подпись, которой нет в выбранном. */
export const FALLBACK_LOCALE = 'en'

/**
 * gnauralcity GCY2.2: что хост получает от установки — язык приложения для тех, кто меняет его ВНЕ
 * компонента (пункт «Язык» меню, который хост собирает в своём boot-файле). Это тот же объект, что
 * `useI18n().locale` в компонентах; менять его — через `selectAppLocale` (`../shell/language.ts`),
 * чтобы выбор запомнился. Отдаётся возвратом, а не хранится в оболочке: у i18n один владелец — хост.
 */
export interface HostI18n {
  readonly locale: AppLocaleRef
}

export function installHostI18n(app: App, messages: LocaleMessages): HostI18n {
  const savedLocale = localStorage.getItem(localeStorageKey()) ?? DEFAULT_LOCALE

  const i18n = createI18n({
    locale: savedLocale,
    fallbackLocale: FALLBACK_LOCALE,
    legacy: false,
    messages: messages as Record<string, any>
  })

  app.use(i18n)
  return { locale: i18n.global.locale }
}
