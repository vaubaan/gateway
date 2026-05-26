import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';
import { generateState } from '@/lib/oauth/state';

export const dynamic = 'force-dynamic';

export default async function ConnectGitHubPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const supabase = await getSupabaseServer();
  const { data: user } = await supabase.auth.getUser();
  if (!user.user) redirect('/login');

  const { data: org } = await supabase
    .from('organizations')
    .select('id, slug')
    .eq('slug', slug)
    .maybeSingle<{ id: string; slug: string }>();
  if (!org) redirect('/dashboard');
  const o = org;

  const appSlug = process.env.GITHUB_APP_SLUG ?? 'vaubaan-gateway';
  const state = generateState(o.id);

  // Stash the state cookie so the callback can verify (5-min single-use).
  const { cookies } = await import('next/headers');
  const cookieStore = await cookies();
  cookieStore.set('vbn_oauth_state', state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 300,
    path: '/',
  });

  const installUrl = new URL(`https://github.com/apps/${appSlug}/installations/new`);
  installUrl.searchParams.set('state', state);
  redirect(installUrl.toString());
}
