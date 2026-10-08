<template>
  <q-dialog v-model="bunActionsDialog.isOpen" persistent class="main-layout__bun-actions-dialog">
    <q-card class="main-layout__bun-actions-card">
      <q-card-section class="main-layout__bun-actions-header">
        <div class="text-h6">{{ t('common.bunActionsTitle') }}</div>
        <div class="text-body2 text-grey-7">{{ t('common.bunActionsHint') }}</div>
      </q-card-section>

      <q-card-section class="main-layout__bun-actions-body">
        <div v-if="bunActionsDialog.loadingStatus" class="text-caption text-grey-6 q-mb-md">
          {{ t('common.bunActionsStatusLoading') }}
        </div>
        <div v-else-if="bunActionsDialog.statusError !== ''" class="text-caption text-negative q-mb-md">
          {{ bunActionsDialog.statusError }}
        </div>
        <div
          v-else-if="!bunActionsDialog.status.canRestartBun && bunActionsDialog.status.restartBunReason !== null"
          class="text-caption text-amber-9 q-mb-md"
        >
          {{ bunActionsDialog.status.restartBunReason }}
        </div>

        <q-checkbox
          v-model="bunActionsDialog.buildUi"
          :disable="bunActionsDialog.submitting || bunActionsDialog.loadingStatus"
          :label="t('common.bunActionBuildUi')"
        />
        <q-checkbox
          v-model="bunActionsDialog.restartBun"
          :disable="bunActionsDialog.submitting || bunActionsDialog.loadingStatus || bunActionsDialog.statusError !== '' || !bunActionsDialog.status.canRestartBun"
          :label="t('common.bunActionRestartBun')"
        />
        <q-checkbox
          v-for="extension in hostBunActions"
          :key="extension.key"
          v-model="bunActionsDialog.extensions[extension.key]"
          :disable="bunActionsDialog.submitting || bunActionsDialog.loadingStatus"
          :label="t(extension.labelKey)"
        />

        <div v-if="showBunActionsProgress" class="q-mt-md">
          <div class="text-subtitle2 q-mb-sm">{{ t('common.bunActionsProgressTitle') }}</div>
          <q-linear-progress v-if="bunActionsDialog.submitting" indeterminate color="primary" class="q-mb-sm" />
          <div
            v-for="action in bunActionProgressRows"
            :key="action.key"
            class="row items-center justify-between q-py-xs"
          >
            <div class="row items-center q-gutter-sm">
              <q-icon :name="bunActionStateIcon(action.state)" :color="bunActionStateColor(action.state)" size="18px" />
              <span>{{ action.label }}</span>
            </div>
            <span class="text-caption text-grey-7">{{ bunActionStateLabel(action.state) }}</span>
          </div>

          <div v-if="bunActionsDialog.results.length > 0" class="q-mt-sm">
            <div
              v-for="result in bunActionsDialog.results"
              :key="result"
              class="text-caption text-grey-7 q-py-xs"
            >
              {{ result }}
            </div>
          </div>

          <div v-if="bunActionsDialog.actionError !== ''" class="text-caption text-negative q-mt-sm">
            {{ bunActionsDialog.actionError }}
          </div>
        </div>
      </q-card-section>

      <q-card-actions align="right" class="main-layout__bun-actions-footer">
        <q-btn flat :disable="bunActionsDialog.submitting" :label="t('common.closeAction')" @click="closeBunActionsDialog" />
        <q-btn
          color="primary"
          :disable="!canSubmitBunActions"
          :label="t('common.okAction')"
          :loading="bunActionsDialog.submitting"
          @click="submitBunActions"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
