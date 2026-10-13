/**
 * Layout of the pages reachable without a session (`/login`). The page draws
 * its own frame (`AuthPage`: the brand, the column, the build line), because
 * it names the gateway and only the page knows it.
 */
export const dynamic = 'force-dynamic';

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return children;
}
