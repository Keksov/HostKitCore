// gnauralcity GCY1.3 (GCY-D22, GCY-D19): the panel framework's one host setting — the prefix of
// every name it writes outside the JS realm. The framework persists per-panel and per-window state
// in localStorage and talks to detached windows over named channels and named OS windows; all of
// these are shared by everything served from the same origin, so their names must belong to the
// HOST, not to this kit. MindWave passes 'mindwave-' and keeps every key it has ever written byte
// for byte (the owner's saved layout stays in place, no migration); another host passes its own.
//
// There is deliberately NO default. A forgotten configurePanelKit() would otherwise make a second
// product silently read and write under somebody else's prefix — so asking for a name before the
// host has set one throws, naming the call that is missing.
//
// Every name is built by panelKitName() and nowhere else, and only when it is needed — never at
// module top level: modules are evaluated before the host's boot code runs.

export interface PanelKitOptions {
  /** Prepended to every storage key, channel name and window name, e.g. 'mindwave-'. */
  readonly keyPrefix: string
}

let keyPrefix: string | null = null

/** Called by the host once, before anything uses the panel framework (MindWave: a boot file). */
export function configurePanelKit(options: PanelKitOptions): void {
  if (typeof options.keyPrefix !== 'string' || options.keyPrefix === '') {
    throw new Error('configurePanelKit: keyPrefix must be a non-empty string (e.g. "mindwave-")')
  }
  keyPrefix = options.keyPrefix
}

/**
 * `<keyPrefix>panel<rest>` — the one place a panel-framework name is made. For MindWave:
 * panelKitName('-layout') === 'mindwave-panel-layout'.
 */
export function panelKitName(rest: string): string {
  if (keyPrefix === null) {
    throw new Error(
      'panel framework (@panel) used before configurePanelKit({ keyPrefix }) — the host must call it ' +
        'before any panel state, layout or detached window is created; there is no default prefix',
    )
  }
  return `${keyPrefix}panel${rest}`
}
