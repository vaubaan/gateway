/**
 * The header and footer of every page: the Trace lockup, four destinations,
 * and what the reader should know about the project in one line each.
 */
import Link from 'next/link';

import { Lockup } from '@/components/Lockup';
import { GITHUB_REPO, LICENSE_NAME } from '@/site/constants';

const NAV_LINK =
  'rounded-md px-2 py-1 text-sm text-muted-foreground no-underline transition-colors hover:bg-accent hover:text-foreground';

export function SiteHeader() {
  return (
    <header className="border-b border-border">
      <div className="mx-auto flex max-w-page flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 md:px-6">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-foreground no-underline hover:text-foreground"
          prefetch={false}
        >
          <Lockup className="h-7 w-auto" />
          <span className="sr-only">Vaubaan Gateway</span>
        </Link>
        <nav className="-mx-2 flex flex-wrap gap-x-1 sm:ml-auto" aria-label="Main">
          <Link href="/docs" className={NAV_LINK} prefetch={false}>
            Docs
          </Link>
          <Link href="/plugins" className={NAV_LINK} prefetch={false}>
            Plugins
          </Link>
          <Link href="/trust" className={NAV_LINK} prefetch={false}>
            Trust
          </Link>
          <a href={GITHUB_REPO} className={NAV_LINK}>
            GitHub
          </a>
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-border text-sm text-muted-foreground">
      <div className="mx-auto flex max-w-page flex-col gap-2 px-4 pb-10 pt-8 md:px-6">
        <Lockup className="mb-2 h-5 w-auto self-start text-foreground" />
        <p>
          Vaubaan Gateway is open source under the {LICENSE_NAME} licence. Pre-release: the 2.0.0
          pre-releases are published, 2.0.0 itself is not yet.
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
