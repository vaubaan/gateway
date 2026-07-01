/**
 * Cloudflare DNS MCP tools -- all custom, no upstream MCP server to rewrap.
 *
 * 15 tools total :
 *   - 7 reads (GET endpoints against api.cloudflare.com/client/v4)
 *   - 8 writes (POST/PATCH/DELETE endpoints against api.cloudflare.com/client/v4)
 *
 * Names are prefixed `cloudflare_dns__` to match the Vaubaan policy DSL
 * provider scoping convention.
 */

import type { McpToolDeclaration } from '@vaubaan/shared';

// ─── Read tools ─────────────────────────────────────────────────────────────

const READ_TOOLS: readonly McpToolDeclaration[] = [
  {
    name: 'cloudflare_dns__list_zones',
    description:
      'List all DNS zones under the Cloudflare account. Backed by GET /zones (filtered by account.id).',
    inputSchema: {
      type: 'object',
      properties: {
        page: {
          type: 'number',
          description: 'Page number (default 1).',
        },
        per_page: {
          type: 'number',
          description: 'Number of zones per page (default 20, max 50).',
        },
      },
    },
  },
  {
    name: 'cloudflare_dns__get_zone',
    description: 'Retrieve details of a single DNS zone. Backed by GET /zones/:zone_id.',
    inputSchema: {
      type: 'object',
      properties: {
        zone_id: {
          type: 'string',
          description: 'The zone identifier.',
        },
      },
      required: ['zone_id'],
    },
  },
  {
    name: 'cloudflare_dns__list_records',
    description:
      'List DNS records for a zone with optional filters. Backed by GET /zones/:zone_id/dns_records.',
    inputSchema: {
      type: 'object',
      properties: {
        zone_id: {
          type: 'string',
          description: 'The zone identifier.',
        },
        type: {
          type: 'string',
          description: 'Filter by record type (A, AAAA, CNAME, MX, TXT, etc.).',
        },
        name: {
          type: 'string',
          description: 'Filter by record name (e.g. "example.com").',
        },
        content: {
          type: 'string',
          description: 'Filter by record content (e.g. IP address).',
        },
        page: {
          type: 'number',
          description: 'Page number (default 1).',
        },
        per_page: {
          type: 'number',
          description: 'Number of records per page (default 100, max 5000).',
        },
      },
      required: ['zone_id'],
    },
  },
  {
    name: 'cloudflare_dns__get_record',
    description:
      'Retrieve a single DNS record by id. Backed by GET /zones/:zone_id/dns_records/:record_id.',
    inputSchema: {
      type: 'object',
      properties: {
        zone_id: {
          type: 'string',
          description: 'The zone identifier.',
        },
        record_id: {
          type: 'string',
          description: 'The DNS record identifier.',
        },
      },
      required: ['zone_id', 'record_id'],
    },
  },
  {
    name: 'cloudflare_dns__export_records',
    description:
      'Export all DNS records for a zone as a BIND zone file. Backed by GET /zones/:zone_id/dns_records/export.',
    inputSchema: {
      type: 'object',
      properties: {
        zone_id: {
          type: 'string',
          description: 'The zone identifier.',
        },
      },
      required: ['zone_id'],
    },
  },
  {
    name: 'cloudflare_dns__get_zone_settings',
    description:
      'Retrieve all settings for a zone (SSL mode, TLS version, cache level, etc.). Backed by GET /zones/:zone_id/settings.',
    inputSchema: {
      type: 'object',
      properties: {
        zone_id: {
          type: 'string',
          description: 'The zone identifier.',
        },
      },
      required: ['zone_id'],
    },
  },
  {
    name: 'cloudflare_dns__get_dnssec',
    description:
      'Retrieve DNSSEC status and DS record for a zone. Backed by GET /zones/:zone_id/dnssec.',
    inputSchema: {
      type: 'object',
      properties: {
        zone_id: {
          type: 'string',
          description: 'The zone identifier.',
        },
      },
      required: ['zone_id'],
    },
  },
];

// ─── Write tools ────────────────────────────────────────────────────────────

