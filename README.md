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
    `assembleAppMessages` (host, then the shell's `panel.*`, then modules). A host's locales must
    carry `app.title` (the product name).
  - `ui/app/PanelHostPage.vue` + `panelHostRoute(panels)` (`ui/app/panel-host-route.ts`) — the
    detached-panel page at `#/panel/<id>`; the host hands it its panels as a route prop.

Tests: `bun test` in this directory, with no path (verify step `hostkit-tests` in
`MindWaveCore/uitest/src/verify-steps.ts`). They need `bun install` in `ui/` once (vue, as in
`GnauralCore/ui`).
