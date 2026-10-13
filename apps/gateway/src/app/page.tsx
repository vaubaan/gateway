/**
 * `/` — an on-prem instance has no landing page: a signed-in visitor goes to
 * their missions, anyone else to the sign-in page.
 */
import { redirect } from 'next/navigation';

import { currentPrincipal } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export default async function HomePage(): Promise<never> {
  const { principal } = await currentPrincipal();
  redirect(principal ? '/missions' : '/login');
}
