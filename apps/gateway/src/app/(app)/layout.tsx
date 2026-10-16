/**
 * Layout of the human surface (spec §4.2): a web session of the instance
 * (OIDC or bootstrap token) gets the shell; anyone else signs in.
 */
import { redirect } from 'next/navigation';

import { AppShell } from '@/components/shell/AppShell';
import { currentPrincipal } from '@/lib/auth/session';
import { instanceMetadata } from '@/lib/instance';

export const dynamic = 'force-dynamic';

/** Every tab of the human surface carries the instance's name (spec §4.2). */
export const generateMetadata = instanceMetadata;

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { root, principal } = await currentPrincipal();
  if (!principal) redirect('/login');
  return (
    <AppShell principal={principal} instance={await root.instance.name.identity()}>
      {children}
    </AppShell>
  );
}
