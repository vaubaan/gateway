/**
 * Shell of the v5 human surface (spec §4.2): one bar, on one line, with the
 * cardinal pages — the current one marked — and the account in a compact
 * menu, then the page, then the build footer. Server component. A feature
 * adds its page by appending one entry to `APP_NAV`.
 *
 * Administration is the same shell with its own entries (`AdminShell`): one
 * bar, one account menu and one footer for the whole product.
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

/** Operators only: the administration pages have entries of their own. */
const ADMIN_ENTRY: AppNavEntry = { href: '/admin', label: 'Admin' };

/** The pages of Administration, in the order an operator sets an instance up. */
export const ADMIN_NAV: readonly AppNavEntry[] = [
  { href: '/admin/identity-provider', label: 'Identity provider' },
  { href: '/admin/provider-apps', label: 'Provider apps' },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/groups', label: 'Groups' },
  { href: '/admin/connections', label: 'Connections' },
  { href: '/admin/telemetry', label: 'Telemetry' },
  { href: '/admin/oauth-clients', label: 'OAuth clients' },
];

/** The application's home, where the brand leads a signed-in user. */
const APP_HOME = '/connections';
const ADMIN_HOME = '/admin';

function Shell({
  principal,
  brandHref,
  section,
  items,
  children,
}: {
  principal: Principal;
  brandHref: string;
  /** Names the surface after the brand when it is not the application itself. */
  section?: NavItem;
  items: readonly NavItem[];
  children: React.ReactNode;
}) {
  const who = principal.kind === 'user' ? principal.user.email : 'bootstrap token';
  return (
    <div className={styles.shell}>
      <header className={styles.bar}>
        <nav className={styles.nav} aria-label={section ? section.label : 'Main'}>
          <Link href={brandHref} className={styles.brand}>
            Vaubaan
          </Link>
          <NavLinks items={section ? [section, ...items] : items} />
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

export function AppShell({
  principal,
  children,
}: {
  principal: Principal;
  children: React.ReactNode;
}) {
  const entries = isOperatorPrincipal(principal) ? [...APP_NAV, ADMIN_ENTRY] : APP_NAV;
  const items: NavItem[] = entries.map((entry) => ({
    href: entry.href,
    label: entry.label,
    count: entry.Count ? <entry.Count principal={principal} /> : undefined,
  }));
  return (
    <Shell principal={principal} brandHref={APP_HOME} items={items}>
      {children}
    </Shell>
  );
}

/**
 * Administration: the same bar. The brand leads back to the application for a
 * user; the bootstrap operator has no application to go to and stays here.
 */
export function AdminShell({
  principal,
  children,
}: {
  principal: Principal;
  children: React.ReactNode;
}) {
  return (
    <Shell
      principal={principal}
      brandHref={principal.kind === 'user' ? APP_HOME : ADMIN_HOME}
      section={{ href: ADMIN_HOME, label: 'Administration', exact: true }}
      items={ADMIN_NAV.map((entry) => ({ href: entry.href, label: entry.label }))}
    >
      {children}
    </Shell>
  );
}
