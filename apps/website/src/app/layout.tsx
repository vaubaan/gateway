import type { Metadata } from 'next';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import type { ReactNode } from 'react';

import { SiteFooter, SiteHeader } from '@/components/Shell';
import { SITE_DESCRIPTION, SITE_NAME, SITE_ORIGIN } from '@/site/constants';

import '@vaubaan/plugin-page/plugin-page.css';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_ORIGIN),
  title: { default: SITE_NAME, template: `%s · ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
  alternates: { types: { 'text/plain': '/llms.txt' } },
};

/**
 * Geist and Geist Mono come from the `geist` package through next/font: the
 * files are served by this site, nothing is fetched from a third party. No
 * `data-theme`: the site follows the system preference, without script.
 */
export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        <a
          className="absolute -left-[9999px] rounded-md bg-background px-3 py-2 focus:left-4 focus:top-4 focus:z-50"
          href="#main"
        >
          Skip to the content
        </a>
        <SiteHeader />
        <main id="main">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
