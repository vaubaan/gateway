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

/** Providers that follow the "one upstream project = one env" pattern. For
 *  these, the optional binding slug doubles as the env name stamped on every
 *  capability resolved at call time (cf. supabase/railway classifiers).
 *  Other providers resolve env from call args (github = branch, vercel =
 *  target) — exposing a slug here would be misleading. */
const PROVIDERS_WITH_BINDING_SLUG: ReadonlySet<Provider> = new Set(['supabase', 'railway']);

const SLUG_HINT: Partial<Record<Provider, string>> = {
  supabase:
    'one Supabase project = one env. Defaults to the picked project name ; override with prod/staging if you want short capability slugs (e.g. supabase:db/rows:read@prod).',
  railway:
    'one Railway project = one env. Defaults to the picked project name ; override with prod/staging if you want short capability slugs (e.g. railway:runtime/deployment:write@prod).',
};

/** Kebab-case a free-form display name so it fits the `environment` column
 *  check constraint (`^[a-z0-9](-?[a-z0-9])*$`). Empty result → null slug. */
function kebabize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

interface OfferedProvider {
  provider: Provider;
  resources: Array<{ ref: string; name: string; description?: string; url?: string }>;
  error: string | null;
}

/** When set, the form switches to edit mode : provider is locked, fields are
 *  pre-filled, and submit hits PATCH /api/v1/bindings/:id instead of an
 *  INSERT on provider_bindings. Bash bindings have their own detail page and
 *  are NOT edited here. */
export interface BindingInitial {
  bindingId: string;
  provider: Exclude<Provider, 'bash'>;
  resource_ref: string;
  environment: string | null;
  env_less_exclude_branch: string | null;
  env_less_exclude_protected: boolean;
}

type ExcludeMode = 'none' | 'branch' | 'protected';

function initialExcludeMode(init?: BindingInitial): ExcludeMode {
  if (!init) return 'branch';
  if (init.env_less_exclude_protected) return 'protected';
  if (init.env_less_exclude_branch) return 'branch';
  return 'none';
}

