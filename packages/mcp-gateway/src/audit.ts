/**
 * Audit writer — `audit_log` row per MCP call (allowed or denied).
 *
 * Spec : docs/spec/vaubaan-gateway.md §13.1.
 *
 * Writes go via the service_role Supabase client (bypasses RLS — the gateway
 * is the only writer of audit_log per design).
 */

import { createHash } from 'node:crypto';
import type { AuditDecision } from '@vaubaan/shared';

export interface AuditRow {
  organization_id: string;
  project_id: string | null;
  access_token_id: string | null;
  tool_name: string;
  arguments_hash: string;
  role_matched: string | null;
  decision: AuditDecision;
  denial_reason: string | null;
  upstream_latency_ms: number | null;
  client_ip: string | null;
  client_user_agent: string | null;
}

export interface AuditWriter {
  write(row: AuditRow): Promise<void>;
}

export function hashArguments(args: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(args ?? {}))
    .digest('hex')
    .slice(0, 16);
}

/** In-memory writer for tests + dev fallback when Supabase is unreachable. */
export class MemoryAuditWriter implements AuditWriter {
  readonly rows: AuditRow[] = [];
  async write(row: AuditRow): Promise<void> {
    this.rows.push(row);
  }
}

/**
 * Adapter for a Supabase client (created by the caller — we don't pull
 * @supabase/supabase-js as a runtime dep of the gateway core; it lives in web).
 */
export interface SupabaseLike {
  from(table: string): {
    insert(row: AuditRow): { error: { message: string } | null };
  };
}

export class SupabaseAuditWriter implements AuditWriter {
  constructor(private readonly client: SupabaseLike) {}
  async write(row: AuditRow): Promise<void> {
    const { error } = this.client.from('audit_log').insert(row);
    if (error) {
      // Don't throw on audit failure — degrade gracefully but log loudly.
      // The gateway's value is still delivered; observability matters for ops.
      console.error('[audit] failed to write row', { error: error.message, row });
    }
  }
}
