/**
 * The local navigation of Settings: what is the person's own, then — for an
 * administrator — the gateway of the company. Pure; `SettingsFrame` renders
 * it, and a unit test pins that every entry leads to a page that exists.
 *
 * Until the settings pages are redesigned the entries lead to the pages that
 * exist today (`/settings/**`, `/admin/**`), under the words of the redesign:
 * no label is used for two things (the audit found "Connections" twice).
 * The accounts without owner are not an entry: they are the last region of
 * Accounts, for an administrator (docs/handbook/web-app.md).
 */
import type { SubNavGroup } from '@/components/ui';
import { capitalize, ROUTES, SECTIONS, SETTINGS_PAGES, TERMS } from '@/lib/vocabulary';

export const ADMIN_PAGES = {
  setup: '/admin',
  signIn: '/admin/identity-provider',
  people: '/admin/users',
  teams: '/admin/groups',
  telemetry: '/admin/telemetry',
  encryption: '/admin/encryption',
  plugins: '/admin/plugins',
} as const;

export function settingsNav(administrator: boolean): SubNavGroup[] {
  const groups: SubNavGroup[] = [
    {
      label: 'You',
      items: [
        { label: 'Preferences', href: ROUTES.settings, exact: true },
        { label: SECTIONS.notifications, href: ROUTES.notifications },
      ],
    },
  ];
  if (administrator) {
    groups.push({
      label: 'Administration',
      items: [
        // In the order an administrator sets a gateway up.
        { label: SECTIONS.setup, href: ADMIN_PAGES.setup, exact: true },
        { label: 'Sign-in', href: ADMIN_PAGES.signIn },
        { label: capitalize(TERMS.user.many), href: ADMIN_PAGES.people },
        { label: capitalize(TERMS.group.many), href: ADMIN_PAGES.teams },
        { label: 'Telemetry', href: ADMIN_PAGES.telemetry },
        { label: 'Encryption', href: ADMIN_PAGES.encryption },
        { label: SETTINGS_PAGES.plugins.title, href: ADMIN_PAGES.plugins },
      ],
    });
  }
  return groups;
}
