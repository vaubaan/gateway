import { notFound, redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';
import { RoleEditClient } from './client';

export const dynamic = 'force-dynamic';

interface RoleRow {
  id: string;
  organization_id: string | null;
  provider: 'github' | 'vercel' | 'supabase';
  name: string;
  description: string | null;
  is_builtin: boolean;
  permissions: { version: 1; rules: Record<string, unknown>[] };
}

export default async function EditRolePage({
  params,
}: {
  params: Promise<{ slug: string; roleId: string }>;
}) {
  const { slug, roleId } = await params;
  const supabase = await getSupabaseServer();
  const { data: user } = await supabase.auth.getUser();
  if (!user.user) redirect('/login');

  const { data: org } = await supabase
    .from('organizations')
    .select('id, slug')
    .eq('slug', slug)
    .maybeSingle<{ id: string; slug: string }>();
  if (!org) notFound();

  const { data: row } = await supabase
    .from('roles')
    .select('*')
    .eq('id', roleId)
    .maybeSingle<RoleRow>();
  if (!row) notFound();
  if (row.is_builtin || row.organization_id !== org.id) notFound();

  return <RoleEditClient orgSlug={org.slug} role={row} />;
}
