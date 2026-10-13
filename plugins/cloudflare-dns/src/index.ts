/**
 * `@vaubaan/plugin-cloudflare-dns` — Cloudflare DNS zones and records, on the v5 SDK.
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

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { definePlugin, loadCatalogFile, type RiskCatalog } from '@vaubaan/plugin-sdk';

import { classifyCloudflareDns } from './classify.ts';
import { cloudflareDnsDataModel } from './data-model.ts';
import {
  API_TOKEN_FIELD,
  discoverCloudflareDnsResources,
  executeCloudflareDns,
} from './execute.ts';
import { cloudflareDnsTools } from './tools.ts';

// The path is built from `import.meta.url` with `node:path`, not with
// `new URL('./risk-catalog.yaml', import.meta.url)` : a bundler (Turbopack in
// `apps/gateway`) rewrites that literal into a static asset URL and the YAML
// can no longer be read from disk at boot.
export const cloudflareDnsCatalog = loadCatalogFile(
  join(dirname(fileURLToPath(import.meta.url)), 'risk-catalog.yaml'),
);

export const cloudflareDnsPlugin = definePlugin({
  id: 'cloudflare-dns',
  displayName: 'Cloudflare DNS',
  version: '1.0.0',
  description:
    'DNS zones and records on Cloudflare : records, BIND import / export, zone settings, ' +
    'DNSSEC and cache purge — one resource per zone.',
  docsUrl:
    'https://github.com/sbw-vaubaan/vaubaan-gateway/blob/main/docs/handbook/providers/cloudflare-dns.md',
  tools: cloudflareDnsTools,
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
  SAFE_IDENT,
  accountIdOf,
  isCriticalRecord,
  recordSensitivity,
  resolveZoneResource,
  zoneNameOf,
  type RecordSensitivity,
} from './resources.ts';

// ─── Legacy v4 surface — kept so apps/gateway compiles until P1.6 ────────────

/** @deprecated legacy v4, deleted in P1.6 — use `cloudflareDnsPlugin`. */
export { CloudflareDnsAdapter } from './cloudflare-dns-adapter.ts';
/** @deprecated legacy v4, deleted in P1.6 — use `cloudflareDnsPlugin.tools`. */
export { availableTools as cloudflareDnsAvailableTools } from './tools.ts';
/** @deprecated legacy v4, deleted in P1.6 — use `cloudflareDnsPlugin.execute`. */
export { executeCall as cloudflareDnsExecuteCall } from './execute.ts';
/** @deprecated legacy v4, deleted in P1.6 — use `cloudflareDnsPlugin.catalog` (loaded from the YAML). */
export const cloudflareDnsRiskCatalog: RiskCatalog = cloudflareDnsCatalog.catalog;
/** @deprecated legacy v4, deleted in P1.6 — use `cloudflareDnsPlugin.classify`. */
export { classifyCloudflareDnsV4 } from './risk-classifier.ts';
/** @deprecated legacy v4, deleted in P1.6 — use `ClassifyOutcome`. */
export type { ClassifyResult as CloudflareDnsClassifyV4Result } from './risk-classifier.ts';
