'use client';

/**
 * The path, on the left of the bar above the page (see
 * docs/handbook/web-app.md): this gateway (its mark and its
 * name, leading home), the section the page is in, then what the page
 * declared in its header — its crumbs and its title — the last one strong and
 * not a link. Two neighbours that say the same thing are said once: the home
 * reads "<gateway> › Now", a mission "<gateway> › Missions › <name>".
 *
 * The section comes from the route (`sectionOf`), the rest from the page
 * (`useTrail`): before hydration the path is the gateway and the section.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Icon, textOf, useTrail, type TrailItem } from '@/components/ui';
import { NAV } from '@/lib/vocabulary';

import { sectionOf } from './nav';
import styles from './shell.module.css';

export function PathBar({
  instance,
  children,
}: {
  /** The name of this gateway, or the host of its public address. */
  instance: { readonly label: string; readonly host: string };
  /** The end of the bar: the theme and the person, rendered by the server shell. */
  children?: React.ReactNode;
}) {
  const pathname = usePathname() ?? '';
  const section = sectionOf(pathname);
  const trail = useTrail();
  const items: TrailItem[] = [
    {
      label: (
        <>
          <span className={styles.pathMark} aria-hidden="true">
            {instance.label.slice(0, 1).toUpperCase()}
          </span>
          {instance.label}
        </>
      ),
      href: NAV.now.href,
    },
    ...(section ? [{ label: NAV[section].label, href: NAV[section].href }] : []),
    ...trail,
  ];
  const path = items.filter(
    (item, index) => index === 0 || textOf(item.label) !== textOf(items[index - 1]?.label),
  );

  return (
    <div className={styles.bar} data-testid="path-bar">
      <nav className={styles.path} aria-label="Path">
        <ol className={styles.pathList}>
          {path.map((item, index) => {
            const last = index === path.length - 1;
            return (
              <li key={index} className={styles.pathItem}>
                {index > 0 && <Icon name="chevron" size={12} className={styles.pathSep} />}
                {last || !item.href ? (
                  <span className={styles.pathCurrent} aria-current={last ? 'page' : undefined}>
                    {item.label}
                  </span>
                ) : (
                  <Link href={item.href} className={styles.pathLink}>
                    {item.label}
                  </Link>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
      <div className={styles.barEnd}>{children}</div>
    </div>
  );
}
