// gnauralcity GCY1.5 (GCY-D22, GCY-D19): the shell's one host setting — the prefix of every name the
// shell writes outside the JS realm. localStorage keys, broadcast channels and named OS windows are
// shared by everything served from the same origin, so their names belong to the HOST, not to this
// kit. Two parts of the shell name things today: the panel framework (`*-panel-*` keys, the
// detached-window channel and window name — `@panel/panel-kit.ts` builds them through `hostKey`) and
// the language choice (`<prefix>locale` — `../shell/language.ts`). MindWave passes 'mindwave-' and
// keeps every key it has ever written byte for byte (the owner's saved layout and language stay in
// place, no migration); another host passes its own.
//
// ONE state for the whole shell: the panel framework's `configurePanelKit` is a thin entry into this
// same setting, not a second copy of it.
//
// There is deliberately NO default. A forgotten configuration would otherwise make a second product
// silently read and write under somebody else's prefix — so asking for a name before the host has set
// one throws. Names are built only when needed, never at module top level: modules are evaluated
// before the host's boot code runs.

export interface HostKeysOptions {
  /** Prepended to every name the shell writes outside the JS realm, e.g. 'mindwave-'. */
  readonly keyPrefix: string
}

let keyPrefix: string | null = null

/** Called by the host once, before anything in the shell names a key (MindWave: its first boot file). */
export function configureHostKeys(options: HostKeysOptions): void {
  if (typeof options.keyPrefix !== 'string' || options.keyPrefix === '') {
    throw new Error('host keys: keyPrefix must be a non-empty string (e.g. "mindwave-")')
  }
  keyPrefix = options.keyPrefix
}

/** Whether the host has configured its prefix — lets a caller refuse with its own words. */
export function isHostKeysConfigured(): boolean {
  return keyPrefix !== null
}

/**
 * `<keyPrefix><rest>` — the one place a shell name is made. For MindWave:
 * hostKey('locale') === 'mindwave-locale'.
 */
export function hostKey(rest: string): string {
  if (keyPrefix === null) {
    throw new Error(
      `shell key "${rest}" asked for before configureHostKeys({ keyPrefix }) — the host must call it ` +
        'in its first boot file; there is no default prefix',
    )
  }
  return `${keyPrefix}${rest}`
}
