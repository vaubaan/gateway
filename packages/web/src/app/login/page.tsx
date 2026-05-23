'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabaseBrowser } from '@/lib/supabase/client';

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
    <main>
      <h1>Sign in</h1>

      <div role="tablist" style={{ display: 'flex', gap: 4, marginBottom: 16, maxWidth: 320 }}>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'password'}
          onClick={() => {
            setMode('password');
            setStatus('idle');
            setError(null);
          }}
          style={tab(mode === 'password')}
        >
          Email + password
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
          style={tab(mode === 'magic')}
        >
          Magic link
        </button>
      </div>

      {mode === 'magic' && (
        <p style={{ opacity: 0.7 }}>Enter your email — we&apos;ll send you a magic link.</p>
      )}

      <form onSubmit={onSubmit} style={{ maxWidth: 320, display: 'grid', gap: 12 }}>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
          style={field}
        />
        {mode === 'password' && (
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            autoComplete="current-password"
            style={field}
          />
        )}
        <button type="submit" disabled={status === 'sending'} style={submitBtn}>
          {status === 'sending'
            ? mode === 'password'
              ? 'Signing in…'
              : 'Sending…'
            : mode === 'password'
              ? 'Sign in'
              : 'Send magic link'}
        </button>
        {status === 'sent' && mode === 'magic' && (
          <p style={{ color: '#7ee87e' }}>
            Magic link sent to <code>{email}</code>. Check your inbox.
          </p>
        )}
        {status === 'error' && <p style={{ color: '#ff7e7e' }}>{error}</p>}
      </form>
    </main>
  );
}

function tab(active: boolean): React.CSSProperties {
  return {
    flex: 1,
    padding: '8px 12px',
    background: active ? '#fff' : 'transparent',
    color: active ? '#000' : '#fff',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    cursor: 'pointer',
  };
}

const field: React.CSSProperties = {
  padding: 10,
  borderRadius: 6,
  background: '#1a1a1a',
  color: '#fff',
  border: '1px solid #2a2a2a',
};

const submitBtn: React.CSSProperties = {
  padding: '10px 14px',
  background: '#fff',
  color: '#000',
  border: 0,
  borderRadius: 6,
};
