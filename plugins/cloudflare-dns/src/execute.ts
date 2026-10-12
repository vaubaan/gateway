/**
 * Cloudflare DNS tool dispatcher -- routes tool calls to the Cloudflare REST
 * API at https://api.cloudflare.com/client/v4/.
 *
 * Auth model : the stored secret is either a Cloudflare API Token (Bearer)
 * or a Global API Key (email|key format detected by `|` separator). It
 * arrives already decrypted as a plain `token` string.
 *
 * Content-Type : JSON for POST/PATCH bodies, multipart/form-data for
 * import_records.
 */

import { UpstreamAuthError } from '@vaubaan/shared';

const CF_API = 'https://api.cloudflare.com/client/v4';

export type FetchImpl = typeof fetch;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildAuthHeaders(token: string): Record<string, string> {
  if (token.includes('|')) {
    const [email, key] = token.split('|', 2);
    return {
      'X-Auth-Email': email!,
      'X-Auth-Key': key!,
      Accept: 'application/json',
    };
  }
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
}

function toQueryString(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === null || value === undefined) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

async function callCloudflareApi(
  fetchImpl: FetchImpl,
  token: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  let url = `${CF_API}${path}`;
  const headers = buildAuthHeaders(token);
  const init: RequestInit = { method, headers };

  if (method === 'GET') {
    url += toQueryString(args);
  } else if (method === 'POST' || method === 'PATCH') {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(args);
  }
  // DELETE sends no body

  const res = await fetchImpl(url, init);
  const text = await res.text();
  if (!res.ok) {
    const msg = `Cloudflare API ${method} ${path} ${res.status}: ${text.slice(0, 500)}`;
    if (res.status === 401 || res.status === 403) throw new UpstreamAuthError(msg, res.status);
    throw new Error(msg);
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function callCloudflareMultipart(
  fetchImpl: FetchImpl,
  token: string,
  path: string,
  fileContent: string,
): Promise<unknown> {
  const url = `${CF_API}${path}`;
  const headers = buildAuthHeaders(token);

  const formData = new FormData();
  formData.append(
    'file',
    new Blob([fileContent], { type: 'application/octet-stream' }),
    'records.txt',
  );

  const init: RequestInit = {
    method: 'POST',
    headers,
    body: formData,
  };

  const res = await fetchImpl(url, init);
  const text = await res.text();
  if (!res.ok) {
    const msg = `Cloudflare API POST ${path} ${res.status}: ${text.slice(0, 500)}`;
    if (res.status === 401 || res.status === 403) throw new UpstreamAuthError(msg, res.status);
    throw new Error(msg);
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

/**
 * Execute a Cloudflare DNS tool call.
 *
 * @param fetchImpl - fetch implementation (injectable for tests)
 * @param token - the decrypted Cloudflare API Token or Global API Key (email|key)
 * @param tool - the full tool name (e.g. `cloudflare_dns__list_zones`)
 * @param args - the tool arguments
 * @param accountId - the Cloudflare account_id from the binding's resource_ref
 */
export async function executeCall(
  fetchImpl: FetchImpl,
  token: string,
  tool: string,
  args: Record<string, unknown>,
  _accountId: string,
): Promise<unknown> {
  switch (tool) {
    // ─── READS ─────────────────────────────────────────────────────────────
    case 'cloudflare_dns__list_zones': {
      const { page, per_page, ...rest } = args;
      const qs: Record<string, unknown> = { ...rest };
      if (page !== undefined) qs.page = page;
      if (per_page !== undefined) qs.per_page = per_page;
      return callCloudflareApi(fetchImpl, token, 'GET', '/zones', qs);
    }

    case 'cloudflare_dns__get_zone': {
      const zoneId = args.zone_id as string;
      return callCloudflareApi(fetchImpl, token, 'GET', `/zones/${zoneId}`, {});
    }

    case 'cloudflare_dns__list_records': {
      const zoneId = args.zone_id as string;
      const { zone_id: _, ...filters } = args;
      return callCloudflareApi(fetchImpl, token, 'GET', `/zones/${zoneId}/dns_records`, filters);
    }

    case 'cloudflare_dns__get_record': {
      const zoneId = args.zone_id as string;
      const recordId = args.record_id as string;
      return callCloudflareApi(
        fetchImpl,
        token,
        'GET',
        `/zones/${zoneId}/dns_records/${recordId}`,
        {},
      );
    }

    case 'cloudflare_dns__export_records': {
      const zoneId = args.zone_id as string;
      return callCloudflareApi(fetchImpl, token, 'GET', `/zones/${zoneId}/dns_records/export`, {});
    }

    case 'cloudflare_dns__get_zone_settings': {
      const zoneId = args.zone_id as string;
      return callCloudflareApi(fetchImpl, token, 'GET', `/zones/${zoneId}/settings`, {});
    }

    case 'cloudflare_dns__get_dnssec': {
      const zoneId = args.zone_id as string;
      return callCloudflareApi(fetchImpl, token, 'GET', `/zones/${zoneId}/dnssec`, {});
    }

    // ─── WRITES — DNS RECORDS ──────────────────────────────────────────────
    case 'cloudflare_dns__create_record': {
      const zoneId = args.zone_id as string;
      const { zone_id: _, ...body } = args;
      return callCloudflareApi(fetchImpl, token, 'POST', `/zones/${zoneId}/dns_records`, body);
    }

    case 'cloudflare_dns__update_record': {
      const zoneId = args.zone_id as string;
      const recordId = args.record_id as string;
      const { zone_id: _z, record_id: _r, ...body } = args;
      return callCloudflareApi(
        fetchImpl,
        token,
        'PATCH',
        `/zones/${zoneId}/dns_records/${recordId}`,
        body,
      );
    }

    case 'cloudflare_dns__delete_record': {
      const zoneId = args.zone_id as string;
      const recordId = args.record_id as string;
      return callCloudflareApi(
        fetchImpl,
        token,
        'DELETE',
        `/zones/${zoneId}/dns_records/${recordId}`,
        {},
      );
    }

    case 'cloudflare_dns__import_records': {
      const zoneId = args.zone_id as string;
      const fileContent = args.file as string;
      return callCloudflareMultipart(
        fetchImpl,
        token,
        `/zones/${zoneId}/dns_records/import`,
        fileContent,
      );
    }

    // ─── WRITES — ZONE SETTINGS ───────────────────────────────────────────
    case 'cloudflare_dns__edit_zone_settings': {
      const zoneId = args.zone_id as string;
      const items = args.items as Array<{ id: string; value: unknown }>;
      return callCloudflareApi(fetchImpl, token, 'PATCH', `/zones/${zoneId}/settings`, {
        items,
      });
    }

    // ─── WRITES — CACHE PURGE ─────────────────────────────────────────────
    case 'cloudflare_dns__purge_cache': {
      const zoneId = args.zone_id as string;
      const { zone_id: _, ...body } = args;
      return callCloudflareApi(fetchImpl, token, 'POST', `/zones/${zoneId}/purge_cache`, body);
    }

    // ─── WRITES — DNSSEC ──────────────────────────────────────────────────
    case 'cloudflare_dns__edit_dnssec': {
      const zoneId = args.zone_id as string;
      const { zone_id: _, ...body } = args;
      return callCloudflareApi(fetchImpl, token, 'PATCH', `/zones/${zoneId}/dnssec`, body);
    }

    // ─── WRITES — ZONE DELETE ─────────────────────────────────────────────
    case 'cloudflare_dns__delete_zone': {
      const zoneId = args.zone_id as string;
      return callCloudflareApi(fetchImpl, token, 'DELETE', `/zones/${zoneId}`, {});
    }

    default:
      throw new Error(`Cloudflare DNS tool not implemented: ${tool}`);
  }
}
