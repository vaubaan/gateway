'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Banner, Button, Field, Input, Textarea } from '@/components/ui';

export function NewServiceForm({
  orgSlug,
  projectSlug,
  template,
}: {
  orgSlug: string;
  projectSlug: string;
  template: string;
}) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState('Runner');
  const [description, setDescription] = useState('');
  const [bash, setBash] = useState(template);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/v1/services', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          orgSlug,
          projectSlug,
          display_name: displayName,
          description: description || undefined,
          bash_content: bash,
        }),
      });
      const json = (await res.json()) as { service?: { id: string }; error?: string };
      if (!res.ok || !json.service) {
        setError(json.error ?? 'failed to create service');
        return;
      }
      router.push(`/orgs/${orgSlug}/projects/${projectSlug}/services/${json.service.id}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'unknown error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 'var(--space-3)' }}>
      {error && <Banner tone="danger">{error}</Banner>}

      <Field label="Display name">
        <Input
          required
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Runner"
        />
      </Field>

      <Field label="Description (optional)">
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Manage the runner daemon over SSH"
        />
      </Field>

      <Field label="Annotated bash">
        <Textarea
          required
          rows={20}
          value={bash}
          onChange={(e) => setBash(e.target.value)}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}
        />
      </Field>

      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
        <Button type="submit" variant="primary" disabled={submitting}>
          {submitting ? 'Creating…' : 'Create service'}
        </Button>
      </div>
    </form>
  );
}