export function BindingForm({
  orgSlug,
  projectId,
  projectSlug,
  offered,
  initial,
}: {
  orgSlug: string;
  projectId: string;
  projectSlug: string;
  offered: OfferedProvider[];
  initial?: BindingInitial;
}) {
  const router = useRouter();
  const isEdit = initial !== undefined;

  const [provider, setProvider] = useState<Provider>(
    initial?.provider ?? offered[0]?.provider ?? 'bash',
  );
  // Bash sub-form only exists in create mode (bash bindings have their own
  // detail page for editing).
  const isBash = !isEdit && provider === 'bash';
  const supportsBindingSlug = !isBash && PROVIDERS_WITH_BINDING_SLUG.has(provider);

  const current = offered.find((o) => o.provider === provider) ?? null;
  const [ref, setRef] = useState<string>(initial?.resource_ref ?? current?.resources[0]?.ref ?? '');
  // Binding slug (persisted to provider_bindings.environment). Defaults to the
  // picked resource's display name (kebabed) so the common case "one project
  // per env, named after the env" needs no extra typing. Only relevant for
  // providers in PROVIDERS_WITH_BINDING_SLUG.
  const initialSlug = initial
    ? (initial.environment ?? '')
    : supportsBindingSlug
      ? kebabize(current?.resources[0]?.name ?? '')
      : '';
  const [bindingSlug, setBindingSlug] = useState<string>(initialSlug);
  // Once the operator edits the slug, stop tracking the picked resource name.
  // In edit mode, start as "touched" so we never overwrite the stored slug.
  const [slugTouched, setSlugTouched] = useState(isEdit);

  // Bash binding fields (script holder ; hosts come from the detail page).
  // Create-mode only — never reached in edit.
  const [bashSlug, setBashSlug] = useState('');
  const [bashName, setBashName] = useState('');
  const [bashContent, setBashContent] = useState('');

  // GitHub-only : narrows the fan-out of an env-less grant (spec §5.1 #4).
  // Default = exclude 'main', the dominant SaaS pattern (main = canonical /
  // protected). Operator picks 'protected' for repos that already declare a
  // protected-branches set on GitHub.
  const [excludeMode, setExcludeMode] = useState<ExcludeMode>(initialExcludeMode(initial));
  const [excludeBranch, setExcludeBranch] = useState<string>(
    initial?.env_less_exclude_branch ?? 'main',
  );

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onProviderChange(p: Provider) {
    setProvider(p);
    if (p !== 'bash') {
      const next = offered.find((o) => o.provider === p);
      setRef(next?.resources[0]?.ref ?? '');
      if (!slugTouched) {
        const slugForNext = PROVIDERS_WITH_BINDING_SLUG.has(p)
          ? kebabize(next?.resources[0]?.name ?? '')
          : '';
        setBindingSlug(slugForNext);
      }
    }
    setError(null);
  }

  function onRefChange(nextRef: string) {
    setRef(nextRef);
    if (!slugTouched && supportsBindingSlug) {
      const name = current?.resources.find((r) => r.ref === nextRef)?.name ?? '';
      setBindingSlug(kebabize(name));
    }
  }

  function onSlugChange(next: string) {
    setBindingSlug(next);
    setSlugTouched(true);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (isBash) {
      await submitBash();
    } else if (isEdit) {
      await submitPatch();
    } else {
      await submitInsert();
    }
  }

  /** Clean + validate the slug. Returns the cleaned value (string or null).
   *  Throws on invalid kebab shape. */
  function cleanSlug(): string | null {
    if (!supportsBindingSlug) return null;
    const slugClean = bindingSlug.trim();
    if (!slugClean) return null;
    if (!/^[a-z0-9](-?[a-z0-9])*$/.test(slugClean)) {
      throw new Error(
        `Binding slug '${slugClean}' must be lowercase kebab-case (e.g. 'prod', 'staging', 'preview').`,
      );
    }
    return slugClean;
  }

  async function submitInsert() {
    if (!ref) {
      setError('Pick a resource first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const supabase = getSupabaseBrowser();
      const display = current?.resources.find((r) => r.ref === ref)?.name ?? ref;
      // The DB CHECK constraint enforces the kebab-case shape ; surface the
      // violation up front rather than letting Postgres reject the insert.
      const slugValue = cleanSlug();
      // GitHub-only knobs : the DB CHECK enforces both XOR and github-only,
      // so we pass nulls/false on other providers (the row will fail any
      // accidental mis-set).
      const githubExclude =
        provider === 'github'
          ? {
              env_less_exclude_branch:
                excludeMode === 'branch' && excludeBranch.trim() ? excludeBranch.trim() : null,
              env_less_exclude_protected: excludeMode === 'protected',
            }
          : { env_less_exclude_branch: null, env_less_exclude_protected: false };
      const { error: err } = await supabase.from('provider_bindings').insert({
        project_id: projectId,
        provider,
        resource_ref: ref,
        display_name: display,
        environment: slugValue,
        ...githubExclude,
      });
      if (err) throw err;
      router.push(`/orgs/${orgSlug}/projects/${projectSlug}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  async function submitPatch() {
    if (!initial) return;
    if (!ref) {
      setError('Pick a resource first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const display = current?.resources.find((r) => r.ref === ref)?.name ?? ref;
      const slugValue = cleanSlug();
      const body: Record<string, unknown> = { orgSlug };
      if (ref !== initial.resource_ref) {
        body.resource_ref = ref;
        body.display_name = display;
      }
      if (slugValue !== initial.environment) {
        body.environment = slugValue;
      }
      if (provider === 'github') {
        const nextBranch =
          excludeMode === 'branch' && excludeBranch.trim() ? excludeBranch.trim() : null;
        const nextProtected = excludeMode === 'protected';
        if (nextBranch !== initial.env_less_exclude_branch) {
          body.env_less_exclude_branch = nextBranch;
        }
        if (nextProtected !== initial.env_less_exclude_protected) {
          body.env_less_exclude_protected = nextProtected;
        }
      }
      if (Object.keys(body).length === 1) {
        // only orgSlug — nothing to change
        router.push(`/orgs/${orgSlug}/projects/${projectSlug}`);
        return;
      }
      const res = await fetch(`/api/v1/bindings/${initial.bindingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
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

  const cardTitle = isEdit
    ? `Edit ${provider} binding`
    : isBash
      ? 'New Bash binding (script identity ; add hosts after)'
      : 'Pick a resource from a connected provider';

  return (
    <Stack gap="var(--space-4)">
      <form onSubmit={(e) => void onSubmit(e)}>
        <Card>
          <CardHeader>
            <CardTitle>{cardTitle}</CardTitle>
          </CardHeader>
          <CardBody>
            <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
              <Field
                label="Provider"
                hint={isEdit ? 'Provider is fixed for an existing binding.' : undefined}
              >
                <Select
                  value={provider}
                  onChange={(e) => onProviderChange(e.target.value as Provider)}
                  disabled={isEdit}
                >
                  {offered.map((o) => (
                    <option key={o.provider} value={o.provider}>
                      {capitalize(o.provider)}
                      {o.resources.length === 0 ? ' (no resources)' : ''}
                    </option>
                  ))}
                  {!isEdit && <option value="bash">Bash (SSH transport)</option>}
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
                    <Select value={ref} onChange={(e) => onRefChange(e.target.value)}>
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
                      onChange={(e) => onRefChange(e.target.value)}
                      placeholder={REF_HINT[provider]}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  )}
                </Field>
              )}

              {supportsBindingSlug && (
                <Field label="Binding slug (optional)" hint={SLUG_HINT[provider]}>
                  <Input
                    value={bindingSlug}
                    onChange={(e) => onSlugChange(e.target.value)}
                    placeholder="prod"
                    autoComplete="off"
                    spellCheck={false}
                    pattern="^[a-z0-9](-?[a-z0-9])*$"
                  />
                </Field>
              )}

              {provider === 'github' && !isBash && (
                <GithubExcludeOptions
                  mode={excludeMode}
                  setMode={setExcludeMode}
                  branch={excludeBranch}
                  setBranch={setExcludeBranch}
                />
              )}

              {error && <p style={{ color: 'var(--accent-danger-fg)', margin: 0 }}>{error}</p>}

              <div>
                <Button type="submit" disabled={busy || (!isBash && !ref)} variant="primary">
                  {busy
                    ? 'Saving…'
                    : isEdit
                      ? 'Save changes'
                      : isBash
                        ? 'Save bash binding'
                        : 'Save binding'}
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

/** GitHub binding sub-form : narrow the fan-out of env-less grants. The two
 *  options are mutually exclusive (XOR, enforced by the DB CHECK) — see
 *  docs/spec/gateway-capability-model.md §5.1 #4. */
function GithubExcludeOptions({
  mode,
  setMode,
  branch,
  setBranch,
}: {
  mode: 'none' | 'branch' | 'protected';
  setMode: (m: 'none' | 'branch' | 'protected') => void;
  branch: string;
  setBranch: (s: string) => void;
}) {
  return (
    <Field
      label="Env-less grants on this repo cover…"
      hint={
        <>
          A token granted <Code>github:code:write</Code> without an <Code>@branch</Code> fans out to
          every branch by default. Pick what to subtract from that fan-out — typically{' '}
          <Code>main</Code> or the repo&apos;s protected set.
        </>
      }
    >
      <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <input
            type="radio"
            name="exclude-mode"
            checked={mode === 'none'}
            onChange={() => setMode('none')}
          />
          <span>All branches (true fan-out, no exclusion).</span>
        </label>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            flexWrap: 'wrap',
          }}
        >
          <input
            type="radio"
            name="exclude-mode"
            checked={mode === 'branch'}
            onChange={() => setMode('branch')}
          />
          <span>All branches except a named one:</span>
          <Input
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="main"
            disabled={mode !== 'branch'}
            autoComplete="off"
            spellCheck={false}
            pattern="^[a-z0-9](?:[a-z0-9/_-]*[a-z0-9])?$"
            style={{ maxWidth: 220 }}
          />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <input
            type="radio"
            name="exclude-mode"
            checked={mode === 'protected'}
            onChange={() => setMode('protected')}
          />
          <span>
            All branches except the repo&apos;s <strong>protected branches</strong> (resolved at
            call time via the GitHub install token, cached 60s).
          </span>
        </label>
      </div>
    </Field>
  );
}
