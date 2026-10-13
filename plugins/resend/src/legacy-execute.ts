/**
 * LEGACY v4 dispatcher — one raw API key, no resource, audience-era endpoints.
 *
 * Kept so `apps/gateway/src/lib/gateway/build.ts` compiles until P1.6. Nothing
 * here is reached by the v5 gateway ; the v5 dispatcher is `execute.ts`.
 *
 * @deprecated legacy v4, deleted in P1.6 — use `executeResend(ctx, tool, args)`.
 *
 * Resend tool dispatcher — routes tool calls to the Resend REST API
 * at https://api.resend.com/.
 *
 * Auth model : the stored secret is a Resend API key (`re_*`). It arrives
 * already decrypted as a plain `token` string. We use
 * `Authorization: Bearer <token>`.
 *
 * Content-Type : Resend uses `application/json` for POST/PUT/PATCH bodies.
 * GET endpoints use no body. DELETE endpoints use no body.
 */

import { UpstreamAuthError } from '@vaubaan/shared';

const RESEND_API = 'https://api.resend.com';

/** @deprecated legacy v4, deleted in P1.6. */
export type FetchImpl = typeof fetch;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build query-string from args (for GET requests). */
function toQueryString(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === null || value === undefined) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

async function callResendApi(
  fetchImpl: FetchImpl,
  token: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  let url = `${RESEND_API}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  const init: RequestInit = { method, headers };

  if (method === 'GET') {
    url += toQueryString(args);
  } else if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    headers['Content-Type'] = 'application/json';
    const body = JSON.stringify(args);
    init.body = body;
  }
  // DELETE sends no body

  const res = await fetchImpl(url, init);
  const text = await res.text();
  if (!res.ok) {
    const msg = `Resend API ${method} ${path} ${res.status}: ${text.slice(0, 500)}`;
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
 * Execute a Resend tool call.
 *
 * @param fetchImpl - fetch implementation (injectable for tests)
 * @param token - the decrypted Resend API key (re_*)
 * @param tool - the full tool name (e.g. `resend__send_email`)
 * @param args - the tool arguments
 * @param bindingMetadata - the binding's metadata (for describe_zones)
 */
/** @deprecated legacy v4, deleted in P1.6 — use `executeResend(ctx, tool, args)`. */
export async function executeCall(
  fetchImpl: FetchImpl,
  token: string,
  tool: string,
  args: Record<string, unknown>,
  bindingMetadata?: Record<string, unknown> | null,
): Promise<unknown> {
  switch (tool) {
    // ─── READS ─────────────────────────────────────────────────────────────
    case 'resend__get_email': {
      const id = args.id as string;
      return callResendApi(fetchImpl, token, 'GET', `/emails/${id}`, {});
    }

    case 'resend__list_domains':
      return callResendApi(fetchImpl, token, 'GET', '/domains', {});

    case 'resend__get_domain': {
      const id = args.id as string;
      return callResendApi(fetchImpl, token, 'GET', `/domains/${id}`, {});
    }

    case 'resend__list_audiences':
      return callResendApi(fetchImpl, token, 'GET', '/audiences', {});

    case 'resend__get_audience': {
      const id = args.id as string;
      return callResendApi(fetchImpl, token, 'GET', `/audiences/${id}`, {});
    }

    case 'resend__list_contacts': {
      const audId = args.audience_id as string;
      return callResendApi(fetchImpl, token, 'GET', `/audiences/${audId}/contacts`, {});
    }

    case 'resend__get_contact': {
      const id = args.id as string;
      return callResendApi(fetchImpl, token, 'GET', `/contacts/${id}`, {});
    }

    case 'resend__list_broadcasts':
      return callResendApi(fetchImpl, token, 'GET', '/broadcasts', {});

    case 'resend__get_broadcast': {
      const id = args.id as string;
      return callResendApi(fetchImpl, token, 'GET', `/broadcasts/${id}`, {});
    }

    // ─── WRITES — transactional email ──────────────────────────────────────
    case 'resend__send_email': {
      return callResendApi(fetchImpl, token, 'POST', '/emails', args);
    }

    case 'resend__send_batch_emails': {
      // Resend expects the batch body directly as an array or as { ... }
      // The API expects POST /emails/batch with the emails array.
      return callResendApi(fetchImpl, token, 'POST', '/emails/batch', args);
    }

    // ─── WRITES — domains ──────────────────────────────────────────────────
    case 'resend__create_domain':
      return callResendApi(fetchImpl, token, 'POST', '/domains', args);

    case 'resend__update_domain': {
      const id = args.id as string;
      const { id: _, ...rest } = args;
      return callResendApi(fetchImpl, token, 'PATCH', `/domains/${id}`, rest);
    }

    case 'resend__delete_domain': {
      const id = args.id as string;
      return callResendApi(fetchImpl, token, 'DELETE', `/domains/${id}`, {});
    }

    case 'resend__verify_domain': {
      const id = args.id as string;
      return callResendApi(fetchImpl, token, 'POST', `/domains/${id}/verify`, {});
    }

    // ─── WRITES — audiences ────────────────────────────────────────────────
    case 'resend__create_audience':
      return callResendApi(fetchImpl, token, 'POST', '/audiences', args);

    case 'resend__delete_audience': {
      const id = args.id as string;
      return callResendApi(fetchImpl, token, 'DELETE', `/audiences/${id}`, {});
    }

    // ─── WRITES — contacts ─────────────────────────────────────────────────
    case 'resend__create_contact': {
      const audId = args.audience_id as string;
      const { audience_id: _, ...rest } = args;
      return callResendApi(fetchImpl, token, 'POST', `/audiences/${audId}/contacts`, rest);
    }

    case 'resend__update_contact': {
      const id = args.id as string;
      const { id: _, ...rest } = args;
      return callResendApi(fetchImpl, token, 'PATCH', `/contacts/${id}`, rest);
    }

    case 'resend__delete_contact': {
      const id = args.id as string;
      return callResendApi(fetchImpl, token, 'DELETE', `/contacts/${id}`, {});
    }

    // ─── WRITES — broadcasts ───────────────────────────────────────────────
    case 'resend__create_broadcast': {
      const audId = args.audience_id as string;
      const { audience_id: _, ...rest } = args;
      return callResendApi(fetchImpl, token, 'POST', `/audiences/${audId}/broadcasts`, rest);
    }

    case 'resend__update_broadcast': {
      const id = args.id as string;
      const { id: _, ...rest } = args;
      return callResendApi(fetchImpl, token, 'PUT', `/broadcasts/${id}`, rest);
    }

    case 'resend__send_broadcast': {
      const id = args.id as string;
      return callResendApi(fetchImpl, token, 'POST', `/broadcasts/${id}/send`, {});
    }

    case 'resend__delete_broadcast': {
      const id = args.id as string;
      return callResendApi(fetchImpl, token, 'DELETE', `/broadcasts/${id}`, {});
    }

    // ─── SYNTHETIC — describe_zones ────────────────────────────────────────
    case 'resend__describe_zones': {
      const meta = bindingMetadata ?? {};
      return {
        internal_domains: meta.internal_domains ?? [],
        allowlist_domains: meta.allowlist_domains ?? [],
        allowlist_addresses: meta.allowlist_addresses ?? [],
        sending_domains: meta.sending_domains ?? [],
      };
    }

    default:
      throw new Error(`Resend tool not implemented: ${tool}`);
  }
}
