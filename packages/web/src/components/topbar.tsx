import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase/server';

export async function TopBar() {
  let email: string | null = null;
  try {
    const supabase = await getSupabaseServer();
    const { data } = await supabase.auth.getUser();
    email = data.user?.email ?? null;
  } catch {
    email = null;
  }
  return (
    <header className="vbn-topbar">
      <Link href="/" className="vbn-brand">
        Vauban
      </Link>
      <nav>
        {email ? (
          <>
            <Link href="/dashboard">Dashboard</Link>
            <span style={{ color: 'var(--text-subtle)' }}>{email}</span>
          </>
        ) : (
          <Link href="/login">Sign in</Link>
        )}
      </nav>
    </header>
  );
}