// GCY1.5 (план gnauralcity, GCY-D29, GCY-D21): диалог «Bun-действия» оболочки и наблюдатель состояния
// связи. Перенесены блоками из `MindWaveCore/ui/layouts/MainLayout.vue` без изменения логики; правки —
// импорты, имена и обобщение `restartExe` в расширение от хоста (`./bun-actions.ts`): встроенных
// действий два (`buildUi`, `restartBun`), остальные хост передаёт пропом `bunActionExtensions`.
//
// Здесь же — ОДИН наблюдатель `connectionState`, как и было в MainLayout: он ведёт и фазы перезагрузки
// страницы после «Bun-действий», и плашку потери связи (`./connection-lost-notify.ts`). Разводить их
// нельзя: плашка не показывается, пока идёт перезагрузка, и порядок реакций внутри одного обработчика
// — часть поведения.
import { computed, onBeforeUnmount, reactive, watch } from 'vue'
import { useQuasar } from 'quasar'
import { useI18n } from 'vue-i18n'
import { wsService } from '../ws/ws'
import { adminApi, type AdminBunActionStatusResponse } from './admin-api'
import {
  bunActionOrderOf,
  registerBunActionsDialogOpener,
  type BunActionExtension,
  type BunActionKey,
} from './bun-actions'
import { useConnectionLostNotify } from './connection-lost-notify'

const props = withDefaults(defineProps<{
  /** Действия хоста сверх встроенных (MindWave — `restartExe`). Читаются один раз — это конфигурация. */
  bunActionExtensions?: readonly BunActionExtension[]
}>(), {
  bunActionExtensions: () => [],
})

const { t } = useI18n()
const $q = useQuasar()

const hostBunActions = props.bunActionExtensions
const bunActionExtensionByKey = new Map(hostBunActions.map((extension) => [extension.key, extension]))

type BunActionProgressState = 'idle' | 'pending' | 'running' | 'completed' | 'failed' | 'scheduled' | 'skipped'
type BunActionReloadPhase = 'idle' | 'scheduled' | 'await-disconnect' | 'await-reconnect'

const BUN_ACTION_RELOAD_DELAY_MS = 400

const defaultBunActionStatus = (): AdminBunActionStatusResponse => ({
  canRestartBun: true,
  restartBunReason: null,
  isWatchMode: false,
})

const bunActionOrder: readonly BunActionKey[] = bunActionOrderOf(hostBunActions)

const bunActionsDialog = reactive({
  isOpen: false,
  buildUi: false,
  restartBun: false,
  extensions: Object.fromEntries(hostBunActions.map((extension) => [extension.key, false])) as Record<BunActionKey, boolean>,
  submitting: false,
  loadingStatus: false,
  statusError: '',
  actionError: '',
  results: [] as string[],
  status: defaultBunActionStatus(),
  progress: Object.fromEntries(bunActionOrder.map((action) => [action, 'idle'])) as Record<BunActionKey, BunActionProgressState>,
})

const bunActionReload = reactive({
  phase: 'idle' as BunActionReloadPhase,
})

let bunActionReloadTimer: ReturnType<typeof setTimeout> | null = null

function resetBunActionsSelection(): void {
  bunActionsDialog.buildUi = false
  bunActionsDialog.restartBun = false
  for (const extension of hostBunActions) {
    bunActionsDialog.extensions[extension.key] = false
  }
}

function resetBunActionsProgress(): void {
  bunActionsDialog.actionError = ''
  bunActionsDialog.results = []
  for (const action of bunActionOrder) {
    bunActionsDialog.progress[action] = 'idle'
  }
}

function resetBunActionsDialog(): void {
  resetBunActionsSelection()
  resetBunActionsProgress()
  bunActionsDialog.loadingStatus = false
  bunActionsDialog.statusError = ''
  bunActionsDialog.status = defaultBunActionStatus()
}

function setBunActionProgress(action: BunActionKey, state: BunActionProgressState): void {
  bunActionsDialog.progress[action] = state
}

function clearBunActionReloadTimer(): void {
  if (bunActionReloadTimer === null) {
    return
  }

  clearTimeout(bunActionReloadTimer)
  bunActionReloadTimer = null
}

function resetBunActionReload(): void {
  clearBunActionReloadTimer()
  bunActionReload.phase = 'idle'
}

function reloadPageAfterBunActions(): void {
  resetBunActionReload()
  window.location.reload()
}

