# HostKitCore

Shared shell and build kit for the hosts of the KKMindWave workspace (MindWave today, Gnauralcity
next). Layering: hosts -> modules (`GnauralCore`, `BodyMonitorCore`) -> HostKitCore. HostKitCore
knows no product: it never imports a host or a module, and the list of hosts lives in the
workspace registry `hosts.json` (workspace root), not here.

It receives what a host gives its modules today, in a generalized form (plan `gnauralcity`,
decisions GCY-D2, GCY-D29, GCY-D17 in `MindWaveCore/docs/gnauralcity/gnauralcity-plan.md`):

- `@panel` and `@tooltip` — the aliases keep their names, only their target moves here
  (step GCY1.3);
- the ws transport with module registration, the module registry and app assembly (routes, panels,
  i18n), the detached-panel page and route (GCY1.4);
- shell services and the bare layout: connection banner, "Bun actions", language (GCY1.5);
- the host UI factory: quasar config and a base tsconfig with one pinned copy of shared libraries
  (GCY1.6);
- the server skeleton: start-up, routing by module, admin endpoints, shutdown chain, HTTP and
  loopback utilities (GCY1.7).

Each part arrives by its own move step, with its tests and its verify steps. Landed so far:

- GCY1.3 — `ui/panel` (`@panel`, with its `panel.*` locales in `ui/panel/locales`) and `ui/tooltip`
  (`@tooltip`). The panel framework names its localStorage keys, bridge channels and detached
  windows from a prefix the HOST gives it — `configurePanelKit({ keyPrefix })` (`ui/panel/panel-kit.ts`)
  before first use; there is no default, an unconfigured call throws (GCY-D22).
- GCY1.4 — behind the `@hostkit` alias (target: `ui/`):
  - `ui/ws/ws.ts` — the ws transport, one per app (`wsService`). It knows no module protocol: a module
    registers, when its plugin is installed, its event handlers (`registerHandler`; dispatch runs them
    in registration order and stops at the first `true`, so the host's plugin install order is the
    dispatch order), the message types that arm the liveness clock (`registerAnsweredTypes`) and the
    type prefixes multicast to subscribers past dispatch (`registerPrefixChannel`). The shell's own
    `ui_echo` liveness echo, reconnect and the `/ws/ui` address stay here.
  - `ui/app/module-registry.ts` — the module contract (`CoreModuleDescriptor`) and `assembleModules`
    (routes, settings tabs, panels in the host's module order); `ui/app/app-messages.ts` —
    `assembleAppMessages` (host, then the shell's captions, then modules). A host's locales must
    carry `app.title` (the product name).
  - `ui/app/PanelHostPage.vue` + `panelHostRoute(panels)` (`ui/app/panel-host-route.ts`) — the
    detached-panel page at `#/panel/<id>`; the host hands it its panels as a route prop.
- GCY1.5 — the shell services and the bare layout (`@hostkit/shell/...`, `ui/shell`):
  - `ui/app/host-keys.ts` — the shell's ONE host setting, the key prefix: `configureHostKeys({ keyPrefix })`
    in the host's first boot file, `hostKey(rest)` builds every name. The panel framework builds its
    names through it (`configurePanelKit` is now a thin entry into the same setting), and so does the
    language key (`<prefix>locale`, `ui/shell/language.ts` — MindWave's stays `mindwave-locale`).
    No default; an unconfigured call throws.
  - `ui/shell/ShellLayout.vue` — the bare layout: `q-layout` (prop `view`) + an optional `header` slot
    (the host's whole `q-header`) + `q-page-container` with `router-view`. It mounts the shell services
    every host gets: the "Bun actions" dialog (`ShellBunActionsDialog.vue`) and the connection-lost
    banner (a Quasar notify on top of the page, `connection-lost-notify.ts`; one watcher of the
    connection state drives both the banner and the page reload after a Bun restart, as before the move).
  - `ui/shell/ShellConnectionIndicator.vue` (Bun connection icon; Ctrl+click opens the dialog through
    `openBunActionsDialog()`, `ui/shell/bun-actions.ts`) and `ui/shell/ShellLanguageSelect.vue`.
  - `ui/shell/admin-api.ts` — the client of `/api/admin/bun-actions` with the built-in actions `build-ui`
    and `restart-bun`. A host adds its own actions with `bunActionExtensions` on `ShellLayout` (key,
    label, "completed" text, function, and the built-in it runs before); MindWave adds `restart-exe`.
  - `ui/shell/locales` — the services' `common.*` and `language.*` captions; `assembleAppMessages`
    merges host, then shell services, then `panel.*`, then modules.
- GCY1.6 — the host UI factory (`ui/factory`, build-time node code; not behind an alias, a host imports
  it by path from its `quasar.config.ts`). A host's config is `export const hostUi: HostUiConfig = {...}`
  (`ui/factory/host-ui.ts`: its ui/ and the HostKitCore dir, boot, css, extras, distDir, its own aliases
  for the bundler and for tsconfig, its modules' third-party libraries `modulePins`, manual chunks,
  default backend port, warn build switch and marker, quasar `framework`) plus
  `export default hostQuasarConfig(hostUi)` (`ui/factory/quasar-config.ts`). The factory adds what every
  host shares: the pin of ONE copy of the shell's packages (`SHELL_PINS` in `ui/factory/pins.ts`: vue,
  pinia, vue-i18n, vue-router, quasar) and of `modulePins`, the shell's aliases `@panel`, `@tooltip`,
  `@hostkit`, the hash router, the es2022 target, the dev proxy of `/api` and `/ws/ui` (PORT, then
  SERVER_PORT, then the host's default), the warn build, the manual chunks.
  - The pin's second half is tsconfig `paths`. A `paths` in an extending tsconfig REPLACES the base's,
    so the whole block is generated into the host: `<host ui>/tsconfig.hostkit.json` (extends
    `ui/factory/tsconfig.base.json` — the shared compiler options), which the host's `tsconfig.json`
    extends, keeping its own include/exclude. Regenerate after changing the pin or the host's aliases:
    `bun ../../HostKitCore/ui/factory/write-host-tsconfig.ts .` from the host's ui/ (the host directory
    is an argument — HostKitCore knows no host). Whether each registered host's file is current is a
    workspace check: `validate-qa.js` (workspace root) renders it for every host of `hosts.json` and
    reddens while it is stale. `ui/factory/factory.test.ts` tests the factory on a host given in the
    test (nothing outside HostKitCore is read): the bundler's aliases and the `paths` send each pinned
    package to the same place.
  - The host excludes `ui/factory/**` from its browser program; the factory is type-checked through its
    test in the host's test program (bun's types — the node environment it runs in).

Tests: `bun test` in this directory, with no path (verify step `hostkit-tests` in
`MindWaveCore/uitest/src/verify-steps.ts`). They need `bun install` in `ui/` once (vue, as in
`GnauralCore/ui`).
