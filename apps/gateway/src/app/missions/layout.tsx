/**
 * Guard and shell of the Missions pages (spec §4.2): behind the IdP, for an
 * identified user. No session → sign in and come back; the bootstrap
 * operator → a mission always has a human behind it, so they are told to
 * sign in through the identity provider.
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { OperatorBadge, SignOutButton } from '@/components/auth/PrincipalCard';
import shell from '@/components/auth/auth.module.css';
import { Banner, Container } from '@/components/ui';
import { currentPrincipal } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

const SIGN_IN = '/auth/login?return_to=/missions';

export default async function MissionsLayout({ children }: { children: React.ReactNode }) {
  const { principal } = await currentPrincipal();
  if (!principal) redirect(SIGN_IN);
  const who = principal.kind === 'user' ? principal.user.email : 'bootstrap token';
  return (
    <div className={shell.adminShell}>
      <header className={shell.adminBar}>
        <nav className={shell.adminNav}>
          <Link href="/missions" className={shell.brand}>
            Vaubaan · Missions
          </Link>
          <Link href="/missions/new">New mission</Link>
          <Link href="/connections">Connections</Link>
        </nav>
        <div className={shell.actions}>
          <span className={shell.muted}>{who}</span>
          <OperatorBadge principal={principal} />
          <SignOutButton />
        </div>
      </header>
      <Container className="vbn-page-wide">
        {principal.kind === 'user' ? (
          children
        ) : (
          <Banner tone="warning" title="Sign in through the identity provider">
            A mission is issued by an identified user: the bootstrap token configures the instance,
            it does not issue missions. Finish the identity provider under{' '}
            <Link href="/admin/identity-provider">Administration</Link>, then sign in.
          </Banner>
        )}
      </Container>
    </div>
  );
}
