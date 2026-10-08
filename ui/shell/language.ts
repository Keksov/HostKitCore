// GCY1.5 (план gnauralcity, GCY-D29, GCY-D22): выбор языка оболочки — где он хранится. Ключ
// localStorage строит префикс хоста (`../app/host-keys.ts`): у MindWave это ровно `mindwave-locale`,
// как до переезда, — сохранённый владельцем язык остаётся на месте. Пишет его выбор языка оболочки
// (`ShellLanguageSelect.vue`), читает — boot-файл i18n хоста при создании i18n.
import { hostKey } from '../app/host-keys'

/** Ключ localStorage выбранного языка: `<префикс хоста>locale`. Только после настройки ключей хоста. */
export function localeStorageKey(): string {
  return hostKey('locale')
}
