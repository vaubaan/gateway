'use client';

import { useActionState, useState } from 'react';
import { createOrg, type CreateOrgResult } from './actions';

export default function NewOrgPage() {
  const [state, formAction, pending] = useActionState<CreateOrgResult | null, FormData>(
    createOrg,
    null,
  );
  const [slug, setSlug] = useState('');

  return (
    <main>
      <h1>New organization</h1>
      <form action={formAction} style={{ display: 'grid', gap: 12, maxWidth: 420 }}>
        <label>
          <div style={{ opacity: 0.7, marginBottom: 4 }}>Name</div>
          <input
            name="name"
            required
            style={{
              width: '100%',
              padding: 10,
              background: '#1a1a1a',
              color: '#fff',
              border: '1px solid #2a2a2a',
              borderRadius: 6,
            }}
          />
        </label>
        <label>
          <div style={{ opacity: 0.7, marginBottom: 4 }}>Slug</div>
          <input
            name="slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
            pattern="^[a-z0-9](-?[a-z0-9])*$"
            required
            style={{
              width: '100%',
              padding: 10,
              background: '#1a1a1a',
              color: '#fff',
              border: '1px solid #2a2a2a',
              borderRadius: 6,
            }}
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          style={{
            padding: '10px 14px',
            background: '#fff',
            color: '#000',
            border: 0,
            borderRadius: 6,
          }}
        >
          {pending ? 'Creating…' : 'Create organization'}
        </button>
        {state?.error && <p style={{ color: '#ff7e7e' }}>{state.error}</p>}
      </form>
    </main>
  );
}
