// GCY1.4 (план gnauralcity, GCY-D29): склейка сообщений i18n приложения — хост, оболочка, модули.
// Функции слияния переехали сюда из `MindWaveCore/ui/src/i18n/index.ts` без изменений; хосту
// остаётся отдать свои локали и свой список модулей.
//
// КОНТРАКТ С ХОСТОМ: в локалях хоста обязан быть ключ `app.title` — имя продукта. HostKitCore его не
// даёт (продукта он не знает), а страница отсоединённой панели (`PanelHostPage.vue`) ставит его
// заголовком окна, пока панель не найдена.
import panelEn from '../panel/locales/en.json'
import panelRu from '../panel/locales/ru.json'
import type { CoreModuleDescriptor, LocaleMessages, MessageTree } from './module-registry'

type MutableMessageTree = Record<string, unknown>

function isMessageTree(value: unknown): value is MutableMessageTree {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mergeMessageTrees(target: MutableMessageTree, source: MessageTree): MutableMessageTree {
  const result: MutableMessageTree = { ...target }

  for (const [key, sourceValue] of Object.entries(source)) {
    const targetValue = result[key]
    result[key] = isMessageTree(targetValue) && isMessageTree(sourceValue)
      ? mergeMessageTrees(targetValue, sourceValue)
      : sourceValue
  }

  return result
}

function mergeLocaleMessages(...bundles: readonly LocaleMessages[]): LocaleMessages {
  const result: Record<string, MutableMessageTree> = {}

  for (const bundle of bundles) {
    for (const [locale, messages] of Object.entries(bundle)) {
      result[locale] = result[locale] === undefined
        ? { ...messages }
        : mergeMessageTrees(result[locale], messages)
    }
  }

  return result as LocaleMessages
}

/** Сообщения самой оболочки: подписи каркаса панелей `panel.*` (GCY1.3). */
const shellMessages: LocaleMessages = { en: panelEn, ru: panelRu }

/**
 * Дерево сообщений приложения. Порядок — хост, оболочка, модули по порядку списка хоста; следующий
 * перекрывает предыдущий по листьям, поддеревья сливаются. Оболочка — сразу за хостом: до GCY1.3
 * `panel` был последней веткой локалей хоста, поэтому итоговое дерево сохраняет прежний порядок
 * ключей, а модули по-прежнему ложатся поверх.
 */
export function assembleAppMessages(
  hostMessages: LocaleMessages,
  modules: readonly CoreModuleDescriptor[],
): LocaleMessages {
  return mergeLocaleMessages(hostMessages, shellMessages, ...modules.map((module) => module.messages))
}
