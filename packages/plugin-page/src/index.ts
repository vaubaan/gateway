/**
 * `@vaubaan/plugin-page` — the page of a service, drawn from its plugin: one
 * implementation the public site (`/plugins/<id>`) and the gateway's Reference
 * (`/reference/<id>`) both render (ADR service-page-is-one-shared-package).
 *
 * - `.` (this entry): the view (`ServicePage`), its marks, the page data built
 *   over `PluginInfo` (`page-data.ts`) and the types. No run-time import of
 *   the plugin SDK, so an app rendering saved data needs none.
 * - `./info`: `pluginInfo(plugin, context)`, the builder from a loaded plugin.
 * - `./plugin-page.css`: the style sheet, every colour, size and space read from
 *   `--pp-*` custom properties each app maps to its own tokens.
 */
export * from './page-data';
export * from './marks';
export {
  Inline,
  macroAnchorOf,
  riskAnchorOf,
  ServicePage,
  type HrefOf,
  type ServicePageProps,
  type ServicePageSection,
} from './ServicePage';
export type * from './info';
export type {
  CarefulDecision,
  CarefulGate,
  WorkedDecision,
  WorkedLine,
  WorkedOutcome,
} from './examples';
