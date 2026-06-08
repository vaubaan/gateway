'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { getSupabaseBrowser } from '@/lib/supabase/client';
import styles from './Sidebar.module.css';
import {
  IconActivity,
  IconBook,
  IconChevronDown,
  IconCloud,
  IconExternal,
  IconFolder,
  IconHome,
  IconKey,
  IconLifeBuoy,
  IconLogout,
  IconMoon,
  IconSettings,
  IconSun,
  IconUsers,
} from './icons';

export interface SidebarOrg {
  id: string;
  slug: string;
  name: string;
}

export interface SidebarProject {
  id: string;
  slug: string;
  name: string;
}

export interface SidebarProps {
  email: string | null;
  orgs: SidebarOrg[];
  projectsByOrg: Record<string, SidebarProject[]>;
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

export function Sidebar({ email, orgs, projectsByOrg }: SidebarProps) {
  const pathname = usePathname() ?? '';
  const router = useRouter();
  const orgSlugMatch = pathname.match(/^\/orgs\/([^/]+)/);
  const currentOrgSlug = orgSlugMatch ? orgSlugMatch[1] : null;
  const projSlugMatch = pathname.match(/^\/orgs\/[^/]+\/projects\/([^/]+)/);
  const currentProjSlug = projSlugMatch ? projSlugMatch[1] : null;
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

  const currentOrg = orgs.find((o) => o.slug === currentOrgSlug) ?? null;
  const projects = currentOrg ? (projectsByOrg[currentOrg.id] ?? []) : [];
  const currentProj = projects.find((p) => p.slug === currentProjSlug) ?? null;

  // If the URL points at a project that the cached layout payload doesn't know
  // about (e.g. just-created project in another tab, or stale router cache),
  // force a server fetch so the picker dropdown picks it up.
  useEffect(() => {
    if (currentProjSlug && currentOrg && !currentProj) {
      router.refresh();
    }
  }, [currentProjSlug, currentOrg, currentProj, router]);

  const orgBase = currentOrg ? `/orgs/${currentOrg.slug}` : null;
  const projBase = orgBase && currentProj ? `${orgBase}/projects/${currentProj.slug}` : null;

  const onOrgChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const slug = e.target.value;
      if (!slug) router.push('/dashboard');
      else router.push(`/orgs/${slug}`);
    },
    [router],
  );

  const onProjectChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const slug = e.target.value;
      if (!orgBase) return;
      if (!slug) router.push(orgBase);
      else router.push(`${orgBase}/projects/${slug}`);
    },
    [router, orgBase],
  );

  const initials = email ? email.slice(0, 2).toUpperCase() : '··';

  const orgNav: NavItem[] = orgBase
    ? [
        {
          href: orgBase,
          label: 'Projects',
          icon: <IconFolder />,
          // The org root is now the Projects index. Stays active for /orgs/X
          // itself, /orgs/X/projects/new, and any /orgs/X/projects/<project>
          // tree that isn't yet matched by a specific project section.
          match: (p) =>
            p === orgBase ||
            p === `${orgBase}/projects/new` ||
            (p.startsWith(`${orgBase}/projects/`) && currentProjSlug === null),
        },
        { href: `${orgBase}/providers`, label: 'Cloud providers', icon: <IconCloud /> },
        { href: `${orgBase}/members`, label: 'Members', icon: <IconUsers /> },
        { href: `${orgBase}/audit`, label: 'Audit log', icon: <IconActivity /> },
        { href: `${orgBase}/settings`, label: 'Settings', icon: <IconSettings /> },
      ]
    : [];

  const projNav: NavItem[] = projBase
    ? [
        {
          href: projBase,
          label: 'Overview',
          icon: <IconFolder />,
          match: (p) => p === projBase || p === `${projBase}/`,
        },
        { href: `${projBase}/audit`, label: 'Audit log', icon: <IconActivity /> },
        { href: `${projBase}/tokens`, label: 'Access tokens', icon: <IconKey /> },
      ]
    : [];

  return (
    <aside className={styles.aside} aria-label="Primary navigation">
      <Link href="/dashboard" className={styles.brand}>
        <span className={styles.brandMark}>V</span>
        <span className={styles.brandName}>Vaubaan</span>
      </Link>

      <nav className={styles.nav}>
        <div className={styles.section}>
          <span className={styles.sectionLabel}>General</span>
          <NavLink
            item={{
              href: '/dashboard',
              label: 'Organizations',
              icon: <IconHome />,
              match: (p) => p === '/dashboard',
            }}
            active={pathname === '/dashboard'}
          />
        </div>

        <div className={styles.section}>
          <HeadSelect
            value={currentOrg?.slug ?? ''}
            onChange={onOrgChange}
            placeholder="— pick an org —"
            ariaLabel="Switch organization"
            options={orgs.map((o) => ({ value: o.slug, label: o.name }))}
          />
          {currentOrg &&
            orgNav.map((item) => (
              <NavLink key={item.href} item={item} active={isActive(pathname, item)} />
            ))}
        </div>

        {currentOrg && (
          <div className={styles.section}>
            <HeadSelect
              value={currentProj?.slug ?? ''}
              onChange={onProjectChange}
              placeholder="— pick a project —"
              ariaLabel="Switch project"
              options={projects.map((p) => ({ value: p.slug, label: p.name }))}
            />
            {currentProj &&
              projNav.map((item) => (
                <NavLink key={item.href} item={item} active={isActive(pathname, item)} />
              ))}
          </div>
        )}

        <div className={styles.section}>
          <span className={styles.sectionLabel}>Resources</span>
          <NavLink
            item={{
              href: '/docs',
              label: 'Documentation',
              icon: <IconBook />,
              match: (p) => p === '/docs' || p.startsWith('/docs/'),
            }}
            active={pathname === '/docs' || pathname.startsWith('/docs/')}
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
        <BuildStamp />
      </div>
    </aside>
  );
}

function BuildStamp() {
  const sha = process.env.NEXT_PUBLIC_COMMIT_SHA;
  const builtAt = process.env.NEXT_PUBLIC_BUILD_TIME;
  if (!sha && !builtAt) return null;
  const built = builtAt
    ? new Date(builtAt).toLocaleString(undefined, {
        year: '2-digit',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;
  return (
    <div className={styles.buildStamp} title={builtAt ?? ''}>
      {sha ? <code>{sha}</code> : null}
      {sha && built ? <span aria-hidden> · </span> : null}
      {built ? <span>{built}</span> : null}
    </div>
  );
}

function HeadSelect({
  value,
  onChange,
  placeholder,
  ariaLabel,
  options,
}: {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  placeholder: string;
  ariaLabel: string;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div className={styles.headSelect}>
      <select
        className={styles.headSelectInput}
        value={value}
        onChange={onChange}
        aria-label={ariaLabel}
      >
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <IconChevronDown className={styles.headSelectChev} />
    </div>
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
