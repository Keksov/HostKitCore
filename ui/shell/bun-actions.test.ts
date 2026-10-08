// gnauralcity GCY1.5 (GCY-D29): the lock of the "Bun actions" extension form and of the dialog opener.
//
// Pinned down:
//   1. the order the shell runs actions in — built-ins buildUi → restartBun, a host's actions placed
//      before the built-in they name. MindWave's restartExe (before restartBun) gives exactly the order
//      MainLayout had before the move: buildUi → restartExe → restartBun;
//   2. a host action cannot take a built-in's key or another action's key, nor name an unknown place;
//   3. opening the dialog reaches the dialog that registered itself, and only while it is registered —
//      an unregistered dialog throws instead of silently doing nothing; releasing a stale registration
//      does not drop a newer one.
//
// Run (part of the verify procedure, see AGENTS.md):
//   cd HostKitCore && bun test
import { describe, expect, test } from 'bun:test'

import {
  bunActionOrderOf,
  openBunActionsDialog,
  registerBunActionsDialogOpener,
  type BunActionExtension,
} from './bun-actions'

const action = (key: string, before: BunActionExtension['before']): BunActionExtension => ({
  key,
  labelKey: `x.${key}`,
  completedKey: `x.${key}Completed`,
  run: async () => undefined,
  before,
})

describe('Bun actions: order of execution', () => {
  test('no host actions: the built-ins only', () => {
    expect(bunActionOrderOf([])).toEqual(['buildUi', 'restartBun'])
  })

  test("MindWave's restartExe before restartBun: buildUi → restartExe → restartBun (as before GCY1.5)", () => {
    expect(bunActionOrderOf([action('restartExe', 'restartBun')])).toEqual(['buildUi', 'restartExe', 'restartBun'])
  })

  test('several host actions keep the host list order at each place', () => {
    expect(bunActionOrderOf([action('b', 'restartBun'), action('a', 'buildUi'), action('c', 'restartBun')]))
      .toEqual(['a', 'buildUi', 'b', 'c', 'restartBun'])
  })

  test('a host action cannot take a taken key or name an unknown place', () => {
    expect(() => bunActionOrderOf([action('buildUi', 'restartBun')])).toThrow('ключ расширения "buildUi" занят')
    expect(() => bunActionOrderOf([action('x', 'restartBun'), action('x', 'buildUi')])).toThrow('ключ расширения "x" занят')
    expect(() => bunActionOrderOf([action('x', 'nowhere' as BunActionExtension['before'])])).toThrow('неизвестное место "nowhere"')
  })
})

describe('Bun actions: opening the dialog', () => {
  test('opens the registered dialog; without one it throws; a stale release keeps the newer one', () => {
    const opened: string[] = []
    const releaseFirst = registerBunActionsDialogOpener(() => { opened.push('first') })
    openBunActionsDialog()
    const releaseSecond = registerBunActionsDialogOpener(() => { opened.push('second') })
    releaseFirst() // the first dialog unmounts AFTER the second registered: must not drop the second
    openBunActionsDialog()
    releaseSecond()
    expect(() => openBunActionsDialog()).toThrow('диалог не смонтирован')
    expect(opened).toEqual(['first', 'second'])
  })
})
