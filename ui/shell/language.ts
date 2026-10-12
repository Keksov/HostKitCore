// GCY1.5 (план gnauralcity, GCY-D29, GCY-D22): выбор языка оболочки — где он хранится. Ключ
// localStorage строит префикс хоста (`../app/host-keys.ts`): у MindWave это ровно `mindwave-locale`,
// как до переезда, — сохранённый владельцем язык остаётся на месте. Пишет его смена языка
// (`selectAppLocale` ниже — её зовут выбор языка в шапке `ShellLanguageSelect.vue` и пункт меню хоста),
// читает — `installHostI18n` (`../app/host-i18n.ts`) при создании i18n.
import { hostKey } from '../app/host-keys'

/** Ключ localStorage выбранного языка: `<префикс хоста>locale`. Только после настройки ключей хоста. */
export function localeStorageKey(): string {
  return hostKey('locale')
}

/**
 * Язык приложения, который меняет выбор: `locale` глобального композера vue-i18n. В компоненте это
 * `useI18n().locale`, вне компонента — `locale` из того, что вернул `installHostI18n`; это один и тот
 * же объект.
 */
export interface AppLocaleRef {
  value: string
}

/**
 * gnauralcity GCY2.2 (GCY-D21): сменить язык приложения и запомнить выбор под ключом хоста — одно
 * действие для всех, кто язык выбирает: выбор в шапке (`ShellLanguageSelect.vue`) и пункт «Язык» меню
 * AudioPage, который хост передаёт модулю (форма «пункты меню», GCY-D18). Сменить, не запомнив, нельзя:
 * после перезагрузки язык разошёлся бы с выбранным.
 */
export function selectAppLocale(aLocale: AppLocaleRef, aValue: string): void {
  aLocale.value = aValue
  localStorage.setItem(localeStorageKey(), aValue)
}