function scheduleBunActionReload(waitForReconnect: boolean): void {
  bunActionsDialog.isOpen = false

  if (waitForReconnect) {
    bunActionReload.phase = wsService.connectionState.value === 'connected'
      ? 'await-disconnect'
      : 'await-reconnect'
    return
  }

  resetBunActionReload()
  bunActionReload.phase = 'scheduled'
  bunActionReloadTimer = setTimeout(() => {
    reloadPageAfterBunActions()
  }, BUN_ACTION_RELOAD_DELAY_MS)
}

function isBunActionSelected(action: BunActionKey): boolean {
  if (action === 'buildUi') {
    return bunActionsDialog.buildUi
  }

  if (action === 'restartBun') {
    return bunActionsDialog.restartBun && bunActionsDialog.statusError === '' && bunActionsDialog.status.canRestartBun
  }

  return bunActionsDialog.extensions[action] === true
}

function getSelectedBunActions(): BunActionKey[] {
  const actions: BunActionKey[] = []

  for (const action of bunActionOrder) {
    if (isBunActionSelected(action)) {
      actions.push(action)
    }
  }

  return actions
}

async function loadBunActionStatus(): Promise<void> {
  bunActionsDialog.loadingStatus = true
  bunActionsDialog.statusError = ''

  try {
    bunActionsDialog.status = await adminApi.fetchBunActionStatus()
    if (!bunActionsDialog.status.canRestartBun) {
      bunActionsDialog.restartBun = false
    }
  } catch (error) {
    bunActionsDialog.statusError = error instanceof Error ? error.message : t('common.bunActionsStatusFailed')
  } finally {
    bunActionsDialog.loadingStatus = false
  }
}

function openBunActionsDialog(): void {
  bunActionsDialog.isOpen = true
  resetBunActionsProgress()
  void loadBunActionStatus()
}

const releaseBunActionsDialogOpener = registerBunActionsDialogOpener(openBunActionsDialog)

function closeBunActionsDialog(): void {
  if (bunActionsDialog.submitting) {
    return
  }

  bunActionsDialog.isOpen = false
}

async function submitBunActions(): Promise<void> {
  if (bunActionsDialog.submitting) {
    return
  }

  const selectedActions = getSelectedBunActions()
  if (selectedActions.length === 0) {
    return
  }

  resetBunActionsProgress()
  for (const action of selectedActions) {
    setBunActionProgress(action, 'pending')
  }

  bunActionsDialog.submitting = true

  try {
    for (const action of selectedActions) {
      setBunActionProgress(action, 'running')

      if (action === 'buildUi') {
        await adminApi.buildUi()
        setBunActionProgress(action, 'completed')
        bunActionsDialog.results.push(t('common.bunActionBuildUiCompleted'))
        continue
      }

      const extension = bunActionExtensionByKey.get(action)
      if (extension !== undefined) {
        await extension.run()
        setBunActionProgress(action, 'completed')
        bunActionsDialog.results.push(t(extension.completedKey))
        continue
      }

      await adminApi.restartBun()
      setBunActionProgress(action, 'scheduled')
      bunActionsDialog.results.push(t('common.bunActionRestartBunScheduled'))
    }

    $q.notify({
      type: selectedActions.includes('restartBun') ? 'info' : 'positive',
      message: selectedActions.includes('restartBun') ? t('common.bunActionsRestartScheduled') : t('common.bunActionsApplied'),
      timeout: 2500,
    })

    scheduleBunActionReload(selectedActions.includes('restartBun'))
  } catch (error) {
    const activeAction = bunActionOrder.find((action) => bunActionsDialog.progress[action] === 'running')
    if (activeAction !== undefined) {
      setBunActionProgress(activeAction, 'failed')
      let markSkipped = false

      for (const action of selectedActions) {
        if (action === activeAction) {
          markSkipped = true
          continue
        }

        if (markSkipped && bunActionsDialog.progress[action] === 'pending') {
          setBunActionProgress(action, 'skipped')
        }
      }
    }

    bunActionsDialog.actionError = error instanceof Error ? error.message : t('common.bunActionsFailed')
    $q.notify({
      type: 'negative',
      message: bunActionsDialog.actionError,
    })
  } finally {
    bunActionsDialog.submitting = false

    if (!bunActionsDialog.isOpen) {
      resetBunActionsDialog()
    }
  }
}

