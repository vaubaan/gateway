/**
 * `/orgs/:slug/resources/:rId` — Resource detail page. Spec §11.1.
 *
 * Server component. Fetches the resource row, the access summary list
 * (just keys, no blobs — spec §6.4), the local audit timeline, and
 * the list of "Provisioned children" if the resource is an Admin.
 *
 * The Health probe button and "Add access" dialog live inside the
 * `<ResourceDetailClient>` island.
 */

import { notFound } from 'next/navigation';
import type { ReactElement } from 'react';

import { findKind } from '@crm/catalog';

import { ResourceStatusBadge } from '@/components/resources/ResourceStatusBadge';
import { ResourceDetailClient } from '@/components/resources/ResourceDetailClient';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly params: Promise<{ readonly slug: string; readonly rId: string }>;
}

interface OrgRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

interface ResourceRow {
  readonly id: string;
  readonly organization_id: string;
  readonly project_id: string | null;
  readonly admin_resource_id: string | null;
  readonly provider_name: string;
  readonly kind: string;
  readonly scope: 'org' | 'project';
  readonly is_admin: boolean;
  readonly name: string;
  readonly variant: string | null;
  readonly provider_ref: string | null;
  readonly console_url: string | null;
  readonly setup_docs_url: string | null;
  readonly status: string;
  readonly provider_metadata: Record<string, unknown>;
  readonly connection_status: string;
  readonly connection_checked_at: string | null;
  readonly connection_message: string | null;
}

interface AccessSummaryRow {
  readonly key: string;
  readonly description: string | null;
  readonly rotated_at: string;
  readonly recipient_count: number;
}

interface AuditRow {
  readonly id: string;
  readonly action: string;
  readonly subject: Record<string, unknown>;
  readonly scope: Record<string, unknown>;
  readonly at: string;
}

interface SupabaseLike {
  from(table: string): {
    select(cols: string): {
      eq(
        col: string,
        val: string | boolean,
      ): {
        eq(
          col: string,
          val: string | boolean,
        ): {
          maybeSingle(): Promise<{ data: unknown; error: { message: string } | null }>;
          order(
            col: string,
            opts: { ascending: boolean },
          ): {
            limit(n: number): Promise<{ data: unknown; error: { message: string } | null }>;
          };
        };
        maybeSingle(): Promise<{ data: unknown; error: { message: string } | null }>;
        order(
          col: string,
          opts: { ascending: boolean },
        ): {
          limit(n: number): Promise<{ data: unknown; error: { message: string } | null }>;
        };
      };
    };
  };
}

function recipientCountFromBlob(blob: unknown): number {
  if (
    typeof blob === 'object' &&
    blob !== null &&
    Array.isArray((blob as { recipients?: unknown }).recipients)
  ) {
    return (blob as { recipients: unknown[] }).recipients.length;
  }
  return 0;
}

function parseSealedBlobBytea(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.startsWith('\\x')) {
      const hex = value.slice(2);
      const bytes = Buffer.from(hex, 'hex');
      try {
        return JSON.parse(bytes.toString('utf8'));
      } catch {
        return null;
      }
    }
    try {
      return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
    } catch {
      return null;
    }
  }
  if (value instanceof Uint8Array) {
    try {
      return JSON.parse(Buffer.from(value).toString('utf8'));
    } catch {
      return null;
    }
  }
  return null;
}

