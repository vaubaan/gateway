'use client';

import { useState } from 'react';
import { getSupabaseBrowser } from '@/lib/supabase/client';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus('sending');
    setError(null);
    try {
      const supabase = getSupabaseBrowser();
      const { error: err } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
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
      <p style={{ opacity: 0.7 }}>Enter your email — we&apos;ll send you a magic link.</p>
      <form onSubmit={onSubmit} style={{ maxWidth: 320, display: 'grid', gap: 12 }}>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          style={{
            padding: 10,
            borderRadius: 6,
            background: '#1a1a1a',
            color: '#fff',
            border: '1px solid #2a2a2a',
          }}
        />
        <button
          type="submit"
          disabled={status === 'sending'}
          style={{
            padding: '10px 14px',
            background: '#fff',
            color: '#000',
            border: 0,
            borderRadius: 6,
          }}
        >
          {status === 'sending' ? 'Sending…' : 'Send magic link'}
        </button>
        {status === 'sent' && (
          <p style={{ color: '#7ee87e' }}>
            Magic link sent to <code>{email}</code>. Check your inbox.
          </p>
        )}
        {status === 'error' && <p style={{ color: '#ff7e7e' }}>{error}</p>}
      </form>
    </main>
  );
}
