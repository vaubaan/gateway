import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { getSupabaseServer, getSupabaseServiceClient } from '@/lib/supabase/server';
import { MembersClient } from './client';

export const dynamic = 'force-dynamic';

interface MemberRow {
  user_id: string;
  role: 'member' | 'admin';
  added_at: string;
  email: string;
}

export default async function MembersPage({ params }: { params: Promise<{ slug: string }> }) {
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

  const { data: meMember } = await supabase
    .from('org_members')
    .select('role')
    .eq('organization_id', org.id)
    .eq('user_id', user.user.id)
    .maybeSingle<{ role: 'member' | 'admin' }>();
  const isAdmin = meMember?.role === 'admin';

  const { data: rawMembers } = await supabase
    .from('org_members')
    .select('user_id, role, added_at')
    .eq('organization_id', org.id);

  // Hydrate emails server-side via service client (auth.users not RLS-readable).
  const svc = getSupabaseServiceClient();
  const { data: list } = await svc.auth.admin.listUsers();
  const emailById = new Map<string, string>();
  for (const u of (list.users ?? []) as Array<{ id: string; email?: string }>) {
    if (u.email) emailById.set(u.id, u.email);
  }
  const members: MemberRow[] = (
    (rawMembers ?? []) as Array<{
      user_id: string;
      role: 'member' | 'admin';
      added_at: string;
    }>
  ).map((m) => ({
    ...m,
    email: emailById.get(m.user_id) ?? '(unknown)',
  }));

  return (
    <main>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1>Members — {org.name}</h1>
        <Link href={`/orgs/${org.slug}`} style={{ opacity: 0.7 }}>
          ← back
        </Link>
      </header>
      <p style={{ opacity: 0.6 }}>
        2 roles humains : <strong>admin</strong> (RW) et <strong>member</strong> (R). La granularité
        fine vit dans la composition Roles × Bots des projects.
      </p>

      <MembersClient
        orgSlug={org.slug}
        members={members}
        currentUserId={user.user.id}
        isAdmin={isAdmin}
      />
    </main>
  );
}
