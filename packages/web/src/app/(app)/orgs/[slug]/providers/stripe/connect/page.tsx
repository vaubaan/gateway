import { notFound, redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';
import { StripeConnectForm } from './stripe-connect-form';

export const dynamic = 'force-dynamic';

export default async function StripeConnectPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const supabase = await getSupabaseServer();
  const { data: user } = await supabase.auth.getUser();
  if (!user.user) redirect('/login');

  const { data: org } = await supabase
    .from('organizations')
    .select('id, name, slug')
    .eq('slug', slug)
    .maybeSingle<{ id: string; name: string; slug: string }>();
  if (!org) notFound();

  return (
    <main style={{ maxWidth: 540 }}>
      <h1 style={{ marginBottom: 'var(--space-2)' }}>Connect Stripe</h1>
      <p style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-6)' }}>
        Paste a Stripe API key for <strong>{org.name}</strong>. Use a{' '}
        <a
          href="https://dashboard.stripe.com/apikeys"
          target="_blank"
          rel="noreferrer noopener"
          style={{ color: 'var(--accent-fg)' }}
        >
          restricted key
        </a>{' '}
        with the minimum permissions your workflows need. Vaubaan stores the key encrypted and never
        exposes it.
      </p>
      <StripeConnectForm orgSlug={org.slug} />
    </main>
  );
}
