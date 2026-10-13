/**
 * Layout of the pages reachable without a session (`/login`): the page, centred.
 */
import { Container } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return <Container>{children}</Container>;
}
