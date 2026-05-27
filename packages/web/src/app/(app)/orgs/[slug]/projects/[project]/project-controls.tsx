'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  DangerConfirm,
  Field,
  Input,
} from '@/components/ui';

export function ProjectControls({
  projectId,
  initialName,
  initialSlug,
  orgSlug,
}: {
  projectId: string;
  initialName: string;
  initialSlug: string;
  orgSlug: string;
}) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [slug, setSlug] = useState(initialSlug);
  const [saving, setSaving] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const dirty = name !== initialName || slug !== initialSlug;

  async function saveRename(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setRenameError(null);
    try {
      const res = await fetch(`/api/v1/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          orgSlug,
          ...(name !== initialName ? { name } : {}),
          ...(slug !== initialSlug ? { slug } : {}),
        }),
      });
      const json = (await res.json()) as { error?: string; slug?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      if (json.slug && json.slug !== initialSlug) {
        // Project slug change rewires every sidebar link under this project.
        // Hard-navigate so the (app) layout re-fetches the projects payload.
        window.location.href = `/orgs/${orgSlug}/projects/${json.slug}/settings`;
        return;
      }
      router.refresh();
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function destroy() {
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(
        `/api/v1/projects/${projectId}?orgSlug=${encodeURIComponent(orgSlug)}`,
        { method: 'DELETE' },
      );
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      // Hard navigation so the sidebar's pick-a-project dropdown drops the
      // deleted project (the layout's cached projects payload won't refresh
      // reliably with router.refresh+push in this order).
      window.location.href = `/orgs/${orgSlug}`;
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Project settings</CardTitle>
        </CardHeader>
        <CardBody>
          <form onSubmit={saveRename} style={{ display: 'grid', gap: 'var(--space-3)' }}>
            <Field label="Name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={saving}
                required
              />
            </Field>
            <Field
              label="Slug"
              hint="Used in URLs. Changing it breaks external bookmarks but bindings and tokens follow."
            >
              <Input
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                pattern="^[a-z0-9](-?[a-z0-9])*$"
                disabled={saving}
                required
              />
            </Field>
            {renameError && (
              <p style={{ color: 'var(--accent-danger-fg)', margin: 0 }}>{renameError}</p>
            )}
            <div>
              <Button type="submit" variant="primary" disabled={!dirty || saving}>
                {saving ? 'Saving…' : 'Save changes'}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Danger zone</CardTitle>
        </CardHeader>
        <CardBody>
          <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>
            Deleting <strong>{initialName}</strong> wipes its bindings, access tokens, and audit
            history. Cannot be undone.
          </p>
          {deleteError && <p style={{ color: 'var(--accent-danger-fg)' }}>{deleteError}</p>}
          <Button type="button" variant="danger" onClick={() => setConfirmOpen(true)}>
            Delete project
          </Button>
        </CardBody>
      </Card>

      {confirmOpen && (
        <DangerConfirm
          title={`Delete ${initialName}?`}
          body={
            <>
              Bindings, access tokens, and audit history for <strong>{initialName}</strong> will be
              removed. Tokens carrying this project will stop working immediately.
            </>
          }
          phrase={initialSlug}
          confirmLabel="Delete project"
          busy={deleting}
          error={deleteError}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={destroy}
        />
      )}
    </>
  );
}
