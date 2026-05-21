/**
 * `<OnboardingForm>` — client island for the onboarding page. POSTs to
 * `/api/crm/v1/orgs` then navigates to the new org's resources page.
 *
 * Phase 4 wave C — minimal slug + name form, with the slug regex
 * validated client-side for immediate feedback.
 */

'use client';

import { useState } from 'react';

const SLUG_REGEX = /^[a-z0-9](-?[a-z0-9])*$/;

export function OnboardingForm(): React.ReactElement {
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    if (!SLUG_REGEX.test(slug)) {
      setError(`slug must match ${SLUG_REGEX.source}`);
      return;
    }
    if (name.trim().length === 0) {
      setError('name is required');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/crm/v1/orgs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug, name: name.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        setError(body.message ?? body.error ?? `HTTP ${String(res.status)}`);
        return;
      }
      window.location.href = `/orgs/${encodeURIComponent(slug)}/resources`;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'network_error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="flex flex-col gap-3 text-sm"
      data-testid="onboarding-form"
    >
      <label className="flex flex-col gap-1">
        <span>Org slug (lowercase, hyphens, no spaces)</span>
        <input
          required
          value={slug}
          onChange={(e) => {
            setSlug(e.target.value);
          }}
          data-testid="onboarding-slug"
          className="rounded border border-neutral-300 px-2 py-1 font-mono"
          placeholder="acme"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span>Org display name</span>
        <input
          required
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
          data-testid="onboarding-name"
          className="rounded border border-neutral-300 px-2 py-1"
          placeholder="Acme Corporation"
        />
      </label>
      <button
        type="submit"
        disabled={busy}
        data-testid="onboarding-submit"
        className="self-start rounded bg-neutral-900 px-3 py-1 text-white disabled:opacity-50"
      >
        {busy ? 'Creating…' : 'Create organization'}
      </button>
      {error ? (
        <span data-testid="onboarding-error" className="text-red-700">
          {error}
        </span>
      ) : null}
    </form>
  );
}
