'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabaseBrowser } from '@/lib/supabase/client';
import { Button, Card, CardBody, CardHeader, CardTitle, Field, Input } from '@/components/ui';

type Mode = 'password' | 'magic';
type Status = 'idle' | 'sending' | 'sent' | 'error';

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus('sending');
    setError(null);
    try {
      const supabase = getSupabaseBrowser();
      if (mode === 'password') {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password });
        if (err) throw err;
        router.push('/dashboard');
        return;
      }
      const { error: err } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
      });
      if (err) throw err;
      setStatus('sent');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }

  return (
    <main style={{ maxWidth: 420, marginTop: 'var(--space-12)' }}>
      <h1>Sign in</h1>
      <Card>
        <CardHeader>
          <div role="tablist" style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'password'}
              onClick={() => {
                setMode('password');
                setStatus('idle');
                setError(null);
              }}
              style={tabStyle(mode === 'password')}
            >
              Password
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'magic'}
              onClick={() => {
                setMode('magic');
                setStatus('idle');
                setError(null);
              }}
              style={tabStyle(mode === 'magic')}
            >
              Magic link
            </button>
          </div>
          <CardTitle>{mode === 'password' ? 'Email + password' : 'Magic link'}</CardTitle>
        </CardHeader>
        <CardBody>
          <form
            onSubmit={onSubmit}
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}
          >
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
            {mode === 'password' && (
              <Field label="Password">
                <Input
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                />
              </Field>
            )}
            <Button type="submit" variant="primary" loading={status === 'sending'}>
              {status === 'sending'
                ? mode === 'password'
                  ? 'Signing in…'
                  : 'Sending…'
                : mode === 'password'
                  ? 'Sign in'
                  : 'Send magic link'}
            </Button>
            {status === 'sent' && mode === 'magic' && (
              <p style={{ color: 'var(--accent-success-fg)', margin: 0 }}>
                Magic link sent to <code>{email}</code>. Check your inbox.
              </p>
            )}
            {status === 'error' && (
              <p style={{ color: 'var(--accent-danger-fg)', margin: 0 }}>{error}</p>
            )}
          </form>
        </CardBody>
      </Card>
    </main>
  );
}

function tabStyle(active: boolean): React.CSSProperties {
  return {
    padding: '4px 10px',
    background: active ? 'var(--primary-bg)' : 'transparent',
    color: active ? 'var(--primary-fg)' : 'var(--text-muted)',
    border: '1px solid ' + (active ? 'var(--primary-bg)' : 'var(--border-subtle)'),
    borderRadius: 'var(--radius-sm)',
    fontSize: 'var(--text-xs)',
    cursor: 'pointer',
  };
}
