/**
 * Cloudflare DNS MCP tools — 15 tools over api.cloudflare.com/client/v4.
 *
 *   - 7 reads  : zones, records, BIND export, zone settings, DNSSEC.
 *   - 8 writes : record create / update / delete, BIND import, zone
 *                settings, cache purge, DNSSEC, zone delete.
 *
 * Every zone-scoped tool takes `zone_id` : the ref (or the DNS name) of one
 * of the mission's Cloudflare DNS zones. `update_record` requires `type` and `name` so the
 * gateway can tell an apex / MX / NS change from an ordinary record update
 * before the call ; `delete_record` takes them as optional arguments and a
 * deletion that omits them is classified as a critical record write (see
 * `classify.ts`).
 */

import type { McpToolDeclaration } from '@vaubaan/plugin-sdk';

import { TOOL } from './identity.ts';

const ZONE_ID = {
  type: 'string',
  description:
    'One of the Cloudflare DNS zones of the mission, by its id or its name (example.com) — list_zones lists them.',
} as const;

const RECORD_ID = { type: 'string', description: 'The DNS record identifier.' } as const;

const READ_TOOLS: readonly McpToolDeclaration[] = [
  {
    name: TOOL.listZones,
    description:
      "List every DNS zone of the mission : id, name and account. The account's other zones are left out. A zone's status and nameservers : get_zone.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: TOOL.getZone,
    description: 'Retrieve one DNS zone. Backed by GET /zones/:zone_id.',
    inputSchema: { type: 'object', properties: { zone_id: ZONE_ID }, required: ['zone_id'] },
  },
  {
    name: TOOL.listRecords,
    description:
      'List the DNS records of a zone with optional filters. Backed by GET /zones/:zone_id/dns_records.',
    inputSchema: {
      type: 'object',
      properties: {
        zone_id: ZONE_ID,
        type: { type: 'string', description: 'Filter by record type (A, AAAA, CNAME, MX, TXT…).' },
        name: { type: 'string', description: 'Filter by record name (e.g. "www.example.com").' },
        content: { type: 'string', description: 'Filter by record content (e.g. an IP address).' },
        page: { type: 'number', description: 'Page number (default 1).' },
        per_page: { type: 'number', description: 'Records per page (default 100, max 5000).' },
      },
      required: ['zone_id'],
    },
  },
  {
    name: TOOL.getRecord,
    description:
      'Retrieve one DNS record by id. Backed by GET /zones/:zone_id/dns_records/:record_id.',
    inputSchema: {
      type: 'object',
      properties: { zone_id: ZONE_ID, record_id: RECORD_ID },
      required: ['zone_id', 'record_id'],
    },
  },
  {
    name: TOOL.exportRecords,
    description:
      'Export every DNS record of a zone as a BIND zone file. Backed by GET /zones/:zone_id/dns_records/export.',
    inputSchema: { type: 'object', properties: { zone_id: ZONE_ID }, required: ['zone_id'] },
  },
  {
    name: TOOL.getZoneSettings,
    description:
      'Retrieve every setting of a zone (SSL mode, minimum TLS version, cache level…). Backed by GET /zones/:zone_id/settings.',
    inputSchema: { type: 'object', properties: { zone_id: ZONE_ID }, required: ['zone_id'] },
  },
  {
    name: TOOL.getDnssec,
    description:
      'Retrieve the DNSSEC status and DS record of a zone. Backed by GET /zones/:zone_id/dnssec.',
    inputSchema: { type: 'object', properties: { zone_id: ZONE_ID }, required: ['zone_id'] },
  },
];

