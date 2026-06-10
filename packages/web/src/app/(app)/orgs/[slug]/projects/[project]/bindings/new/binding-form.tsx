'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Provider } from '@vaubaan/shared';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Code,
  Field,
  Input,
  Select,
  Stack,
  Textarea,
} from '@/components/ui';
import { getSupabaseBrowser } from '@/lib/supabase/client';

const REF_HINT: Record<string, string> = {
  github: 'owner/repo (e.g. acme/website)',
  vercel: 'prj_XXXXXXXXXXXX',
  supabase: '20-char project ref',
  railway: 'project id (UUID)',
};

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

  const [provider, setProvider] = useState<Provider>(offered[0]?.provider ?? 'bash');
  const isBash = provider === 'bash';

  const current = offered.find((o) => o.provider === provider) ?? null;
  const [ref, setRef] = useState<string>(current?.resources[0]?.ref ?? '');

  // Bash binding fields (script holder ; hosts come from the detail page).
  const [bashSlug, setBashSlug] = useState('');
  const [bashName, setBashName] = useState('');
  const [bashContent, setBashContent] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onProviderChange(p: Provider) {
    setProvider(p);
    if (p !== 'bash') {
      const next = offered.find((o) => o.provider === p);
      setRef(next?.resources[0]?.ref ?? '');
    }
    setError(null);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (isBash) {
      await submitBash();
    } else {
      await submitStandard();
    }
  }

  async function submitStandard() {
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
      router.push(`/orgs/${orgSlug}/projects/${projectSlug}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  async function submitBash() {
    if (!bashSlug || !bashName) {
      setError('Slug and display name are required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/bash-bindings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orgSlug,
          projectSlug,
          slug: bashSlug,
          display_name: bashName,
          bash_content: bashContent || undefined,
        }),
      });
      const json = (await res.json()) as {
        binding?: { id: string };
        error?: string;
      };
      if (!res.ok || !json.binding) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      router.push(`/orgs/${orgSlug}/projects/${projectSlug}/bash-bindings/${json.binding.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Stack gap="var(--space-4)">
      <form onSubmit={(e) => void onSubmit(e)}>
        <Card>
          <CardHeader>
            <CardTitle>
              {isBash
                ? 'New Bash binding (script identity ; add hosts after)'
                : 'Pick a resource from a connected provider'}
            </CardTitle>
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
                  <option value="bash">Bash (SSH transport)</option>
                </Select>
              </Field>

              {isBash ? (
                <BashFields
                  bashSlug={bashSlug}
                  setBashSlug={setBashSlug}
                  bashName={bashName}
                  setBashName={setBashName}
                  bashContent={bashContent}
                  setBashContent={setBashContent}
                />
              ) : (
                <Field
                  label="Resource"
                  hint={
                    current?.error
                      ? `${current.error} — type the resource reference manually below.`
                      : current && current.resources.length === 0
                        ? 'No resources visible to the granted token. Type the resource reference manually below.'
                        : 'Pick from the resources the granted token can see.'
                  }
                >
                  {current && current.resources.length > 0 ? (
                    <Select value={ref} onChange={(e) => setRef(e.target.value)}>
                      {(current?.resources ?? []).map((r) => (
                        <option key={r.ref} value={r.ref}>
                          {r.name}
                          {r.description ? ` · ${r.description}` : ''}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input
                      value={ref}
                      onChange={(e) => setRef(e.target.value)}
                      placeholder={REF_HINT[provider]}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  )}
                </Field>
              )}

              {error && <p style={{ color: 'var(--accent-danger-fg)', margin: 0 }}>{error}</p>}

              <div>
                <Button type="submit" disabled={busy || (!isBash && !ref)} variant="primary">
                  {busy ? 'Saving…' : isBash ? 'Save bash binding' : 'Save binding'}
                </Button>
              </div>
            </div>
          </CardBody>
        </Card>
      </form>
    </Stack>
  );
}

function BashFields({
  bashSlug,
  setBashSlug,
  bashName,
  setBashName,
  bashContent,
  setBashContent,
}: {
  bashSlug: string;
  setBashSlug: (v: string) => void;
  bashName: string;
  setBashName: (v: string) => void;
  bashContent: string;
  setBashContent: (v: string) => void;
}) {
  return (
    <>
      <p
        style={{
          color: 'var(--text-muted)',
          fontSize: 'var(--text-sm)',
          margin: 0,
        }}
      >
        A bash binding holds an annotated script. Hosts are attached on the binding&apos;s detail
        page (you&apos;ll be redirected there after creation). The same script runs on every host.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 'var(--space-3)' }}>
        <Field
          label="Slug"
          hint={
            <>
              Used in capability notation as the binding identity (
              <Code>bash:&lt;ring&gt;:&lt;action&gt;@&lt;host&gt;</Code> — slug is implicit on the
              binding).
            </>
          }
        >
          <Input
            placeholder="runner"
            value={bashSlug}
            onChange={(e) => setBashSlug(e.target.value)}
            pattern="[a-z][a-z0-9-]*"
            required
          />
        </Field>
        <Field label="Display name">
          <Input
            placeholder="Runner"
            value={bashName}
            onChange={(e) => setBashName(e.target.value)}
            required
          />
        </Field>
      </div>

      <Field label="Annotated bash (optional — you can add it later from the detail page)">
        <Textarea
          rows={12}
          value={bashContent}
          onChange={(e) => setBashContent(e.target.value)}
          placeholder={
            '#!/usr/bin/env bash\n# @vaubaan-rings: process\n\n# @vaubaan: ring=process action=read\n# @vaubaan-doc: ...\nmy_status() {\n  systemctl status my.service\n}\n'
          }
          style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}
        />
      </Field>
    </>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
