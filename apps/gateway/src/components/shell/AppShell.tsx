/**
 * The shell of the human surface (spec §4.2): a short side navigation, then
 * a bar above the page with the path, then the page. Server component.
 *
 * The side navigation holds seven entries and nothing else — it is
 * navigation, not a status panel: Now, Waiting for you (with its count),
 * Missions, Accounts, Activity, Reference, then Settings after a rule. In a
 * narrow window it collapses to its icons. The bar (`PathBar`, see
 * docs/handbook/web-app.md) says where the page is — this
 * gateway, the section, the page's crumbs and title — and holds, at its end,
 * the theme toggle and the person (their name, and behind it "Sign out").
 *
 * Settings and Administration are the same shell (`AdminShell`): the global
 * navigation stays, Settings is the current entry, and the pages of Settings
 * are listed under it in the side column while the path is in Settings
 * (`SettingsSideNav`). When the column collapses to its icons, or on a phone,
 * the same list is drawn above the page instead (`SettingsFrame`).
 *
 * The words come from `lib/vocabulary`; a feature adds no entry here — seven
 * is the budget.
 */
import { RecoveryBanner } from './RecoveryBanner';
import { ServiceWorkerRegistration } from '@/components/notifications/ServiceWorkerRegistration';
import Link from 'next/link';

import { isOperatorPrincipal } from '@/components/auth/principal';
import {
  Button,
  DocsProvider,
  StatusMark,
  SubNav,
  SubNavFrame,
  ToastProvider,
  TraceMark,
  TrailProvider,
} from '@/components/ui';
import { currentTheme } from '@/lib/theme-server';
import { ACTIONS, NAV, NAV_ORDER, PRODUCT, ROLE_WORDS, type NavKey } from '@/lib/vocabulary';
import type { Principal } from '@/server/auth';
import type { InstanceIdentity } from '@/server/instance';

import { BuildFooter } from './BuildFooter';
import { brandTooltip } from './instance-label';
import { NavLinks, type NavItem } from './NavLinks';
import { OpenRequestCount } from './OpenRequestCount';
import { PathBar } from './PathBar';
import { settingsNav } from './settings-nav';
import { SettingsSideNav } from './SettingsSideNav';
import { ThemeToggle } from './ThemeToggle';
import { UserMenu } from './UserMenu';
import styles from './shell.styles';

/** The count an entry carries (a server component; renders nothing at zero). */
const COUNTS: Readonly<
  Partial<
    Record<NavKey, (props: { principal: Principal }) => React.ReactNode | Promise<React.ReactNode>>
  >
> = {
  waiting: OpenRequestCount,
};

/** Who is signed in, as the end of the bar says it. */
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
  docsRoot,
  children,
}: {
  principal: Principal;
  /**
   * Which gateway this is, under the brand: its name, or the host of its public
   * address when it has none; the host stays in the tooltip.
   */
  instance: InstanceIdentity;
  /** Where the (i) of each page leads: the instance's `docs.url`. */
  docsRoot: string;
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
      <DocsProvider root={docsRoot}>
        <TrailProvider>
          <div className={styles.app}>
            <a href="#main" className={styles.skip}>
              Skip to the page
            </a>
            <aside className={styles.side}>
              <Link href={NAV.now.href} className={styles.brand} title={brandTooltip(instance)}>
                <span className={styles.brandMark} aria-hidden="true">
                  <TraceMark className="size-full" />
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
              {/* Under Settings, the last entry, while the path is in Settings. */}
              <SettingsSideNav groups={settingsNav(isOperatorPrincipal(principal))} />
            </aside>
            <div className={styles.main}>
              <PathBar instance={{ label: instance.label, host: instance.host }}>
                <ThemeToggle initial={theme} />
                <UserMenu name={person.name} detail={person.detail}>
                  <RoleMark principal={principal} />
                  <SignOutButton />
                </UserMenu>
              </PathBar>
              <main id="main" className={styles.page} tabIndex={-1}>
                <RecoveryBanner />
                {children}
              </main>
              <ServiceWorkerRegistration />
              <BuildFooter />
            </div>
          </div>
        </TrailProvider>
      </DocsProvider>
    </ToastProvider>
  );
}

/**
 * The local navigation of Settings above the page — "You", then "Administration" — for a
 * window whose side column has no room for it (collapsed to icons, or a phone). In a wide
 * window it is not drawn: `SettingsSideNav` lists the same pages under the Settings entry.
 */
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
        <div className={styles.settingsAbove}>
          <SubNav label={NAV.settings.label} groups={settingsNav(isOperatorPrincipal(principal))} />
        </div>
      }
    >
      {children}
    </SubNavFrame>
  );
}

/**
 * Administration: the same shell and the same global navigation, with the
 * local navigation of Settings under its entry (or above the page when narrow).
 */
export function AdminShell({
  principal,
  instance,
  docsRoot,
  children,
}: {
  principal: Principal;
  instance: InstanceIdentity;
  docsRoot: string;
  children: React.ReactNode;
}) {
  return (
    <AppShell principal={principal} instance={instance} docsRoot={docsRoot}>
      <SettingsFrame principal={principal}>{children}</SettingsFrame>
    </AppShell>
  );
}