const WRITE_TOOLS: readonly McpToolDeclaration[] = [
  {
    name: TOOL.createRecord,
    description:
      'Create a DNS record in a zone. Backed by POST /zones/:zone_id/dns_records. Apex, wildcard, MX and NS records count as critical changes.',
    inputSchema: {
      type: 'object',
      properties: {
        zone_id: ZONE_ID,
        type: { type: 'string', description: 'Record type (A, AAAA, CNAME, MX, TXT, SRV…).' },
        name: {
          type: 'string',
          description:
            'Complete record name including the zone (e.g. "www.example.com") ; the zone name or "@" for the apex.',
        },
        content: {
          type: 'string',
          description: 'Record content (IP address, hostname or text value).',
        },
        ttl: { type: 'number', description: 'Time to live in seconds (1 = automatic).' },
        proxied: {
          type: 'boolean',
          description: 'Whether the record is proxied through Cloudflare (orange cloud).',
        },
        priority: { type: 'number', description: 'Priority for MX and SRV records.' },
      },
      required: ['zone_id', 'type', 'name', 'content'],
    },
  },
  {
    name: TOOL.updateRecord,
    description:
      'Update an existing DNS record. Backed by PATCH /zones/:zone_id/dns_records/:record_id. `type` and `name` are required so the gateway can classify the change ; the call is refused when they do not describe the current record.',
    inputSchema: {
      type: 'object',
      properties: {
        zone_id: ZONE_ID,
        record_id: RECORD_ID,
        type: { type: 'string', description: 'Record type (A, AAAA, CNAME, MX, TXT, SRV…).' },
        name: {
          type: 'string',
          description:
            'Complete record name including the zone ; the zone name or "@" for the apex.',
        },
        content: { type: 'string', description: 'Updated record content.' },
        ttl: { type: 'number', description: 'Updated time to live in seconds (1 = automatic).' },
        proxied: { type: 'boolean', description: 'Updated proxy status.' },
        priority: { type: 'number', description: 'Updated priority for MX and SRV records.' },
      },
      required: ['zone_id', 'record_id', 'type', 'name'],
    },
  },
  {
    name: TOOL.deleteRecord,
    description:
      'Delete a DNS record. Backed by DELETE /zones/:zone_id/dns_records/:record_id. Pass the `type` and `name` of the record : without them the deletion counts as a critical change (apex, wildcard, MX, NS) ; with them the call is refused when they do not describe the current record.',
    inputSchema: {
      type: 'object',
      properties: {
        zone_id: ZONE_ID,
        record_id: RECORD_ID,
        type: {
          type: 'string',
          description: 'Type of the record being deleted (A, AAAA, CNAME, MX, TXT, SRV…).',
        },
        name: {
          type: 'string',
          description:
            'Complete name of the record being deleted, including the zone ; the zone name or "@" for the apex.',
        },
      },
      required: ['zone_id', 'record_id'],
    },
  },
  {
    name: TOOL.importRecords,
    description:
      'Bulk import DNS records from a BIND zone file (creates / overwrites records in batch). Backed by POST /zones/:zone_id/dns_records/import (multipart/form-data).',
    inputSchema: {
      type: 'object',
      properties: {
        zone_id: ZONE_ID,
        file: { type: 'string', description: 'BIND zone file content.' },
      },
      required: ['zone_id', 'file'],
    },
  },
  {
    name: TOOL.editZoneSettings,
    description:
      'Edit one or more zone settings (SSL mode, minimum TLS version, cache level…). Backed by PATCH /zones/:zone_id/settings.',
    inputSchema: {
      type: 'object',
      properties: {
        zone_id: ZONE_ID,
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Setting id (e.g. "ssl", "min_tls_version").' },
              value: { description: 'Setting value (type depends on the setting).' },
            },
            required: ['id', 'value'],
          },
          description: 'Array of {id, value} pairs to update.',
        },
      },
      required: ['zone_id', 'items'],
    },
  },
  {
    name: TOOL.purgeCache,
    description:
      'Purge cached content of a zone — everything, or by URL, tag, host or prefix. Backed by POST /zones/:zone_id/purge_cache.',
    inputSchema: {
      type: 'object',
      properties: {
        zone_id: ZONE_ID,
        purge_everything: {
          type: 'boolean',
          description: 'Purge all cached content (heavy on high-traffic sites).',
        },
        files: { type: 'array', items: { type: 'string' }, description: 'URLs to purge.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Cache tags to purge.' },
        hosts: { type: 'array', items: { type: 'string' }, description: 'Hostnames to purge.' },
        prefixes: {
          type: 'array',
          items: { type: 'string' },
          description: 'URL prefixes to purge.',
        },
      },
      required: ['zone_id'],
    },
  },
  {
    name: TOOL.editDnssec,
    description: 'Enable or disable DNSSEC on a zone. Backed by PATCH /zones/:zone_id/dnssec.',
    inputSchema: {
      type: 'object',
      properties: {
        zone_id: ZONE_ID,
        status: {
          type: 'string',
          enum: ['active', 'disabled'],
          description: 'DNSSEC status to set.',
        },
      },
      required: ['zone_id', 'status'],
    },
  },
  {
    name: TOOL.deleteZone,
    description:
      'Delete a DNS zone. The domain stops resolving at once ; every record, setting and the DNSSEC configuration are lost. Backed by DELETE /zones/:zone_id.',
    inputSchema: { type: 'object', properties: { zone_id: ZONE_ID }, required: ['zone_id'] },
  },
];

export const cloudflareDnsTools: readonly McpToolDeclaration[] = [...READ_TOOLS, ...WRITE_TOOLS];