const canSubmitBunActions = computed(() => {
  return !bunActionsDialog.loadingStatus && !bunActionsDialog.submitting && getSelectedBunActions().length > 0
})

function bunActionLabel(action: BunActionKey): string {
  if (action === 'buildUi') {
    return t('common.bunActionBuildUi')
  }

  const extension = bunActionExtensionByKey.get(action)
  return extension !== undefined
    ? t(extension.labelKey)
    : t('common.bunActionRestartBun')
}

const bunActionProgressRows = computed(() => {
  return bunActionOrder
    .map((action) => ({
      key: action,
      label: bunActionLabel(action),
      state: bunActionsDialog.progress[action],
      active: getSelectedBunActions().includes(action) || bunActionsDialog.progress[action] !== 'idle',
    }))
    .filter((action) => action.active)
})

const showBunActionsProgress = computed(() => {
  return bunActionProgressRows.value.length > 0
})

function bunActionStateIcon(state: BunActionProgressState): string {
  switch (state) {
    case 'completed': return 'check_circle'
    case 'scheduled': return 'schedule'
    case 'failed': return 'error'
    case 'running': return 'sync'
    case 'pending': return 'hourglass_empty'
    case 'skipped': return 'redo'
    default: return 'radio_button_unchecked'
  }
}

function bunActionStateColor(state: BunActionProgressState): string {
  switch (state) {
    case 'completed': return 'positive'
    case 'scheduled': return 'info'
    case 'failed': return 'negative'
    case 'running': return 'primary'
    case 'pending': return 'warning'
    case 'skipped': return 'grey-6'
    default: return 'grey-5'
  }
}

function bunActionStateLabel(state: BunActionProgressState): string {
  switch (state) {
    case 'completed': return t('common.bunActionStateCompleted')
    case 'scheduled': return t('common.bunActionStateScheduled')
    case 'failed': return t('common.bunActionStateFailed')
    case 'running': return t('common.bunActionStateRunning')
    case 'pending': return t('common.bunActionStatePending')
    case 'skipped': return t('common.bunActionStateSkipped')
    default: return t('common.bunActionStateIdle')
  }
}

watch(() => bunActionsDialog.isOpen, (isOpen) => {
  if (isOpen) {
    return
  }

  if (!bunActionsDialog.submitting) {
    resetBunActionsDialog()
  }
})

const { showConnectionLostNotify, hideConnectionLostNotify } = useConnectionLostNotify()

watch(() => wsService.connectionState.value, (state, prevState) => {
  if (bunActionReload.phase === 'await-disconnect') {
    if (state !== 'connected') {
      bunActionReload.phase = 'await-reconnect'
    }
    return
  }

  if (bunActionReload.phase === 'await-reconnect' && state === 'connected') {
    reloadPageAfterBunActions()
    return
  }

  if (prevState === 'connected' && state === 'disconnected' && bunActionReload.phase === 'idle') {
    showConnectionLostNotify()
  }

  if (state === 'connected') {
    hideConnectionLostNotify()
  }
})

onBeforeUnmount(() => {
  releaseBunActionsDialogOpener()
  resetBunActionReload()
})
</script>

<style scoped>
.main-layout__bun-actions-card {
  border-radius: 0;
  max-width: 92vw;
  min-width: 360px;
  overflow: hidden;
}

.main-layout__bun-actions-header {
  border-bottom: 1px solid rgba(148, 163, 184, 0.18);
  padding: 16px;
}

.main-layout__bun-actions-body {
  padding: 16px;
}

.main-layout__bun-actions-footer {
  border-top: 1px solid rgba(148, 163, 184, 0.18);
  padding: 12px 16px;
}

@media (max-width: 480px) {
  .main-layout__bun-actions-card {
    min-width: min(100vw - 16px, 360px);
  }
}
</style>
