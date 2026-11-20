/**
 * The header and footer of every page (website spec §2.1 bis): the Trace
 * lockup, five destinations and one button, "Try it"; the foot holds the long
 * tail in four groups and one line on what the project is and collects.
 */
import Link from 'next/link';

import { Lockup } from '@/components/Lockup';
import { buttonVariants } from '@/components/ui/button';
import { GITHUB_REPO, githubBlob, LICENSE_NAME } from '@/site/constants';

const NAV_LINK =
  'rounded-md px-2 py-1 text-sm text-muted-foreground no-underline transition-colors hover:bg-accent hover:text-foreground';

/** The top navigation: each entry answers one reader's first question. */
export const NAV: readonly { readonly label: string; readonly href: string }[] = [
  { label: 'How it works', href: '/how-it-works' },
  { label: 'Services', href: '/plugins' },
  { label: 'Teams', href: '/teams' },
  { label: 'Security', href: '/trust' },
  { label: 'Docs', href: '/docs' },
];

function GitHubMark() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor">
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.8 1.19 1.83 1.19 3.09 0 4.42-2.7 5.39-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}

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
        <div className="ml-auto flex items-center gap-2 lg:order-last lg:ml-0">
          <a
            href={GITHUB_REPO}
            className={`${NAV_LINK} inline-flex items-center`}
            aria-label="Source on GitHub"
          >
            <GitHubMark />
          </a>
          <Link href="/try" className={buttonVariants({ size: 'md' })} prefetch={false}>
            Try it
          </Link>
        </div>
        <nav
          className="-mx-2 flex w-full flex-wrap gap-x-1 lg:mx-0 lg:ml-auto lg:w-auto"
          aria-label="Main"
        >
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className={NAV_LINK} prefetch={false}>
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}

interface FootLink {
  readonly label: string;
  readonly href: string;
}

/** The long tail, in four groups (product, docs, trust, build). */
export const FOOTER: readonly { readonly title: string; readonly links: readonly FootLink[] }[] = [
  {
    title: 'Product',
    links: [
      { label: 'How it works', href: '/how-it-works' },
      { label: 'Try it', href: '/try' },
      { label: 'Teams', href: '/teams' },
      { label: 'For consultants', href: '/consultants' },
      { label: 'Services', href: '/plugins' },
      { label: 'Plugin health', href: '/plugins/health' },
      { label: 'Compare', href: '/docs/compare' },
    ],
  },
  {
    title: 'Docs',
    links: [
      { label: 'Concepts', href: '/docs/concepts' },
      { label: 'Install', href: '/docs/install' },
      { label: 'Install with your agent', href: '/docs/install-with-your-coding-agent' },
      { label: 'Known limitations', href: '/docs/known-limitations' },
      { label: 'Roadmap', href: githubBlob('ROADMAP.md') },
      { label: 'Changelog', href: githubBlob('CHANGELOG.md') },
    ],
  },
  {
    title: 'Trust',
    links: [
      { label: 'Trust center', href: '/trust' },
      { label: 'Threat model', href: githubBlob('docs/handbook/threat-model.md') },
      { label: 'Report a vulnerability', href: githubBlob('SECURITY.md') },
      { label: 'What leaves an instance', href: '/trust#what-leaves-an-instance' },
      { label: 'Privacy', href: '/privacy' },
      { label: 'Licence', href: githubBlob('LICENSE') },
    ],
  },
  {
    title: 'Build',
    links: [
      { label: 'Write a plugin', href: '/write-a-plugin' },
      { label: 'Contributing', href: githubBlob('CONTRIBUTING.md') },
      { label: 'GitHub', href: GITHUB_REPO },
      { label: 'llms.txt', href: '/llms.txt' },
      { label: 'plugins.json', href: '/plugins.json' },
      { label: 'versions.json', href: '/versions.json' },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-border text-sm text-muted-foreground">
      <div className="mx-auto max-w-page px-4 pb-10 pt-8 md:px-6">
        <Lockup className="mb-6 h-5 w-auto text-foreground" />
        <div className="grid grid-cols-2 gap-x-6 gap-y-8 md:grid-cols-4">
          {FOOTER.map((group) => (
            <div key={group.title}>
              <h2 className="text-sm font-semibold text-foreground">{group.title}</h2>
              <ul className="mt-3 space-y-1.5">
                {group.links.map((link) => (
                  <li key={link.label}>
                    {/^https?:/.test(link.href) || /\.(txt|json)$/.test(link.href) ? (
                      <a href={link.href} className="text-muted-foreground hover:text-foreground">
                        {link.label}
                      </a>
                    ) : (
                      <Link
                        href={link.href}
                        className="text-muted-foreground hover:text-foreground"
                        prefetch={false}
                      >
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className="mt-8 border-t border-border pt-6">
          Pre-release · {LICENSE_NAME} · no cookie, no tracker: this site sets no cookie and runs no
          analytics or third-party script.
        </p>
      </div>
    </footer>
  );
}
