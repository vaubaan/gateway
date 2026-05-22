/**
 * Public sign-up page. Uses `supabase.auth.signUp`.
 *
 * If Supabase email confirmation is OFF, the session is established
 * immediately; otherwise the user receives a confirmation email and
 * lands back on this page after clicking the link.
 */

'use client';

import { useState } from 'react';

import { Button, Input } from '@/components/ui';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

export const dynamic = 'force-dynamic';

interface AuthClient {
  auth: {
    signUp(input: { email: string; password: string }): Promise<{
      data: { session: { access_token: string } | null };
      error: { message: string } | null;
    }>;
  };
}

export default function SignUpPage(): React.ReactElement {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (password.length < 8) {
      setError('password_too_short');
      return;
    }
    if (password !== confirm) {
      setError('passwords_do_not_match');
      return;
    }
    setBusy(true);
    try {
      const supabase = createSupabaseBrowserClient() as unknown as AuthClient;
      const { data, error: signUpErr } = await supabase.auth.signUp({ email, password });
      if (signUpErr) {
        setError(signUpErr.message);
        return;
      }
      setPassword('');
      setConfirm('');
      if (data.session) {
        // Email confirmation disabled or auto-confirmed → straight to
        // onboarding (IdentityGate will prompt the keypair bootstrap).
        window.location.href = '/onboarding';
      } else {
        setNotice('Check your email to confirm your account, then sign in.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'sign_up_failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex max-w-sm flex-col gap-4 p-8" data-testid="sign-up-page">
      <h1 className="text-xl font-semibold">Create a Cloud Resource Manager account</h1>
      <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span>Email</span>
          <Input
            type="email"
            required
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
            }}
            autoComplete="email"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span>Password (min 8 chars)</span>
          <Input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
            autoComplete="new-password"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span>Confirm password</span>
          <Input
            type="password"
            required
            minLength={8}
            value={confirm}
            onChange={(e) => {
              setConfirm(e.target.value);
            }}
            autoComplete="new-password"
          />
        </label>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          loading={busy}
          disabled={busy}
          className="self-start"
        >
          {busy ? 'Creating…' : 'Sign up'}
        </Button>
        {error ? (
          <span data-testid="sign-up-error" className="text-danger-foreground">
            {error}
          </span>
        ) : null}
        {notice ? (
          <span data-testid="sign-up-notice" className="text-success-foreground">
            {notice}
          </span>
        ) : null}
      </form>
      <a href="/sign-in" className="text-xs text-info-foreground underline">
        Already have an account? Sign in
      </a>
    </main>
  );
}
