/**
 * `@vaubaan/plugin-cloudflare-dns` — Cloudflare DNS zones and records.
 *
 * Spec : docs/spec/vaubaan-gateway.md §5 (plugins) ; docs/spec/gateway-risk-model.md §7.
 * ADR  : docs/decisions/plugin-contract-and-credential-spec.md.
 * Handbook : docs/handbook/providers/cloudflare-dns.md ; guide : plugins/cloudflare-dns/README.md.
 *
 * Credential : `api-key` with one secret field, a Cloudflare API token scoped
 * to the zones the agent may touch. Discovery yields one resource per zone
 * the token reaches (`ref` = zone id). The YAML catalog is loaded here, once,
 * at import (that is, at gateway boot).
 */

import { catalogPathNextTo, definePlugin, loadCatalogFile } from '@vaubaan/plugin-sdk';

import { classifyCloudflareDns } from './classify.ts';
import { cloudflareDnsDataModel } from './data-model.ts';
import {
  API_TOKEN_FIELD,
  discoverCloudflareDnsResources,
  executeCloudflareDns,
} from './execute.ts';
import { cloudflareDnsToolTitles } from './tool-titles.ts';
import { cloudflareDnsTools } from './tools.ts';

// The YAML sits next to this module ; `catalogPathNextTo` keeps the path a
// filesystem path the bundler leaves alone (ADR plugin-catalog-path-and-standalone-tracing).
export const cloudflareDnsCatalog = loadCatalogFile(catalogPathNextTo(import.meta.url));

export const cloudflareDnsPlugin = definePlugin({
  id: 'cloudflare-dns',
  displayName: 'Cloudflare DNS',
  version: '3.0.0',
  description:
    'DNS zones and records on Cloudflare : records, BIND import / export, zone settings, ' +
    'DNSSEC and cache purge — one resource per zone.',
  summary:
    'One account is one Cloudflare API token; one resource is one DNS zone (a domain). A mission touches only the zones it was given. DNS has no environment: ordinary records, apex / MX / NS changes, deletions, imports and zone settings are separate permissions instead.',
  manualRevocation:
    'Delete the API token in the Cloudflare dashboard, under My Profile, API Tokens.',
  docsUrl:
    'https://github.com/sbw-vaubaan/vaubaan-gateway/blob/main/docs/handbook/providers/cloudflare-dns.md',
  tools: cloudflareDnsTools,
  toolTitles: cloudflareDnsToolTitles,
  dataModel: cloudflareDnsDataModel,
  catalog: cloudflareDnsCatalog.catalog,
  credential: {
    kind: 'api-key',
    createUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    fields: [
      {
        name: API_TOKEN_FIELD,
        label: 'API token',
        secret: true,
        required: true,
        placeholder: 'Cloudflare API token',
        // Tokens are URL-safe base64-ish strings ; a Global API Key pasted as
        // `email|key` is refused by construction.
        pattern: '^[A-Za-z0-9_-]{20,}$',
        help:
          'Create a token scoped to the zones the agent may touch, with Zone:Read, DNS:Edit and, ' +
          'as needed, Zone Settings:Edit, Cache Purge:Purge and Zone:Edit (zone deletion). Never ' +
          'a Global API Key.',
      },
    ],
  },
  classify: classifyCloudflareDns,
  execute: executeCloudflareDns,
  discoverResources: discoverCloudflareDnsResources,
});

export default cloudflareDnsPlugin;

export { classifyCloudflareDns, cloudflareDnsDataModel, cloudflareDnsTools };
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
