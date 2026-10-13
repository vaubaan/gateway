/**
 * Shell of the administration (spec §4.2): whoever installs the gateway while
 * the install token is valid, otherwise a person matching the administrator
 * rule. No session → the sign-in that applies; a signed-in person who does not
 * administer → an explanation, with no navigation.
 *
 * This layout is navigation and explanation, NOT the authorization boundary:
 * the App Router can render a page segment without it. Every page below
 * calls `requireOperator()` itself, and every route handler authorizes in
 * its handler.
 */
import Link from 'next/link';

import { AdminShell } from '@/components/shell/AppShell';
import { BuildFooter } from '@/components/shell/BuildFooter';
import { Callout, Container } from '@/components/ui';
import { adminDecision } from '@/lib/auth/session';
import { adminSignInPage } from '@/server/auth';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { root, decision } = await adminDecision();
  if (!decision.ok && decision.status === 401) redirect(await adminSignInPage(root.auth));
  if (!decision.ok) {
    return (
      <>
        <Container>
          <h1>Administration</h1>
          <Callout
            tone="warn"
            title="You do not administer this gateway"
            testId="not-administrator"
          >
            You are signed in, but you do not match its administrator rule (
            {describeRule(root.config.admin.group, root.config.admin.emails.length)}). Ask an
            administrator, or <Link href="/">go back to the application</Link>.
          </Callout>
        </Container>
        <BuildFooter />
      </>
    );
  }
  return (
    <AdminShell principal={decision.principal} instance={root.config.publicUrl.host}>
      {children}
    </AdminShell>
  );
}

function describeRule(group: string | null, emailCount: number): string {
  const parts: string[] = [];
  if (group) parts.push(`the identity-provider group "${group}"`);
  if (emailCount > 0) parts.push(`${emailCount} listed ${emailCount === 1 ? 'email' : 'emails'}`);
  return parts.join(' or ');
}
