// GCY2.1 (план gnauralcity, GCY-D17, GCY-D22): vue-i18n приложения хоста. Тело переехало сюда из
// boot-файла `MindWaveCore/ui/src/boot/i18n.ts` без изменений: язык — сохранённый под ключом хоста
// (`<префикс>locale`, у MindWave — прежний `mindwave-locale`, `../shell/language.ts`), иначе русский;
// резервный — английский; Composition API. Хост зовёт это из своего boot-файла со СВОИМИ сообщениями
// (`assembleAppMessages`, `./app-messages.ts`) — после того, как назвал префикс ключей
// (`configureHostKeys`, `./host-keys.ts`): ключ языка строится от него.
import type { App } from 'vue'
import { createI18n } from 'vue-i18n'

import { localeStorageKey } from '../shell/language'
import type { LocaleMessages } from './module-registry'

/** Язык, когда сохранённого нет. */
export const DEFAULT_LOCALE = 'ru'
/** Язык, из которого берётся подпись, которой нет в выбранном. */
export const FALLBACK_LOCALE = 'en'

export function installHostI18n(app: App, messages: LocaleMessages): void {
  const savedLocale = localStorage.getItem(localeStorageKey()) ?? DEFAULT_LOCALE

  const i18n = createI18n({
    locale: savedLocale,
    fallbackLocale: FALLBACK_LOCALE,
    legacy: false,
    messages: messages as Record<string, any>
  })

  app.use(i18n)
}
