'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { getSupabaseBrowser } from '@/lib/supabase/client';
import styles from './Sidebar.module.css';
import {
  IconActivity,
  IconBook,
  IconBuilding,
  IconChevronDown,
  IconExternal,
  IconFolder,
  IconHome,
  IconLifeBuoy,
  IconLogout,
  IconMoon,
  IconPlug,
  IconShield,
  IconSun,
  IconUsers,
} from './icons';

export interface SidebarOrg {
  id: string;
  slug: string;
  name: string;
}

export interface SidebarProps {
  email: string | null;
  orgs: SidebarOrg[];
}

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
  match?: (pathname: string) => boolean;
  external?: boolean;
}

function isActive(pathname: string, item: NavItem): boolean {
  if (item.match) return item.match(pathname);
  if (item.href === '/dashboard') return pathname === '/dashboard';
  return pathname === item.href || pathname.startsWith(item.href + '/');
}

export function Sidebar({ email, orgs }: SidebarProps) {
  const pathname = usePathname() ?? '';
  const router = useRouter();
  const orgSlugMatch = pathname.match(/^\/orgs\/([^/]+)/);
  const currentOrgSlug = orgSlugMatch ? orgSlugMatch[1] : null;
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    const stored = (typeof window !== 'undefined' && window.localStorage.getItem('vbn-theme')) as
      | 'light'
      | 'dark'
      | null;
    if (stored) {
      document.documentElement.setAttribute('data-theme', stored);
      setTheme(stored);
    } else {
      const current = document.documentElement.getAttribute('data-theme');
      setTheme(current === 'dark' ? 'dark' : 'light');
    }
  }, []);

  const toggleTheme = useCallback(() => {
    const next = theme === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    window.localStorage.setItem('vbn-theme', next);
    setTheme(next);
  }, [theme]);

  const signOut = useCallback(async () => {
    const supabase = getSupabaseBrowser();
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  }, [router]);

  const currentOrg = orgs.find((o) => o.slug === currentOrgSlug) ?? orgs[0] ?? null;
  const orgBase = currentOrg ? `/orgs/${currentOrg.slug}` : null;

  const generalNav: NavItem[] = [
    {
      href: '/dashboard',
      label: 'Organizations',
      icon: <IconHome />,
      match: (p) => p === '/dashboard',
    },
  ];

  const orgNav: NavItem[] = orgBase
    ? [
        {
          href: orgBase,
          label: 'Overview',
          icon: <IconBuilding />,
          match: (p) =>
            p === orgBase ||
            (p.startsWith(orgBase) &&
              !p.startsWith(`${orgBase}/providers`) &&
              !p.startsWith(`${orgBase}/projects`) &&
              !p.startsWith(`${orgBase}/roles`) &&
              !p.startsWith(`${orgBase}/members`) &&
              !p.startsWith(`${orgBase}/audit`)),
        },
        { href: `${orgBase}/providers/github/connect`, label: 'Providers', icon: <IconPlug /> },
        {
          href: `${orgBase}/projects`,
          label: 'Projects',
          icon: <IconFolder />,
          match: (p) => p.startsWith(`${orgBase}/projects`),
        },
        { href: `${orgBase}/roles`, label: 'Roles', icon: <IconShield /> },
        { href: `${orgBase}/members`, label: 'Members', icon: <IconUsers /> },
        { href: `${orgBase}/audit`, label: 'Audit log', icon: <IconActivity /> },
      ]
    : [];

  const initials = email ? email.slice(0, 2).toUpperCase() : '··';

  return (
    <aside className={styles.aside} aria-label="Primary navigation">
      <Link href="/dashboard" className={styles.brand}>
        <span className={styles.brandMark}>V</span>
        <span className={styles.brandName}>Vaubaan</span>
      </Link>

      {currentOrg ? (
        <button
          type="button"
          className={styles.orgSwitcher}
          onClick={() => router.push('/dashboard')}
        >
          <div className={styles.orgSwitcherText}>
            <span className={styles.orgSwitcherLabel}>Organization</span>
            <span className={styles.orgSwitcherName}>{currentOrg.name}</span>
          </div>
          <IconChevronDown className={styles.chev} />
        </button>
      ) : null}

      <nav className={styles.nav}>
        <div className={styles.section}>
          <span className={styles.sectionLabel}>General</span>
          {generalNav.map((item) => (
            <NavLink key={item.href} item={item} active={isActive(pathname, item)} />
          ))}
        </div>

        {orgNav.length > 0 && (
          <div className={styles.section}>
            <span className={styles.sectionLabel}>{currentOrg?.name ?? 'Organization'}</span>
            {orgNav.map((item) => (
              <NavLink key={item.href} item={item} active={isActive(pathname, item)} />
            ))}
          </div>
        )}

        <div className={styles.section}>
          <span className={styles.sectionLabel}>Resources</span>
          <NavLink
            item={{
              href: 'https://github.com/sbw-vaubaan/mcp-proxy',
              label: 'Documentation',
              icon: <IconBook />,
              external: true,
            }}
            active={false}
          />
          <NavLink
            item={{
              href: '/support',
              label: 'Support',
              icon: <IconLifeBuoy />,
            }}
            active={pathname === '/support'}
          />
        </div>
      </nav>

      <div className={styles.footer}>
        <div className={styles.userRow}>
          <span className={styles.avatar}>{initials}</span>
          <div className={styles.userMeta}>
            <span className={styles.userEmail}>{email ?? 'Not signed in'}</span>
            <span className={styles.userHint}>Signed in</span>
          </div>
        </div>
        <div className={styles.footerActions}>
          <div className={styles.footerLinks}>
            <button
              type="button"
              className={styles.iconBtn}
              onClick={toggleTheme}
              aria-label="Toggle theme"
              title={theme === 'light' ? 'Switch to dark' : 'Switch to light'}
            >
              {theme === 'light' ? <IconMoon /> : <IconSun />}
            </button>
          </div>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={signOut}
            aria-label="Sign out"
            title="Sign out"
          >
            <IconLogout />
          </button>
        </div>
      </div>
    </aside>
  );
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const cls = active ? `${styles.item} ${styles.itemActive}` : styles.item;
  if (item.external) {
    return (
      <a className={cls} href={item.href} target="_blank" rel="noreferrer noopener">
        <span className={styles.itemIcon}>{item.icon}</span>
        <span>{item.label}</span>
        <IconExternal style={{ marginLeft: 'auto', color: 'var(--text-subtle)' }} />
      </a>
    );
  }
  return (
    <Link href={item.href} className={cls} aria-current={active ? 'page' : undefined}>
      <span className={styles.itemIcon}>{item.icon}</span>
      <span>{item.label}</span>
    </Link>
  );
}
