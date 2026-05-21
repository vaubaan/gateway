/**
 * Public sign-in page. Uses `supabase.auth.signInWithPassword`.
 *
 * Phase 4 wave C — minimal email/password flow. The signup flow lives
 * at `/sign-up`; this page only handles existing users. Both pages are
 * unauthenticated (no IdentityGate, no protected layout).
 */

'use client';

import { useState } from 'react';

import { createSupabaseBrowserClient } from '@/lib/supabase/client';

export const dynamic = 'force-dynamic';

interface AuthClient {
  auth: {
    signInWithPassword(input: { email: string; password: string }): Promise<{
      error: { message: string } | null;
    }>;
  };
}

export default function SignInPage(): React.ReactElement {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const supabase = createSupabaseBrowserClient() as unknown as AuthClient;
      const { error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
      if (signInErr) {
        setError(signInErr.message);
        return;
      }
      // Wipe password from state before navigation (defense-in-depth —
      // the string is immutable but we drop the React reference).
      setPassword('');
      // The IdentityGate on /onboarding handles routing post-auth.
      window.location.href = '/onboarding';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'sign_in_failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex max-w-sm flex-col gap-4 p-8" data-testid="sign-in-page">
      <h1 className="text-xl font-semibold">Sign in to Cloud Resource Manager</h1>
      <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span>Email</span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
            }}
            autoComplete="email"
            className="rounded border border-neutral-300 px-2 py-1"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span>Password</span>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
            autoComplete="current-password"
            className="rounded border border-neutral-300 px-2 py-1"
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="self-start rounded bg-neutral-900 px-3 py-1 text-white disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {error ? (
          <span data-testid="sign-in-error" className="text-red-700">
            {error}
          </span>
        ) : null}
      </form>
      <a href="/sign-up" className="text-xs text-blue-700 underline">
        Need an account? Sign up
      </a>
    </main>
  );
}
