import { notFound, redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';
import { OrgSettings } from './org-settings';

export const dynamic = 'force-dynamic';

export default async function OrgSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const supabase = await getSupabaseServer();
  const { data: user } = await supabase.auth.getUser();
  if (!user.user) redirect('/login');

  const { data: org } = await supabase
    .from('organizations')
    .select('id, name, slug, owner_id')
    .eq('slug', slug)
    .maybeSingle<{ id: string; name: string; slug: string; owner_id: string }>();
  if (!org) notFound();

  const isOwner = org.owner_id === user.user.id;

  return <OrgSettings org={org} isOwner={isOwner} />;
}