const WRITE_TOOLS: readonly McpToolDeclaration[] = [
  {
    name: 'cloudflare_dns__create_record',
    description: 'Create a new DNS record in a zone. Backed by POST /zones/:zone_id/dns_records.',
    inputSchema: {
      type: 'object',
      properties: {
        zone_id: {
          type: 'string',
          description: 'The zone identifier.',
        },
        type: {
          type: 'string',
          description: 'DNS record type (A, AAAA, CNAME, MX, TXT, SRV, etc.).',
        },
        name: {
          type: 'string',
          description: 'DNS record name (e.g. "example.com" or "sub.example.com").',
        },
        content: {
          type: 'string',
          description: 'DNS record content (e.g. IP address, hostname, or text value).',
        },
        ttl: {
          type: 'number',
          description: 'Time to live in seconds (1 = automatic).',
        },
        proxied: {
          type: 'boolean',
          description: 'Whether the record is proxied through Cloudflare (orange cloud).',
        },
        priority: {
          type: 'number',
          description: 'Priority for MX and SRV records.',
        },
      },
      required: ['zone_id', 'type', 'name', 'content'],
    },
  },
  {
    name: 'cloudflare_dns__update_record',
    description:
      'Update an existing DNS record. Backed by PATCH /zones/:zone_id/dns_records/:record_id.',
    inputSchema: {
      type: 'object',
      properties: {
        zone_id: {
          type: 'string',
          description: 'The zone identifier.',
        },
        record_id: {
          type: 'string',
          description: 'The DNS record identifier.',
        },
        type: {
          type: 'string',
          description: 'Updated DNS record type.',
        },
        name: {
          type: 'string',
          description: 'Updated DNS record name.',
        },
        content: {
          type: 'string',
          description: 'Updated DNS record content.',
        },
        ttl: {
          type: 'number',
          description: 'Updated time to live in seconds (1 = automatic).',
        },
        proxied: {
          type: 'boolean',
          description: 'Updated proxy status.',
        },
        priority: {
          type: 'number',
          description: 'Updated priority for MX and SRV records.',
        },
      },
      required: ['zone_id', 'record_id'],
    },
  },
  {
    name: 'cloudflare_dns__delete_record',
    description: 'Delete a DNS record. Backed by DELETE /zones/:zone_id/dns_records/:record_id.',
    inputSchema: {
      type: 'object',
      properties: {
        zone_id: {
          type: 'string',
          description: 'The zone identifier.',
        },
        record_id: {
          type: 'string',
          description: 'The DNS record identifier to delete.',
        },
      },
      required: ['zone_id', 'record_id'],
    },
  },
  {
    name: 'cloudflare_dns__import_records',
    description:
      'Bulk import DNS records from a BIND zone file. Creates/updates records in batch. Backed by POST /zones/:zone_id/dns_records/import (multipart/form-data).',
    inputSchema: {
      type: 'object',
      properties: {
        zone_id: {
          type: 'string',
          description: 'The zone identifier.',
        },
        file: {
          type: 'string',
          description: 'BIND zone file content as a string.',
        },
      },
      required: ['zone_id', 'file'],
    },
  },
  {
    name: 'cloudflare_dns__edit_zone_settings',
    description:
      'Edit one or more zone settings (SSL mode, min TLS version, cache level, etc.). Backed by PATCH /zones/:zone_id/settings.',
    inputSchema: {
      type: 'object',
      properties: {
        zone_id: {
          type: 'string',
          description: 'The zone identifier.',
        },
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
    name: 'cloudflare_dns__purge_cache',
    description:
      'Purge cached content for a zone. Purge everything, by URL, by tag, by host, or by prefix. Backed by POST /zones/:zone_id/purge_cache.',
    inputSchema: {
      type: 'object',
      properties: {
        zone_id: {
          type: 'string',
          description: 'The zone identifier.',
        },
        purge_everything: {
          type: 'boolean',
          description: 'Purge all cached content (use with caution on high-traffic sites).',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of URLs to purge.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of cache tags to purge.',
        },
        hosts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of hostnames to purge.',
        },
        prefixes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of URL prefixes to purge.',
        },
      },
      required: ['zone_id'],
    },
  },
  {
    name: 'cloudflare_dns__edit_dnssec',
    description: 'Enable or disable DNSSEC for a zone. Backed by PATCH /zones/:zone_id/dnssec.',
    inputSchema: {
      type: 'object',
      properties: {
        zone_id: {
          type: 'string',
          description: 'The zone identifier.',
        },
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
    name: 'cloudflare_dns__delete_zone',
    description:
      'Delete a DNS zone. The domain immediately stops resolving. All records, settings, and DNSSEC config are lost. Backed by DELETE /zones/:zone_id.',
    inputSchema: {
      type: 'object',
      properties: {
        zone_id: {
          type: 'string',
          description: 'The zone identifier to delete.',
        },
      },
      required: ['zone_id'],
    },
  },
];

export const availableTools: readonly McpToolDeclaration[] = [...READ_TOOLS, ...WRITE_TOOLS];

export const WRITE_TOOL_NAMES = new Set(WRITE_TOOLS.map((t) => t.name));
