/**
 * Shell of the v5 human surface (spec §4.2): one bar, on one line, with the
 * cardinal pages — the current one marked — and the account in a compact
 * menu, then the page, then the build footer. Server component. A feature
 * adds its page by appending one entry to `APP_NAV`.
 */
import Link from 'next/link';

import { OperatorBadge, SignOutButton } from '@/components/auth/PrincipalCard';
import { isOperatorPrincipal } from '@/components/auth/principal';
import { Container } from '@/components/ui';
import type { Principal } from '@/server/auth';
import { PROVIDERS_PATH } from '@/server/providers/links';

import { BuildFooter } from './BuildFooter';
import { NavLinks, type NavItem } from './NavLinks';
import { OpenRequestCount } from './OpenRequestCount';
import { UserMenu } from './UserMenu';
import styles from './shell.module.css';

export interface AppNavEntry {
  readonly href: string;
  /** One short word: the bar holds on one line at 1280 px with one more entry to come. */
  readonly label: string;
  /** A count shown after the label (a server component; renders nothing at zero). */
  readonly Count?: (props: { principal: Principal }) => React.ReactNode | Promise<React.ReactNode>;
}

export const APP_NAV: readonly AppNavEntry[] = [
  { href: '/connections', label: 'Connections' },
  // The page is "Shares received"; the bar says it in one word.
  { href: '/shares', label: 'Shares' },
  { href: '/missions', label: 'Missions' },
  { href: '/requests', label: 'Requests', Count: OpenRequestCount },
  { href: '/audit', label: 'Audit' },
  { href: '/delegations', label: 'Delegations' },
  // The reference of the shipped plugins: documentation, so it comes last.
  { href: PROVIDERS_PATH, label: 'Providers' },
];

/** Operators only: the administration pages have a bar of their own. */
const ADMIN_ENTRY: AppNavEntry = { href: '/admin', label: 'Admin' };

export function AppShell({
  principal,
  children,
}: {
  principal: Principal;
  children: React.ReactNode;
}) {
  const who = principal.kind === 'user' ? principal.user.email : 'bootstrap token';
  const entries = isOperatorPrincipal(principal) ? [...APP_NAV, ADMIN_ENTRY] : APP_NAV;
  const items: NavItem[] = entries.map((entry) => ({
    href: entry.href,
    label: entry.label,
    count: entry.Count ? <entry.Count principal={principal} /> : undefined,
  }));
  return (
    <div className={styles.shell}>
      <header className={styles.bar}>
        <nav className={styles.nav} aria-label="Main">
          <Link href="/connections" className={styles.brand}>
            Vaubaan
          </Link>
          <NavLinks items={items} />
        </nav>
        <UserMenu name={who}>
          <OperatorBadge principal={principal} />
          <SignOutButton />
        </UserMenu>
      </header>
      <Container>{children}</Container>
      <BuildFooter />
    </div>
  );
}
