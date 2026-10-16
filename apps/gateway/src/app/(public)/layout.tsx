/**
 * Layout of the pages reachable without a session (`/login`). The page draws
 * its own frame (`AuthPage`: the brand, the column, the build line), because
 * it names the gateway and only the page knows it.
 */
import { instanceMetadata } from '@/lib/instance';

export const dynamic = 'force-dynamic';

/** The sign-in tab carries the instance's name too (spec §4.2). */
export const generateMetadata = instanceMetadata;

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return children;
}
