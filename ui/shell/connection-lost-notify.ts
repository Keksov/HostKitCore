// GCY1.5 (план gnauralcity, GCY-D29, GCY-D21): плашка потери связи с сервером — уведомление Quasar
// поверх страницы, которое висит, пока связь не вернётся. Функции перенесены из
// `MindWaveCore/ui/layouts/MainLayout.vue` без изменений; КОГДА её показывать и снимать, решает
// наблюдатель состояния связи в `ShellBunActionsDialog.vue` — тот же, что ведёт перезагрузку после
// «Bun-действий»: пока идёт перезапуск, обрыв ожидаем и плашки нет. Один наблюдатель, как и раньше.
import { useQuasar } from 'quasar'
import { useI18n } from 'vue-i18n'

/** Вызывать из setup компонента: берёт `$q` и `t` текущего приложения. */
export function useConnectionLostNotify(): {
  showConnectionLostNotify: () => void
  hideConnectionLostNotify: () => void
} {
  const $q = useQuasar()
  const { t } = useI18n()

  let dismissConnectionLostNotify: (() => void) | null = null

  function showConnectionLostNotify(): void {
    if (dismissConnectionLostNotify !== null) {
      return
    }
    dismissConnectionLostNotify = $q.notify({
      type: 'negative',
      position: 'top',
      message: t('common.connectionLost'),
      timeout: 0,
      group: 'connection-lost',
    })
  }

  function hideConnectionLostNotify(): void {
    if (dismissConnectionLostNotify === null) {
      return
    }
    dismissConnectionLostNotify()
    dismissConnectionLostNotify = null
  }

  return { showConnectionLostNotify, hideConnectionLostNotify }
}
