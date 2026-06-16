import { notFound, redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';
import { ManagementKeysPanel } from './management-keys-panel';

export const dynamic = 'force-dynamic';

interface ManagementKeyRow {
  id: string;
  name: string;
  api_key_prefix: string;
  status: 'active' | 'revoked';
  last_used_at: string | null;
  created_at: string;
}

export default async function ManagementKeysPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const supabase = await getSupabaseServer();
  const { data: user } = await supabase.auth.getUser();
  if (!user.user) redirect('/login');

  const { data: org } = await supabase
    .from('organizations')
    .select('id, slug, name')
    .eq('slug', slug)
    .maybeSingle<{ id: string; slug: string; name: string }>();
  if (!org) notFound();

  // Org-scoped root tokens live in the unified `tokens` table (scope='org'
  // AND parent_id IS NULL ; cf. unified-tokens ADR).
  const { data: keys } = await supabase
    .from('tokens')
    .select('id, name, api_key_prefix, status, last_used_at, created_at')
    .eq('organization_id', org.id)
    .eq('scope', 'org')
    .is('parent_id', null)
    .order('created_at', { ascending: false })
    .returns<ManagementKeyRow[]>();

  return <ManagementKeysPanel org={org} initialKeys={keys ?? []} />;
}
