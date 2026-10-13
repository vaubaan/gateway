/**
 * `@vaubaan/plugin-resend` — outbound email (Resend) on the v5 Plugin SDK.
 *
 * Spec : docs/spec/vaubaan-gateway.md §5 (plugins) ; docs/spec/gateway-risk-model.md §7 ;
 *        docs/spec/resend.md (v4 modelling of the provider).
 * ADR  : docs/decisions/plugin-contract-and-credential-spec.md.
 * Handbook : docs/handbook/providers/resend.md ; guide : plugins/resend/README.md.
 *
 * Credential : `api-key`, one secret field (`api_key`, `re_…`). Resources :
 * the account's sending domains (ref = domain name, recipient-zone lists in
 * the metadata) and segments (ref = segment id). The YAML catalog is loaded
 * here, once, at import (that is, at gateway boot).
 */

import {
  catalogPathNextTo,
  definePlugin,
  loadCatalogFile,
  type RiskCatalog,
} from '@vaubaan/plugin-sdk';

import { classifyResend } from './classify.ts';
import { resendDataModel } from './data-model.ts';
import { discoverResendResources, executeResend } from './execute.ts';
import { resendTools } from './tools.ts';

// The YAML sits next to this module ; `catalogPathNextTo` keeps the path a
// filesystem path the bundler leaves alone (ADR plugin-catalog-path-and-standalone-tracing).
export const resendCatalog = loadCatalogFile(catalogPathNextTo(import.meta.url));

export const resendPlugin = definePlugin({
  id: 'resend',
  displayName: 'Resend',
  version: '0.1.0',
  description:
    'Outbound email : transactional sends classified by recipient zone, segments and contacts, ' +
    'broadcast campaigns, sending domains — one resource per domain and per segment.',
  docsUrl:
    'https://github.com/sbw-vaubaan/vaubaan-gateway/blob/main/docs/handbook/providers/resend.md',
  tools: resendTools,
  dataModel: resendDataModel,
  catalog: resendCatalog.catalog,
  credential: {
    kind: 'api-key',
    createUrl: 'https://resend.com/api-keys',
    fields: [
      {
        name: 'api_key',
        label: 'API key',
        secret: true,
        placeholder: 're_…',
        pattern: '^re_[A-Za-z0-9_-]+$',
        help:
          'A key with "Full access" : resource discovery lists the domains and segments, which a ' +
          '"Sending access" key cannot read. Recipient zones are configured per domain resource ' +
          'after connection.',
      },
    ],
  },
  classify: classifyResend,
  execute: executeResend,
  discoverResources: discoverResendResources,
});

export default resendPlugin;

export { classifyResend, resendDataModel, resendTools };
export { BATCH_MAX_EMAILS } from './classify.ts';
export {
  DISCOVERY_PAGE_SIZE,
  MAX_DISCOVERED_PER_KIND,
  RESEND_API_BASE,
  discoverResendResources,
  executeResend,
  fromDomainOf,
} from './execute.ts';
export {
  EMPTY_ZONE_CONFIG,
  RESOURCE_KINDS,
  SAFE_IDENT,
  domainRef,
  domainResources,
  kindOf,
  resolveDomain,
  resolveDomainArg,
  resolveSegmentArg,
  segmentResources,
  zoneConfigOf,
  type ResendResourceKind,
  type ZoneConfig,
} from './resources.ts';
export {
  RECIPIENT_COUNTS,
  TO_ZONES,
  collectRecipients,
  parseAddress,
  worstZone,
  zoneOfAddress,
  type EmailAddress,
  type RecipientCount,
  type ToZone,
} from './zones.ts';
export { RESEND_WRITE_TOOL_NAMES } from './tools.ts';

// ─── Legacy v4 surface — kept so apps/gateway compiles until P1.6 ────────────

/** @deprecated legacy v4, deleted in P1.6 — use `resendPlugin`. */
export { ResendAdapter } from './resend-adapter.ts';
/** @deprecated legacy v4, deleted in P1.6 — use `resendPlugin.tools` (the v4 list has 25 audience-era tools). */
export { availableTools as resendAvailableTools } from './legacy-tools.ts';
/** @deprecated legacy v4, deleted in P1.6 — use `resendPlugin.execute`. */
export { executeCall as resendExecuteCall } from './legacy-execute.ts';
/** @deprecated legacy v4, deleted in P1.6 — use `resendPlugin.catalog` (loaded from the YAML). */
export const resendRiskCatalog: RiskCatalog = resendCatalog.catalog;
/** @deprecated legacy v4, deleted in P1.6 — use `resendPlugin.classify` (the v4 classifier emits account-rooted slices). */
export { classifyResendV4 } from './risk-classifier.ts';
/** @deprecated legacy v4, deleted in P1.6 — use `ClassifyOutcome` from the SDK. */
export type { ClassifyResult as ResendClassifyV4Result } from './risk-classifier.ts';
