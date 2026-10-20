/**
 * `/settings` — the person's own settings, and the door to the gateway's
 * administration for those who administer it.
 *
 * It holds the theme and leads to the other pages of Settings: connected apps
 * (`/settings/connected-apps`) and, for an administrator, the administration
 * (`/admin/**`) and the interface reference (`/design`, a component gallery:
 * reachable by its address for anyone signed in, listed here for
 * administrators only). Open to every session: whoever installs the gateway
 * configures it from here too.
 */
import { SettingsFrame } from '@/components/shell/AppShell';
import { ADMIN_PAGES } from '@/components/shell/settings-nav';
import { ThemeChoiceControl } from '@/components/shell/ThemeToggle';
import { isOperatorPrincipal } from '@/components/auth/principal';
import { Button, ButtonLink, PageHeader, Row, Rows, Section } from '@/components/ui';
import { requirePrincipal } from '@/lib/auth/session';
import { currentTheme } from '@/lib/theme-server';
import { ACTIONS, PAGES, ROUTES, SECTIONS, THEME_WORDS } from '@/lib/vocabulary';
import { SECURITY_PAGE } from '@/server/auth';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const { principal } = await requirePrincipal();
  const theme = await currentTheme();
  const administrator = isOperatorPrincipal(principal);

  return (
    <SettingsFrame principal={principal}>
      <PageHeader title={PAGES.settings.title} lede={PAGES.settings.lede} />
      <Section title="You" first>
        <Rows>
          <Row
            title={THEME_WORDS.label}
            description="System follows your device. The choice is kept in this browser."
            end={<ThemeChoiceControl initial={theme} />}
            testId="settings-theme"
          />
          {principal.kind === 'user' && (
            <Row
              title="Security"
              description="Your password and your second factor, when this gateway keeps your account."
              end={
                <ButtonLink href={SECURITY_PAGE} size="sm">
                  Open
                </ButtonLink>
              }
              testId="settings-security"
            />
          )}
          <Row
            title={SECTIONS.connectedApps}
            description="The apps you allowed to prepare missions in your name. They can never execute a call or answer for you."
            end={
              <ButtonLink href={ROUTES.connectedApps} size="sm">
                Open
              </ButtonLink>
            }
          />
          {principal.kind === 'user' && (
            <Row
              title={ACTIONS.signOutEverywhere}
              description="Ends every session you have open, in every browser, this one included. Your keys, connected apps and missions are not touched. A session also ends after an hour without use."
              end={
                <form method="post" action="/logout/everywhere">
                  <Button type="submit" size="sm" variant="secondary">
                    {ACTIONS.signOutEverywhere}
                  </Button>
                </form>
              }
              testId="settings-sign-out-everywhere"
            />
          )}
        </Rows>
      </Section>

      {administrator && (
        <Section
          title="Administration"
          note="You see this part because you administer this gateway."
        >
          <Rows>
            <Row
              title={SECTIONS.setup}
              description="Sign-in, OAuth clients, people and teams, telemetry: what a gateway needs, and what is left to do."
              end={
                <ButtonLink href={ADMIN_PAGES.setup} size="sm">
                  Open
                </ButtonLink>
              }
            />
            {/* The component gallery is a tool of whoever maintains the gateway:
                listed for administrators only; the page itself stays open by its address. */}
            <Row
              title={PAGES.design.title}
              description={PAGES.design.lede}
              end={
                <ButtonLink href={ROUTES.design} size="sm">
                  Open
                </ButtonLink>
              }
              testId="settings-interface-reference"
            />
          </Rows>
        </Section>
      )}
    </SettingsFrame>
  );
}
