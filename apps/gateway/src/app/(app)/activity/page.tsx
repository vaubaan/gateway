/**
 * `/activity` — the Record for now (a later Overview takes this address). The
 * query is kept: an older link to `/activity?mission=…`, or to `/audit?…`,
 * opens the same filters on the Record.
 */
import { redirect } from 'next/navigation';

import { requirePrincipal } from '@/lib/auth/session';
import { ROUTES } from '@/lib/vocabulary';

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ActivityPage({ searchParams }: Props) {
  // Like every page of the surface: no session, no address of the record.
  await requirePrincipal();
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(await searchParams)) {
    const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
    for (const one of values) params.append(name, one);
  }
  const query = params.toString();
  redirect(`${ROUTES.activityRecord}${query ? `?${query}` : ''}`);
}
