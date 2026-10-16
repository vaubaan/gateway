/**
 * The header and footer of every page: the brand, four destinations, and
 * what the reader should know about the project in one line each.
 */
import Link from 'next/link';

import { GITHUB_REPO, LICENSE_NAME } from '@/site/constants';

export function Logo() {
  return (
    <svg viewBox="0 0 256 256" aria-hidden="true" focusable="false">
      <rect width="256" height="256" rx="56" fill="currentColor" />
      <path d="M56 64 L96 64 L128 168 L160 64 L200 64 L144 200 L112 200 Z" fill="var(--paper)" />
    </svg>
  );
}

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="site-header-inner">
        <Link href="/" className="brand" prefetch={false}>
          <Logo />
          Vaubaan Gateway
        </Link>
        <nav className="site-nav" aria-label="Main">
          <Link href="/docs" prefetch={false}>
            Docs
          </Link>
          <Link href="/plugins" prefetch={false}>
            Plugins
          </Link>
          <Link href="/trust" prefetch={false}>
            Trust
          </Link>
          <a href={GITHUB_REPO}>GitHub</a>
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <p>
          Vaubaan Gateway is open source under the {LICENSE_NAME} licence. Pre-release: no version
          is tagged yet.
        </p>
        <p>
          This site sets no cookie and runs no analytics or third-party script.{' '}
          <Link href="/trust" prefetch={false}>
            Trust center
          </Link>{' '}
          · <a href="/llms.txt">llms.txt</a> · <a href="/plugins.json">plugins.json</a> ·{' '}
          <a href={`${GITHUB_REPO}/blob/main/SECURITY.md`}>Report a vulnerability</a>
        </p>
      </div>
    </footer>
  );
}
