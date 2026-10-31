/**
 * `@vaubaan/plugin-cloudflare-dns` — Cloudflare DNS zones and records.
 *
 * Spec : docs/spec/vaubaan-gateway.md §5 (plugins) ; docs/spec/gateway-risk-model.md §7.
 * ADR  : docs/decisions/plugin-contract-and-credential-spec.md.
 * Handbook : docs/handbook/providers/cloudflare-dns.md ; guide : plugins/cloudflare-dns/README.md.
 *
 * Credential : `api-key` with one secret field, a Cloudflare API token over
 * all zones (`credential.ts`). Discovery yields one resource per zone
 * the token reaches (`ref` = zone id). The YAML catalog is loaded here, once,
 * at import (that is, at gateway boot).
 */

import { catalogPathNextTo, definePlugin, loadCatalogFile } from '@vaubaan/plugin-sdk';

import { classifyCloudflareDns } from './classify.ts';
import { cloudflareDnsCredential } from './credential.ts';
import { cloudflareDnsDataModel } from './data-model.ts';
import { discoverCloudflareDnsResources, executeCloudflareDns } from './execute.ts';
import { CLOUDFLARE_DNS_ICON, CLOUDFLARE_DNS_ICON_COLOR } from './icon.ts';
import { cloudflareDnsToolTitles } from './tool-titles.ts';
import { cloudflareDnsTools } from './tools.ts';

// The YAML sits next to this module ; `catalogPathNextTo` keeps the path a
// filesystem path the bundler leaves alone (docs/handbook/plugin-sdk.md).
export const cloudflareDnsCatalog = loadCatalogFile(catalogPathNextTo(import.meta.url));

export const cloudflareDnsPlugin = definePlugin({
  id: 'cloudflare-dns',
  displayName: 'Cloudflare DNS',
  icon: CLOUDFLARE_DNS_ICON,
  iconColor: CLOUDFLARE_DNS_ICON_COLOR,
  version: '3.0.5',
  description:
    'DNS zones and records on Cloudflare : records, BIND import / export, zone settings, ' +
    'DNSSEC and cache purge — one resource per zone.',
  summary:
    'One account is one Cloudflare API token; one resource is one DNS zone (a domain). A mission touches only the zones it was given. DNS has no environment: ordinary records, apex / MX / NS changes, deletions, imports and zone settings are separate permissions instead.',
  manualRevocation:
    'Delete the API token in the Cloudflare dashboard, under My Profile, API Tokens.',
  docsUrl: 'https://github.com/vaubaan/gateway/blob/main/docs/handbook/providers/cloudflare-dns.md',
  tools: cloudflareDnsTools,
  toolTitles: cloudflareDnsToolTitles,
  dataModel: cloudflareDnsDataModel,
  catalog: cloudflareDnsCatalog.catalog,
  credential: cloudflareDnsCredential,
  classify: classifyCloudflareDns,
  execute: executeCloudflareDns,
  discoverResources: discoverCloudflareDnsResources,
});

export default cloudflareDnsPlugin;

export { classifyCloudflareDns, cloudflareDnsDataModel, cloudflareDnsTools };
export {
  CLOUDFLARE_TOKENS_PAGE,
  CLOUDFLARE_TOKEN_PERMISSIONS,
  cloudflareDnsCredential,
  verifyCloudflareToken,
} from './credential.ts';
export {
  API_TOKEN_FIELD,
  CLOUDFLARE_API_BASE,
  MAX_DISCOVERED_ZONES,
  discoverCloudflareDnsResources,
  executeCloudflareDns,
} from './execute.ts';
export {
  CLOUDFLARE_DNS_PROVIDER,
  CRITICAL_RECORD_TYPES,
  DNS_NAME,
  PATH_IDENT,
  RECORD_TYPE,
  accountIdOf,
  dnsName,
  isCriticalRecord,
  pathIdent,
  recordSensitivity,
  recordType,
  resolveZoneResource,
  zoneNameOf,
  type RecordSensitivity,
} from './resources.ts';
