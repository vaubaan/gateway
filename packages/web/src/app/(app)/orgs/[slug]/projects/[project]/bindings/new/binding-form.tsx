'use client';

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import type { Provider } from '@vaubaan/shared';
import { Button, Card, CardBody, CardHeader, CardTitle, Field, Select } from '@/components/ui';
import { getSupabaseBrowser } from '@/lib/supabase/client';

interface OfferedProvider {
  provider: Provider;
  resources: Array<{ ref: string; name: string; description?: string; url?: string }>;
  error: string | null;
}

export function BindingForm({
  orgSlug,
  projectId,
  projectSlug,
  offered,
}: {
  orgSlug: string;
  projectId: string;
  projectSlug: string;
  offered: OfferedProvider[];
}) {
  const router = useRouter();
  const [provider, setProvider] = useState<Provider>(offered[0]!.provider);
  const current = useMemo(
    () => offered.find((o) => o.provider === provider) ?? null,
    [offered, provider],
  );
  const [ref, setRef] = useState<string>(current?.resources[0]?.ref ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset ref when provider changes.
  function onProviderChange(p: Provider) {
    setProvider(p);
    const next = offered.find((o) => o.provider === p);
    setRef(next?.resources[0]?.ref ?? '');
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!ref) {
      setError('Pick a resource first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const supabase = getSupabaseBrowser();
      const display = current?.resources.find((r) => r.ref === ref)?.name ?? ref;
      const { error: err } = await supabase.from('provider_bindings').insert({
        project_id: projectId,
        provider,
        resource_ref: ref,
        display_name: display,
      });
      if (err) throw err;
      router.refresh();
      router.push(`/orgs/${orgSlug}/projects/${projectSlug}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit}>
      <Card>
        <CardHeader>
          <CardTitle>Pick a resource from a connected provider</CardTitle>
        </CardHeader>
        <CardBody>
          <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
            <Field label="Provider">
              <Select
                value={provider}
                onChange={(e) => onProviderChange(e.target.value as Provider)}
              >
                {offered.map((o) => (
                  <option key={o.provider} value={o.provider}>
                    {capitalize(o.provider)}
                    {o.resources.length === 0 ? ' (no resources)' : ''}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Resource"
              hint={
                current?.error
                  ? `Could not list resources: ${current.error}`
                  : current && current.resources.length === 0
                    ? 'No resources visible to the granted token for this provider.'
                    : undefined
              }
            >
              <Select
                value={ref}
                onChange={(e) => setRef(e.target.value)}
                disabled={!current || current.resources.length === 0}
              >
                {!current?.resources.length && <option value="">— none available —</option>}
                {(current?.resources ?? []).map((r) => (
                  <option key={r.ref} value={r.ref}>
                    {r.name}
                    {r.description ? ` · ${r.description}` : ''}
                  </option>
                ))}
              </Select>
            </Field>

            {error && <p style={{ color: 'var(--accent-danger-fg)', margin: 0 }}>{error}</p>}

            <div>
              <Button type="submit" disabled={busy || !ref} variant="primary">
                {busy ? 'Saving…' : 'Save binding'}
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>
    </form>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