export default async function ResourceDetailPage({ params }: PageProps): Promise<ReactElement> {
  const { slug, rId } = await params;
  const supabase = (await createSupabaseServerClient()) as unknown as SupabaseLike;

  const orgRes = await supabase
    .from('organizations')
    .select('id, slug, name')
    .eq('slug', slug)
    .maybeSingle();
  const org = orgRes.data as OrgRow | null;
  if (!org) notFound();

  const resourceRes = await supabase
    .from('resources')
    .select(
      'id, organization_id, project_id, admin_resource_id, provider_name, kind, scope, is_admin, name, variant, provider_ref, console_url, setup_docs_url, status, provider_metadata, connection_status, connection_checked_at, connection_message',
    )
    .eq('organization_id', org.id)
    .eq('id', rId)
    .maybeSingle();
  const resource = resourceRes.data as ResourceRow | null;
  if (!resource) notFound();

  // Access summary — read sealed_blob column to compute recipient_count
  // server-side (RLS already gates the SELECT to org members).
  const accessRes = await supabase
    .from('resource_access')
    .select('key, description, rotated_at, sealed_blob')
    .eq('resource_id', resource.id)
    .order('key', { ascending: true })
    .limit(200);
  if (accessRes.error) {
    throw new Error(`Failed to load resource access: ${accessRes.error.message}`);
  }
  type RawAccess = Pick<AccessSummaryRow, 'key' | 'description' | 'rotated_at'> & {
    sealed_blob: unknown;
  };
  const accessSummary: AccessSummaryRow[] = (
    (accessRes.data as ReadonlyArray<RawAccess> | null) ?? []
  ).map((row) => ({
    key: row.key,
    description: row.description,
    rotated_at: row.rotated_at,
    recipient_count: recipientCountFromBlob(parseSealedBlobBytea(row.sealed_blob)),
  }));

  // Audit timeline scoped to this resource (RLS still gates by org).
  const auditRes = await supabase
    .from('audit_log')
    .select('id, action, subject, scope, at')
    .eq('organization_id', org.id)
    .order('at', { ascending: false })
    .limit(50);
  type RawAudit = AuditRow;
  const auditAll = (auditRes.data as ReadonlyArray<RawAudit> | null) ?? [];
  const audit = auditAll.filter((row) => {
    const sc = row.scope;
    return (
      typeof sc === 'object' &&
      sc !== null &&
      (sc as { resource_id?: string }).resource_id === resource.id
    );
  });

  // Provisioned children for an Admin resource.
  let children: ReadonlyArray<{ id: string; name: string; kind: string; status: string }> = [];
  if (resource.is_admin) {
    const childRes = await supabase
      .from('resources')
      .select('id, name, kind, status, admin_resource_id, organization_id')
      .eq('organization_id', org.id)
      .eq('admin_resource_id', resource.id)
      .order('name', { ascending: true })
      .limit(200);
    children =
      (childRes.data as ReadonlyArray<{
        id: string;
        name: string;
        kind: string;
        status: string;
      }> | null) ?? [];
  }

  const kindInfo = findKind(resource.kind);
  const accessSchemaKeys = kindInfo
    ? Object.keys(kindInfo.accessSchema).sort((a, b) => a.localeCompare(b))
    : [];

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold">{resource.name}</h1>
          <ResourceStatusBadge label={resource.status} />
          <ResourceStatusBadge
            label={resource.connection_status}
            kind="connection"
            title={resource.connection_message ?? undefined}
          />
        </div>
        <p className="text-xs text-neutral-600">
          {resource.provider_name} / {resource.kind} · scope {resource.scope}
          {resource.variant ? ` · variant ${resource.variant}` : ''}
          {resource.is_admin ? ' · admin' : ''}
        </p>
        {resource.console_url ? (
          <a
            href={resource.console_url}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-blue-700 underline"
          >
            Open provider console ↗
          </a>
        ) : null}
      </header>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Provider metadata</h2>
        <pre
          data-testid="resource-detail-metadata"
          className="overflow-x-auto rounded bg-neutral-100 p-2 font-mono text-xs"
        >
          {JSON.stringify(resource.provider_metadata, null, 2)}
        </pre>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Access keys</h2>
        {accessSummary.length === 0 ? (
          <span data-testid="resource-detail-access-empty" className="text-xs text-neutral-600">
            No sealed access stored for this resource yet.
          </span>
        ) : (
          <ul className="flex flex-col gap-1 text-sm" data-testid="resource-detail-access-list">
            {accessSummary.map((row) => (
              <li
                key={row.key}
                data-testid={`resource-detail-access-row-${row.key}`}
                className="flex items-center justify-between border-b border-neutral-100 py-1"
              >
                <span className="font-mono text-xs">{row.key}</span>
                <span className="text-xs text-neutral-600">
                  sealed for {String(row.recipient_count)} · rotated{' '}
                  {new Date(row.rotated_at).toISOString().slice(0, 10)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <ResourceDetailClient
          orgSlug={org.slug}
          resourceId={resource.id}
          resourceName={resource.name}
          accessKeys={accessSchemaKeys}
          destroyEnabled={resource.scope === 'project' && resource.admin_resource_id !== null}
          providerRef={resource.provider_ref}
          adminResourceId={resource.admin_resource_id}
        />
      </section>

      {resource.is_admin ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">Provisioned children</h2>
          {children.length === 0 ? (
            <span data-testid="resource-detail-children-empty" className="text-xs text-neutral-600">
              No children yet. Phase 6 enables `+ Provision via this Admin`.
            </span>
          ) : (
            <ul className="flex flex-col gap-1 text-sm" data-testid="resource-detail-children-list">
              {children.map((c) => (
                <li
                  key={c.id}
                  data-testid={`resource-detail-child-${c.id}`}
                  className="border-b border-neutral-100 py-1"
                >
                  <a
                    href={`/orgs/${org.slug}/resources/${c.id}`}
                    className="text-blue-700 underline"
                  >
                    {c.name}
                  </a>{' '}
                  <span className="text-xs text-neutral-600">
                    {c.kind} · {c.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Audit timeline (last 50)</h2>
        {audit.length === 0 ? (
          <span data-testid="resource-detail-audit-empty" className="text-xs text-neutral-600">
            No audit events for this resource yet.
          </span>
        ) : (
          <ol className="flex flex-col gap-1 text-xs" data-testid="resource-detail-audit-list">
            {audit.map((row) => (
              <li key={row.id} className="flex items-baseline gap-2">
                <span className="font-mono text-neutral-600">{new Date(row.at).toISOString()}</span>
                <span className="font-medium">{row.action}</span>
                <span className="text-neutral-600">
                  {JSON.stringify({ ...row.subject, ...row.scope })}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}
