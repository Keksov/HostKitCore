// panel-window (PW2.1, PW-D4): the panel-registry contract. Modules contribute panels through
// their manifest (like routes/settingsTabs); PanelHostPage resolves a panel by id to render its
// CONTENT component full-window in a detached child window. The content component is the same
// one the main window hosts inside PanelWindow — it carries no window chrome of its own.
import type { Component } from 'vue'

export interface PanelContribution {
  /** Panel id — the '/panel/:panelId' route param and the bridge channel suffix (PW-D5). */
  readonly id: string
  /** i18n key for the panel caption; the child window's document.title (PW-D4). */
  readonly titleKey: string
  readonly icon: string
  /** Lazy loader for the panel content component. */
  readonly component: () => Promise<{ default: Component }>
  /**
   * Event names the content component emits (besides 'close', which is handled by the host
   * itself). The child-window host forwards these over the bridge to the main window (PW2.2).
   */
  readonly events?: readonly string[]
  /**
   * TD2.1 (TD-D3): this panel's content ASKS the main window things (request-response over the
   * bridge) and therefore takes a `bridge-request(name, ...args)` function prop. Opt-in on purpose:
   * the host would otherwise hand a function to every panel, and one that does not declare the prop
   * would render it as a fallthrough attribute.
   */
  readonly bridgeRequests?: boolean
  /**
   * TD4.2 (TD-D10): this panel never gets a window of its own — it is a COMPANION that travels into
   * the named host panel's detached window. The child window resolves it from here (component,
   * caption, events) exactly like the panel it hosts, and the main window keeps its parent side.
   */
  readonly detachHost?: string
}
