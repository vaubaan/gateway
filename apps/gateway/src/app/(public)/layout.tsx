/**
 * Layout of the pages reachable without a session (`/login`): the page, centred,
 * then the build footer (the same stamps `/healthz` gives anyone).
 */
import { BuildFooter } from '@/components/shell/BuildFooter';
import { Container } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Container>{children}</Container>
      <BuildFooter />
    </>
  );
}
