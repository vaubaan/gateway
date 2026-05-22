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
    <nav className="border-b border-neutral-800 bg-neutral-950/80 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center gap-6 px-4 py-3">
        <Link href={`${base}/resources`} className="font-semibold tracking-tight text-neutral-100">
          Cloud Resource Manager
        </Link>
        <div className="flex gap-4 text-sm text-neutral-300">
          <Link href={`${base}/resources`} className="hover:text-white">
            Resources
          </Link>
          <Link href={`${base}/secret-managers`} className="hover:text-white">
            Secret managers
          </Link>
          <Link href={`${base}/exports`} className="hover:text-white">
            Exports
          </Link>
        </div>
        <div className="ml-auto flex items-center gap-3 text-sm text-neutral-400">
          <span className="hidden sm:inline">org: {orgSlug}</span>
          <SignOutButton />
        </div>
      </div>
    </nav>
  );
}
