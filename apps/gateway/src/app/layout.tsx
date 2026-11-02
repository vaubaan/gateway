import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';

import { themeAttribute } from '@/lib/theme';
import { currentTheme } from '@/lib/theme-server';

import './globals.css';

export const metadata: Metadata = {
  title: 'Vaubaan Gateway',
  description:
    'Self-hosted MCP gateway: agents call provider tools with a mission token; every call is checked against the accepted risks and budget of the mission, executed with a credential that stays on the instance, and audited.',
  // Added to the Home Screen of an iPhone or iPad, the interface opens as an app: the
  // only way Safari lets it receive notifications (handbook notifications).
  appleWebApp: { capable: true, statusBarStyle: 'default' },
};

/**
 * The theme is written on `<html>` by the server, from the cookie the toggle
 * keeps (`lib/theme.ts`): the first paint is in the right theme, with no
 * inline script. No attribute means "follow the system".
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const theme = themeAttribute(await currentTheme());
  return (
    <html lang="en" data-theme={theme} className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
