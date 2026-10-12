'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { getSupabaseBrowser } from '@/lib/supabase/client';
import { Button, Field, Input } from '@/components/ui';
import styles from './page.module.css';

type Mode = 'signin' | 'signup';
type Status = 'idle' | 'submitting' | 'sent' | 'error';

function GithubMark() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 .5C5.6.5.5 5.7.5 12.1c0 5.1 3.3 9.5 7.9 11 .6.1.8-.2.8-.6v-2c-3.2.7-3.9-1.4-3.9-1.4-.5-1.3-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.6-.3-5.3-1.3-5.3-5.8 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2.9-.3 1.9-.4 2.9-.4s2 .1 2.9.4c2.2-1.5 3.3-1.2 3.3-1.2.6 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.1 0 4.5-2.7 5.5-5.3 5.8.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6 4.6-1.5 7.9-5.9 7.9-11C23.5 5.7 18.4.5 12 .5Z" />
    </svg>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const search = useSearchParams();
  const initialMode = search?.get('mode') === 'signup' ? 'signup' : 'signin';
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [oauthBusy, setOauthBusy] = useState(false);

  function reset() {
    setStatus('idle');
    setError(null);
  }

  async function onGithub() {
    setOauthBusy(true);
    setError(null);
    try {
      const supabase = getSupabaseBrowser();
      const { error: err } = await supabase.auth.signInWithOAuth({
        provider: 'github',
        options: {
          redirectTo: `${window.location.origin}/auth/callback?next=/dashboard`,
        },
      });
      if (err) throw err;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setOauthBusy(false);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus('submitting');
    setError(null);
    try {
      const supabase = getSupabaseBrowser();
      if (mode === 'signin') {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password });
        if (err) throw err;
        router.push('/dashboard');
        router.refresh();
        return;
      }
      const { data, error: err } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback?next=/dashboard`,
        },
      });
      if (err) throw err;
      if (data.session) {
        router.push('/dashboard');
        router.refresh();
        return;
      }
      setStatus('sent');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }

  const isSignup = mode === 'signup';

  return (
    <div className={styles.wrap}>
      <h1 className={styles.title}>{isSignup ? 'Create your account' : 'Welcome back'}</h1>
      <p className={styles.lead}>
        {isSignup
          ? 'One Vaubaan account. Connect your providers afterward.'
          : 'Sign in to your Vaubaan dashboard.'}
      </p>

      <div role="tablist" aria-label="Authentication mode" className={styles.tabs}>
        <button
          type="button"
          role="tab"
          aria-selected={!isSignup}
          className={!isSignup ? `${styles.tab} ${styles.tabActive}` : styles.tab}
          onClick={() => {
            setMode('signin');
            reset();
          }}
        >
          Sign in
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={isSignup}
          className={isSignup ? `${styles.tab} ${styles.tabActive}` : styles.tab}
          onClick={() => {
            setMode('signup');
            reset();
          }}
        >
          Sign up
        </button>
      </div>

      <div className={styles.card}>
        <button
          type="button"
          className={styles.providerBtn}
          onClick={onGithub}
          disabled={oauthBusy}
        >
          <GithubMark />
          <span>
            {oauthBusy ? 'Redirecting…' : isSignup ? 'Sign up with GitHub' : 'Continue with GitHub'}
          </span>
        </button>

        <div className={styles.divider}>
          <span>or with email</span>
        </div>

        <form onSubmit={onSubmit} className={styles.form}>
          <Field label="Email">
            <Input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </Field>
          <Field label="Password">
            <Input
              type="password"
              required
              minLength={isSignup ? 8 : undefined}
              autoComplete={isSignup ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={isSignup ? 'At least 8 characters' : '••••••••'}
            />
          </Field>

          <Button type="submit" variant="primary" loading={status === 'submitting'}>
            {status === 'submitting'
              ? isSignup
                ? 'Creating account…'
                : 'Signing in…'
              : isSignup
                ? 'Create account'
                : 'Sign in'}
          </Button>

          {status === 'sent' && (
            <p className={styles.statusSuccess}>
              Check <code>{email}</code> to confirm your account. The link returns you here.
            </p>
          )}
          {status === 'error' && error && <p className={styles.statusError}>{error}</p>}
        </form>
      </div>

      <p className={styles.swapline}>
        {isSignup ? (
          <>
            Already have an account?{' '}
            <button
              type="button"
              className={styles.swaplink}
              onClick={() => {
                setMode('signin');
                reset();
              }}
            >
              Sign in
            </button>
          </>
        ) : (
          <>
            New to Vaubaan?{' '}
            <button
              type="button"
              className={styles.swaplink}
              onClick={() => {
                setMode('signup');
                reset();
              }}
            >
              Create an account
            </button>
          </>
        )}
      </p>

      {isSignup && (
        <p className={styles.fineprint}>
          By creating an account you agree to our <Link href="/terms">Terms</Link> and{' '}
          <Link href="/privacy">Privacy policy</Link>.
        </p>
      )}
    </div>
  );
}
