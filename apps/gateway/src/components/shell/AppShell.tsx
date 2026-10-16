/**
 * The shell of the human surface (spec §4.2): a short side navigation, then
 * the page. Server component.
 *
 * The side navigation holds seven entries and nothing else — it is
 * navigation, not a status panel: Now, Waiting for you (with its count),
 * Missions, Accounts, Activity, Reference, then Settings after a rule. At its
 * foot, the person (their name, and behind it "Sign out") and the theme
 * toggle. In a narrow window it collapses to its icons.
 *
 * Administration is the same shell (`AdminShell`): the global navigation
 * stays, Settings is the current entry, and the pages of Administration get
 * the local navigation of Settings beside them (`SettingsFrame`).
 *
 * The words come from `lib/vocabulary`; a feature adds no entry here — seven
 * is the budget.
 */
import Link from 'next/link';

import { isOperatorPrincipal } from '@/components/auth/principal';
import { Button, StatusMark, SubNav, SubNavFrame, ToastProvider } from '@/components/ui';
import { currentTheme } from '@/lib/theme-server';
import { ACTIONS, NAV, NAV_ORDER, PRODUCT, ROLE_WORDS, type NavKey } from '@/lib/vocabulary';
import type { Principal } from '@/server/auth';
import type { InstanceIdentity } from '@/server/instance';

import { BuildFooter } from './BuildFooter';
import { brandTooltip } from './instance-label';
import { NavLinks, type NavItem } from './NavLinks';
import { OpenRequestCount } from './OpenRequestCount';
import { settingsNav } from './settings-nav';
import { ThemeToggle } from './ThemeToggle';
import { UserMenu } from './UserMenu';
import styles from './shell.module.css';

/** The count an entry carries (a server component; renders nothing at zero). */
const COUNTS: Readonly<
  Partial<
    Record<NavKey, (props: { principal: Principal }) => React.ReactNode | Promise<React.ReactNode>>
  >
> = {
  waiting: OpenRequestCount,
};

/** Who is signed in, as the foot of the navigation says it. */
export function personOf(principal: Principal): { name: string; detail: string } {
  if (principal.kind !== 'user') return { name: 'Bootstrap token', detail: ROLE_WORDS.installer };
  const { displayName, email } = principal.user;
  return displayName ? { name: displayName, detail: email } : { name: email, detail: '' };
}

export function SignOutButton() {
  return (
    <form method="post" action="/logout" className={styles.signOut}>
      <Button type="submit" variant="secondary" size="sm">
        {ACTIONS.signOut}
      </Button>
    </form>
  );
}

/** What a person is here, when it is more than a person: an administrator. */
export function RoleMark({ principal }: { principal: Principal }) {
  if (principal.kind === 'bootstrap') {
    return <StatusMark tone="warn">{ROLE_WORDS.installer}</StatusMark>;
  }
  if (!principal.isOperator) return null;
  return (
    <StatusMark tone="neutral" dot={false}>
      {ROLE_WORDS.administrator}
    </StatusMark>
  );
}

export async function AppShell({
  principal,
  instance,
  children,
}: {
  principal: Principal;
  /**
   * Which gateway this is, under the brand: its name, or the host of its public
   * address when it has none; the host stays in the tooltip.
   */
  instance: InstanceIdentity;
  children: React.ReactNode;
}) {
  const theme = await currentTheme();
  const person = personOf(principal);
  const items: NavItem[] = NAV_ORDER.map((key) => {
    const Count = COUNTS[key];
    return {
      key,
      href: NAV[key].href,
      label: NAV[key].label,
      count: Count ? <Count principal={principal} /> : undefined,
      ruleBefore: key === 'settings',
    };
  });

  return (
    <ToastProvider>
      <div className={styles.app}>
        <a href="#main" className={styles.skip}>
          Skip to the page
        </a>
        <aside className={styles.side}>
          <Link href={NAV.now.href} className={styles.brand} title={brandTooltip(instance)}>
            <span className={styles.brandMark} aria-hidden="true">
              {PRODUCT.mark}
            </span>
            <span className={styles.brandText}>
              <span className={styles.brandName}>{PRODUCT.name}</span>
              <span className={styles.brandInstance} data-testid="instance-name">
                {instance.label}
              </span>
            </span>
          </Link>
          <nav className={styles.nav} aria-label="Main">
            <NavLinks items={items} />
          </nav>
          <div className={styles.foot}>
            <UserMenu name={person.name} detail={person.detail}>
              <RoleMark principal={principal} />
              <SignOutButton />
            </UserMenu>
            <ThemeToggle initial={theme} />
          </div>
        </aside>
        <div className={styles.main}>
          <main id="main" className={styles.page} tabIndex={-1}>
            {children}
          </main>
          <BuildFooter />
        </div>
      </div>
    </ToastProvider>
  );
}

/** The local navigation of Settings beside a page: "You", then "Administration". */
export function SettingsFrame({
  principal,
  children,
}: {
  principal: Principal;
  children: React.ReactNode;
}) {
  return (
    <SubNavFrame
      nav={
        <SubNav label={NAV.settings.label} groups={settingsNav(isOperatorPrincipal(principal))} />
      }
    >
      {children}
    </SubNavFrame>
  );
}

/**
 * Administration: the same shell and the same global navigation, with the
 * local navigation of Settings beside the page.
 */
export function AdminShell({
  principal,
  instance,
  children,
}: {
  principal: Principal;
  instance: InstanceIdentity;
  children: React.ReactNode;
}) {
  return (
    <AppShell principal={principal} instance={instance}>
      <SettingsFrame principal={principal}>{children}</SettingsFrame>
    </AppShell>
  );
}
