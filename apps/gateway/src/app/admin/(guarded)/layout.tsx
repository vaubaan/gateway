/**
 * Shell of the administration (spec §4.2): whoever installs the gateway while
 * the install token is valid, otherwise a person matching the administrator
 * rule. No session → the sign-in that applies; a signed-in person who does not
 * administer → one sentence that says so and the way home, inside the same
 * shell as every other page (like "Not found"): they keep their navigation.
 *
 * This layout is navigation and explanation, NOT the authorization boundary:
 * the App Router can render a page segment without it. Every page below
 * calls `requireOperator()` itself, and every route handler authorizes in
 * its handler.
 */
import { redirect } from 'next/navigation';

import { AdminShell, AppShell } from '@/components/shell/AppShell';
import { ButtonLink, EmptyState, PageHeader, SummaryLine } from '@/components/ui';
import { adminDecision } from '@/lib/auth/session';
import { instanceMetadata } from '@/lib/instance';
import { PAGES, ROUTES } from '@/lib/vocabulary';
import { adminSignInPage } from '@/server/auth';

export const dynamic = 'force-dynamic';

/** Every tab of Administration carries the instance's name (spec §4.2). */
export const generateMetadata = instanceMetadata;

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { root, decision, principal } = await adminDecision();
  const instance = await root.instance.name.identity();
  if (!decision.ok) {
    if (decision.status === 401 || !principal) redirect(await adminSignInPage(root.auth));
    return (
      <AppShell principal={principal} instance={instance}>
        <PageHeader title="Administration" />
        <EmptyState
          testId="not-administrator"
          title="You do not administer this gateway"
          action={
            <ButtonLink href={ROUTES.home} variant="primary">
              Go to {PAGES.now.title}
            </ButtonLink>
          }
          links={
            <SummaryLine
              centered
              items={[
                { label: PAGES.missions.title, href: ROUTES.missions },
                { label: PAGES.accounts.title, href: ROUTES.accounts },
                { label: PAGES.settings.title, href: ROUTES.settings },
              ]}
            />
          }
        >
          You are signed in, but you do not match its administrator rule (
          {describeRule(root.config.admin.group, root.config.admin.emails.length)}). Ask an
          administrator.
        </EmptyState>
      </AppShell>
    );
  }
  return (
    <AdminShell principal={decision.principal} instance={instance}>
      {children}
    </AdminShell>
  );
}

function describeRule(group: string | null, emailCount: number): string {
  const parts: string[] = [];
  if (group) parts.push(`the group "${group}" of its sign-in provider`);
  if (emailCount > 0) parts.push(`${emailCount} listed ${emailCount === 1 ? 'email' : 'emails'}`);
  return parts.join(' or ');
}
