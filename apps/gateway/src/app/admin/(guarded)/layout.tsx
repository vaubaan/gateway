/**
 * Shell of the Administration surface (spec §4.2): the bootstrap operator
 * while the token is active, otherwise a user matching the admin rule. No
 * session → the sign-in that applies; a signed-in non-operator → 403 page.
 *
 * This layout is navigation and explanation, NOT the authorization boundary:
 * the App Router can render a page segment without it. Every page below
 * calls `requireOperator()` itself, and every route handler authorizes in
 * its handler.
 */
import Link from 'next/link';

import { OperatorBadge, SignOutButton } from '@/components/auth/PrincipalCard';
import styles from '@/components/auth/auth.module.css';
import { Banner, Container } from '@/components/ui';
import { adminDecision } from '@/lib/auth/session';
import { adminSignInPage } from '@/server/auth';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { root, decision } = await adminDecision();
  if (!decision.ok && decision.status === 401) redirect(await adminSignInPage(root.auth));
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
          <Link href="/admin/provider-apps">Provider apps</Link>
          <Link href="/admin/groups">Groups</Link>
          <Link href="/admin/connections">Connections</Link>
          <Link href="/admin/telemetry">Telemetry</Link>
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
