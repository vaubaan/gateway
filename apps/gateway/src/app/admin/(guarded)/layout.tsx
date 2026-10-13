/**
 * Guard of the Administration surface (spec §4.2): the bootstrap operator
 * while the token is active, otherwise a user matching the admin rule. No
 * session → the sign-in that applies; a signed-in non-operator → 403 page.
 */
import Link from 'next/link';

import { OperatorBadge, SignOutButton } from '@/components/auth/PrincipalCard';
import styles from '@/components/auth/auth.module.css';
import { Banner, Container } from '@/components/ui';
import { adminDecision } from '@/lib/auth/session';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { root, decision } = await adminDecision();
  if (!decision.ok && decision.status === 401) {
    const bootstrap = await root.auth.bootstrap.state();
    const idp = await root.auth.idp.current();
    redirect(bootstrap.status === 'active' && !idp ? '/admin/bootstrap' : '/login');
  }
  if (!decision.ok) {
    return (
      <Container>
        <h1>Administration</h1>
        <Banner tone="warning" title="Not an operator">
          You are signed in, but you do not match the admin rule of this instance (
          {describeRule(root.config.admin.group, root.config.admin.emails.length)}). Ask an
          operator, or <Link href="/login">return to your account</Link>.
        </Banner>
      </Container>
    );
  }
  const { principal } = decision;
  const who = principal.kind === 'user' ? principal.user.email : 'bootstrap token';
  return (
    <div className={styles.adminShell}>
      <header className={styles.adminBar}>
        <nav className={styles.adminNav}>
          <Link href="/admin" className={styles.brand}>
            Vaubaan · Administration
          </Link>
          <Link href="/admin/identity-provider">Identity provider</Link>
        </nav>
        <div className={styles.actions}>
          <span className={styles.muted}>{who}</span>
          <OperatorBadge principal={principal} />
          <SignOutButton />
        </div>
      </header>
      <Container>{children}</Container>
    </div>
  );
}

function describeRule(group: string | null, emailCount: number): string {
  const parts: string[] = [];
  if (group) parts.push(`IdP group "${group}"`);
  if (emailCount > 0) parts.push(`${emailCount} listed email(s)`);
  return parts.join(' or ');
}
