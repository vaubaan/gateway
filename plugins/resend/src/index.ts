/**
 * `@vaubaan/plugin-resend` — outbound email (Resend) on the v5 Plugin SDK.
 *
 * Spec : docs/spec/vaubaan-gateway.md §5 (plugins) ; docs/spec/gateway-risk-model.md §7 ;
 *        docs/spec/resend.md (modelling of the service).
 * ADR  : docs/decisions/plugin-contract-and-credential-spec.md.
 * Handbook : docs/handbook/services/resend.md ; guide : plugins/resend/README.md.
 *
 * Credential : `api-key`, one secret field (`api_key`, `re_…`), Full access
 * (`credential.ts`). Resources :
 * the account's sending domains (ref = domain name, recipient-zone lists in
 * the metadata) and segments (ref = segment id). The YAML catalog is loaded
 * here, once, at import (that is, at gateway boot).
 */

import { catalogPathNextTo, definePlugin, loadCatalogFile } from '@vaubaan/plugin-sdk';

import { classifyResend } from './classify.ts';
import { createdResendResources } from './created.ts';
import { resendCredential } from './credential.ts';
import { resendDataModel } from './data-model.ts';
import { resendExamples } from './examples.ts';
import { discoverResendResources, executeResend } from './execute.ts';
import { RESEND_ICON, RESEND_ICON_COLOR } from './icon.ts';
import { SERVICE_ID, TOOL } from './identity.ts';
import { resendToolTitles } from './tool-titles.ts';
import { resendTools } from './tools.ts';

// The YAML sits next to this module ; `catalogPathNextTo` keeps the path a
// filesystem path the bundler leaves alone (docs/handbook/plugin-sdk.md).
export const resendCatalog = loadCatalogFile(catalogPathNextTo(import.meta.url));

export const resendPlugin = definePlugin({
  id: SERVICE_ID,
  displayName: 'Resend',
  icon: RESEND_ICON,
  iconColor: RESEND_ICON_COLOR,
  resourceNoun: { one: 'domain or segment', other: 'domains and segments' },
  version: '0.6.3',
  description:
    'Outbound email : transactional sends classified by recipient zone, segments and contacts, ' +
    'broadcast campaigns, sending domains — one resource per domain and per segment.',
  summary:
    'One account is one Resend API key; resources are its sending domains and its contact segments. Sends are told apart by who the email goes to (internal, allow-listed, anyone), and the owner of the account labels each domain and segment with an environment so that staging and production are held separately.',
  manualRevocation: 'Delete the API key in the Resend dashboard, under API Keys.',
  docsUrl: 'https://github.com/vaubaan/gateway/blob/main/docs/handbook/services/resend.md',
  tools: resendTools,
  toolTitles: resendToolTitles,
  examples: resendExamples,
  // Domains and segments are what a Resend account lists : a created one is
  // discovered at once (ADR created-resources-join-the-mission).
  resourceCreatingTools: [TOOL.createDomain, TOOL.createSegment],
  // Read from the call's answer: the mission that created it reaches it at once
  // (ADR created-resources-join-the-mission).
  createdResources: createdResendResources,
  dataModel: resendDataModel,
  catalog: resendCatalog.catalog,
  credential: resendCredential,
  classify: classifyResend,
  execute: executeResend,
  discoverResources: discoverResendResources,
});

export default resendPlugin;

export { classifyResend, resendDataModel, resendTools };
export { SERVICE_ID, TOOL, TOOL_PREFIX } from './identity.ts';
export { BATCH_MAX_EMAILS } from './classify.ts';
export { RESEND_API_KEYS_PAGE, resendCredential, verifyResendKey } from './credential.ts';
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
export { EXAMPLE_MISSION, resendExamples } from './examples.ts';
