/**
 * Top-level nav rendered on every org-scoped page. Server component:
 * the `<SignOutButton>` it embeds is the only client island.
 *
 * The slug comes from the parent layout (orgs/[slug]/layout.tsx), so
 * the nav is always pre-bound to the user's current org. Multi-org
 * users will get an org switcher in a later UX iteration.
 */

import Link from 'next/link';

import { SignOutButton } from '@/components/identity/SignOutButton';

interface Props {
  readonly orgSlug: string;
}

export function TopNav({ orgSlug }: Props) {
  const base = `/orgs/${orgSlug}`;
  return (
    <nav className="border-b border-border-default bg-background/80 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center gap-6 px-4 py-3">
        <Link
          href={`${base}/resources`}
          className="text-sm font-semibold tracking-tight text-foreground"
        >
          Cloud Resource Manager
        </Link>
        <div className="flex gap-4 text-sm text-muted">
          <Link href={`${base}/resources`} className="hover:text-foreground">
            Resources
          </Link>
          <Link href={`${base}/secret-managers`} className="hover:text-foreground">
            Secret managers
          </Link>
          <Link href={`${base}/exports`} className="hover:text-foreground">
            Exports
          </Link>
        </div>
        <div className="ml-auto flex items-center gap-3 text-xs text-muted">
          <span className="hidden sm:inline">
            org: <span className="font-mono text-foreground">{orgSlug}</span>
          </span>
          <SignOutButton />
        </div>
      </div>
    </nav>
  );
}
