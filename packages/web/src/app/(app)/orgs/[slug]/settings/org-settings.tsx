'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Code,
  DangerConfirm,
  Field,
  Input,
} from '@/components/ui';

export function OrgSettings({
  org,
  isOwner,
}: {
  org: { id: string; name: string; slug: string };
  isOwner: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState(org.name);
  const [slug, setSlug] = useState(org.slug);
  const [savingRename, setSavingRename] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function saveRename(e: React.FormEvent) {
    e.preventDefault();
    setSavingRename(true);
    setRenameError(null);
    try {
      const res = await fetch(`/api/v1/orgs/${encodeURIComponent(org.slug)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(name !== org.name ? { name } : {}),
          ...(slug !== org.slug ? { slug } : {}),
        }),
      });
      const json = (await res.json()) as { error?: string; slug?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      if (json.slug && json.slug !== org.slug) {
        // Slug change moves every /orgs/<slug>/... URL in the sidebar. The
        // (app) layout's projects-by-org payload is keyed off the old slug
        // in the client router cache and Next.js' refresh+push race can
        // serve the new URL against the stale layout. Force a real navigation
        // so the layout (and sidebar) re-render from scratch.
        window.location.href = `/orgs/${json.slug}/settings`;
        return;
      }
      router.refresh();
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingRename(false);
    }
  }

  async function destroy() {
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/v1/orgs/${encodeURIComponent(org.slug)}`, {
        method: 'DELETE',
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      // The (app) layout caches the org list on the client; router.refresh()+
      // push race can leave the deleted org in the sidebar dropdown. Hard
      // navigation forces a fresh layout fetch.
      window.location.href = '/dashboard';
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
    }
  }

  const dirty = name !== org.name || slug !== org.slug;

  return (
    <main>
      <header style={{ marginBottom: 'var(--space-6)' }}>
        <h1 style={{ margin: 0 }}>Settings</h1>
        <Code>/{org.slug}</Code>
      </header>

      {!isOwner && (
        <Banner tone="warning">
          Only the org owner can rename or delete this organization. Transfer ownership from the
          Members page.
        </Banner>
      )}

      <div style={{ display: 'grid', gap: 'var(--space-4)', marginTop: 'var(--space-4)' }}>
        <Card>
          <CardHeader>
            <CardTitle>General</CardTitle>
          </CardHeader>
          <CardBody>
            <form onSubmit={saveRename} style={{ display: 'grid', gap: 'var(--space-3)' }}>
              <Field label="Name" hint="Display name shown in the dashboard and sidebar.">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={!isOwner || savingRename}
                  required
                />
              </Field>
              <Field
                label="Slug"
                hint="Used in URLs and tokens. Changing it breaks any external bookmarks."
              >
                <Input
                  value={slug}
                  onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                  pattern="^[a-z0-9](-?[a-z0-9])*$"
                  disabled={!isOwner || savingRename}
                  required
                />
              </Field>
              {renameError && (
                <p style={{ color: 'var(--accent-danger-fg)', margin: 0 }}>{renameError}</p>
              )}
              <div>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={!isOwner || !dirty || savingRename}
                >
                  {savingRename ? 'Saving…' : 'Save changes'}
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Management keys</CardTitle>
          </CardHeader>
          <CardBody>
            <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>
              Org-scoped Bearer credentials used by external services (e.g. the Coding Agent Runner)
              to mint short-lived AccessTokens via <Code>POST /api/v1/runner/tokens</Code>.
            </p>
            <Link
              href={`/orgs/${encodeURIComponent(org.slug)}/settings/management-keys`}
              style={{ color: 'var(--accent-fg)' }}
            >
              Manage keys →
            </Link>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Danger zone</CardTitle>
          </CardHeader>
          <CardBody>
            <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>
              Deleting this organization wipes <strong>everything</strong>: projects, bindings,
              access tokens, audit log, and connected providers. Tokens carrying this org will stop
              working immediately. This is permanent.
            </p>
            {deleteError && <p style={{ color: 'var(--accent-danger-fg)' }}>{deleteError}</p>}
            <Button
              type="button"
              variant="danger"
              disabled={!isOwner}
              onClick={() => setConfirmOpen(true)}
            >
              Delete organization
            </Button>
          </CardBody>
        </Card>
      </div>

      {confirmOpen && (
        <DangerConfirm
          title={`Delete ${org.name}?`}
          body={
            <>
              This will permanently delete <strong>{org.name}</strong>, every project under it, all
              access tokens, and all audit history. Cannot be undone.
            </>
          }
          phrase={org.slug}
          confirmLabel="Delete organization"
          busy={deleting}
          error={deleteError}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={destroy}
        />
      )}
    </main>
  );
}
