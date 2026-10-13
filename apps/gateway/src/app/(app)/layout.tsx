/**
 * Layout of the human surface (spec §4.2): a web session of the instance
 * (OIDC or bootstrap token) gets the shell; anyone else signs in.
 */
import { redirect } from 'next/navigation';

import { AppShell } from '@/components/shell/AppShell';
import { currentPrincipal } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { principal } = await currentPrincipal();
  if (!principal) redirect('/login');
  return <AppShell principal={principal}>{children}</AppShell>;
}
