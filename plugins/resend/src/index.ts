/**
 * `@vaubaan/plugin-resend` — outbound email (Resend) on the v5 Plugin SDK.
 *
 * Spec : docs/spec/vaubaan-gateway.md §5 (plugins) ; docs/spec/gateway-risk-model.md §7 ;
 *        docs/spec/resend.md (modelling of the provider).
 * ADR  : docs/decisions/plugin-contract-and-credential-spec.md.
 * Handbook : docs/handbook/providers/resend.md ; guide : plugins/resend/README.md.
 *
 * Credential : `api-key`, one secret field (`api_key`, `re_…`). Resources :
 * the account's sending domains (ref = domain name, recipient-zone lists in
 * the metadata) and segments (ref = segment id). The YAML catalog is loaded
 * here, once, at import (that is, at gateway boot).
 */

import { catalogPathNextTo, definePlugin, loadCatalogFile } from '@vaubaan/plugin-sdk';

import { classifyResend } from './classify.ts';
import { resendDataModel } from './data-model.ts';
import { discoverResendResources, executeResend } from './execute.ts';
import { RESEND_ICON } from './icon.ts';
import { resendToolTitles } from './tool-titles.ts';
import { resendTools } from './tools.ts';

// The YAML sits next to this module ; `catalogPathNextTo` keeps the path a
// filesystem path the bundler leaves alone (ADR plugin-catalog-path-and-standalone-tracing).
export const resendCatalog = loadCatalogFile(catalogPathNextTo(import.meta.url));

export const resendPlugin = definePlugin({
  id: 'resend',
  displayName: 'Resend',
  icon: RESEND_ICON,
  version: '0.4.1',
  description:
    'Outbound email : transactional sends classified by recipient zone, segments and contacts, ' +
    'broadcast campaigns, sending domains — one resource per domain and per segment.',
  summary:
    'One account is one Resend API key; resources are its sending domains and its contact segments. Sends are told apart by who the email goes to (internal, allow-listed, anyone), and the owner of the account labels each domain and segment with an environment so that staging and production are held separately.',
  manualRevocation: 'Delete the API key in the Resend dashboard, under API Keys.',
  docsUrl: 'https://github.com/vaubaan/gateway/blob/main/docs/handbook/providers/resend.md',
  tools: resendTools,
  toolTitles: resendToolTitles,
  // Domains and segments are what a Resend connection lists : a created one is
  // discovered at once (ADR discovery-runs-after-a-creating-call).
  resourceCreatingTools: ['resend__create_domain', 'resend__create_segment'],
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
  CONTACT_EMAIL,
  DOMAIN_NAME,
  PATH_IDENT,
  RESOURCE_KINDS,
  contactSelector,
  domainIdOf,
  domainName,
  domainRef,
  domainResources,
  kindOf,
  pathIdent,
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
