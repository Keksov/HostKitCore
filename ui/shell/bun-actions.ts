// GCY1.5 (план gnauralcity, GCY-D29, GCY-D21): «Bun-действия» оболочки — то, что знают о диалоге
// снаружи. Сам диалог (`ShellBunActionsDialog.vue`) смонтирован в голом макете (`ShellLayout.vue`);
// здесь — две вещи, которые нужны тем, кто его НЕ содержит:
//
//   1. РАСШИРЕНИЕ ОТ ХОСТА. У оболочки два встроенных действия — `buildUi` («Build UI», ручка
//      `build-ui`) и `restartBun` («Restart bun», `restart-bun`). Хост добавляет свои — ровно той формой,
//      какая нужна сегодня: ключ, подпись, строка «готово», функция и место в порядке выполнения.
//      MindWave так добавляет `restartExe` (перезапуск BodyMonitor.exe) — порядок для него прежний:
//      buildUi → restartExe → restartBun. Флажок расширения в диалоге стоит после встроенных, в порядке
//      списка хоста (так было и до переезда: «Restart exe» — под «Restart bun»).
//   2. ОТКРЫТИЕ ДИАЛОГА. Открывает его не только индикатор связи в шапке хоста (Ctrl+клик), но в
//      будущем и пункт меню страницы (GCY2.2) — оба зовут `openBunActionsDialog()`, и открывается один и
//      тот же диалог.
//
// Модуль чистый: ни vue, ни quasar, ни i18n — его можно проверить юнитом без DOM.

/** Встроенные действия оболочки в порядке выполнения. `restartBun` — последним: он перезапускает сервер. */
export const BUILTIN_BUN_ACTIONS = ['buildUi', 'restartBun'] as const

export type BuiltinBunActionKey = (typeof BUILTIN_BUN_ACTIONS)[number]

/** Ключ действия: встроенный или ключ расширения хоста. */
export type BunActionKey = string

export interface BunActionExtension {
  /** Уникальный ключ действия; не может совпадать со встроенным. */
  readonly key: string
  /** Ключ i18n подписи — и у флажка, и у строки прогресса. */
  readonly labelKey: string
  /** Ключ i18n строки результата после успешного выполнения. */
  readonly completedKey: string
  /** Само действие; отказ (исключение) показывается диалогом так же, как отказ встроенного. */
  readonly run: () => Promise<unknown>
  /** Место в порядке выполнения: перед каким встроенным действием выполнить это. */
  readonly before: BuiltinBunActionKey
}

/**
 * Порядок выполнения (и строк прогресса): встроенные действия по порядку, а перед каждым — расширения,
 * назначенные «перед ним», в порядке списка хоста. Для MindWave (`restartExe` перед `restartBun`):
 * ['buildUi', 'restartExe', 'restartBun'].
 */
export function bunActionOrderOf(extensions: readonly BunActionExtension[]): BunActionKey[] {
  const seen = new Set<string>(BUILTIN_BUN_ACTIONS)
  for (const extension of extensions) {
    if (seen.has(extension.key)) {
      throw new Error(`Bun-действия: ключ расширения "${extension.key}" занят (встроенным или другим расширением)`)
    }
    if (!(BUILTIN_BUN_ACTIONS as readonly string[]).includes(extension.before)) {
      throw new Error(`Bun-действия: расширение "${extension.key}" ссылается на неизвестное место "${extension.before}"`)
    }
    seen.add(extension.key)
  }

  const order: BunActionKey[] = []
  for (const builtin of BUILTIN_BUN_ACTIONS) {
    for (const extension of extensions) {
      if (extension.before === builtin) {
        order.push(extension.key)
      }
    }
    order.push(builtin)
  }

  return order
}

let openDialog: (() => void) | null = null

/**
 * Диалог регистрирует, как его открыть, при своём создании; возвращает отмену регистрации (на
 * размонтирование). Отмена снимает только СВОЮ регистрацию — если к тому времени зарегистрировался
 * другой экземпляр (пересоздание макета), его не трогает.
 */
export function registerBunActionsDialogOpener(open: () => void): () => void {
  openDialog = open
  return () => {
    if (openDialog === open) {
      openDialog = null
    }
  }
}

/** Открыть диалог «Bun-действия». Без смонтированного макета оболочки — исключение, а не тишина. */
export function openBunActionsDialog(): void {
  if (openDialog === null) {
    throw new Error('Bun-действия: диалог не смонтирован — голый макет оболочки (ShellLayout) не на экране')
  }
  openDialog()
}
