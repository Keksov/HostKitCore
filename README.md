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

Tests: `bun test` in this directory, with no path (verify step `hostkit-tests` in
`MindWaveCore/uitest/src/verify-steps.ts`). They need `bun install` in `ui/` once (vue, as in
`GnauralCore/ui`).
