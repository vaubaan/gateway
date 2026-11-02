/**
 * Notifications are part of Settings: the page keeps its content and gets the local
 * navigation of Settings beside it. A layout is navigation, never the authorization
 * boundary: the page authenticates itself.
 */
import { redirect } from 'next/navigation';

import { SettingsFrame } from '@/components/shell/AppShell';
import { currentPrincipal } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export default async function NotificationsLayout({ children }: { children: React.ReactNode }) {
  const { principal } = await currentPrincipal();
  if (!principal) redirect('/login');
  return <SettingsFrame principal={principal}>{children}</SettingsFrame>;
}
