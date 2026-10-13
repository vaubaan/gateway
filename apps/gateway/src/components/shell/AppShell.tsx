/**
 * Shell of the v5 human surface (spec §4.2): one bar with the cardinal pages
 * and the account, then the page. Server component. A feature adds its page
 * by appending one entry to `APP_NAV`.
 */
import Link from 'next/link';

import { OperatorBadge, SignOutButton } from '@/components/auth/PrincipalCard';
import styles from '@/components/auth/auth.module.css';
import { Container } from '@/components/ui';
import type { Principal } from '@/server/auth';

export interface AppNavEntry {
  readonly href: string;
  readonly label: string;
}

export const APP_NAV: readonly AppNavEntry[] = [{ href: '/connections', label: 'Connections' }];

export function AppShell({
  principal,
  children,
}: {
  principal: Principal;
  children: React.ReactNode;
}) {
  const who = principal.kind === 'user' ? principal.user.email : 'bootstrap token';
  const operator = principal.kind === 'bootstrap' || principal.isOperator;
  return (
    <div className={styles.adminShell}>
      <header className={styles.adminBar}>
        <nav className={styles.adminNav} aria-label="Main">
          <Link href="/connections" className={styles.brand}>
            Vaubaan
          </Link>
          {APP_NAV.map((entry) => (
            <Link key={entry.href} href={entry.href}>
              {entry.label}
            </Link>
          ))}
          {operator && <Link href="/admin">Administration</Link>}
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
