import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';
import { Sidebar, type SidebarOrg, type SidebarProject } from '@/components/sidebar/Sidebar';
import styles from '@/components/sidebar/Sidebar.module.css';

export const dynamic = 'force-dynamic';

interface OrgMemberRow {
  organization: { id: string; slug: string; name: string };
}

interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  organization_id: string;
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await getSupabaseServer();
  const { data: userRes } = await supabase.auth.getUser();
  if (!userRes.user) redirect('/login');

  const { data: rows } = await supabase
    .from('org_members')
    .select('organization:organizations(id, slug, name)')
    .eq('user_id', userRes.user.id)
    .order('added_at');

  const orgs: SidebarOrg[] = ((rows ?? []) as unknown as OrgMemberRow[])
    .map((r) => r.organization)
    .filter(Boolean);

  // Fetch every project the user can see across all their orgs. RLS gates by
  // org membership, so this returns only legitimate rows. The sidebar groups
  // them per-org on the client side based on the URL.
  const orgIds = orgs.map((o) => o.id);
  let projectRows: ProjectRow[] = [];
  if (orgIds.length > 0) {
    const { data } = await supabase
      .from('projects')
      .select('id, slug, name, organization_id')
      .in('organization_id', orgIds)
      .order('created_at', { ascending: false });
    projectRows = data ?? [];
  }
  const projectsByOrgId = new Map<string, SidebarProject[]>();
  for (const p of projectRows) {
    const list = projectsByOrgId.get(p.organization_id) ?? [];
    list.push({ id: p.id, slug: p.slug, name: p.name });
    projectsByOrgId.set(p.organization_id, list);
  }
  const projectsByOrg: Record<string, SidebarProject[]> = {};
  for (const o of orgs) {
    projectsByOrg[o.id] = projectsByOrgId.get(o.id) ?? [];
  }

  return (
    <div className={styles.shell}>
      <Sidebar email={userRes.user.email ?? null} orgs={orgs} projectsByOrg={projectsByOrg} />
      <div className={styles.main}>
        <div className={styles.mainInner}>{children}</div>
      </div>
    </div>
  );
}
