import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';
import { Sidebar, type SidebarOrg } from '@/components/sidebar/Sidebar';
import styles from '@/components/sidebar/Sidebar.module.css';

export const dynamic = 'force-dynamic';

interface OrgMemberRow {
  organization: { id: string; slug: string; name: string };
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await getSupabaseServer();
  const { data: userRes } = await supabase.auth.getUser();
  if (!userRes.user) redirect('/login');

  const { data: rows } = await supabase
    .from('org_members')
    .select('organization:organizations(id, slug, name)')
    .order('added_at');

  const orgs: SidebarOrg[] = ((rows ?? []) as unknown as OrgMemberRow[])
    .map((r) => r.organization)
    .filter(Boolean);

  return (
    <div className={styles.shell}>
      <Sidebar email={userRes.user.email ?? null} orgs={orgs} />
      <div className={styles.main}>
        <div className={styles.mainInner}>{children}</div>
      </div>
    </div>
  );
}
