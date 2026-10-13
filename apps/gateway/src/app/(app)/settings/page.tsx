/**
 * `/settings` — the person's own settings, and the door to the gateway's
 * administration for those who administer it.
 *
 * It holds the theme and leads to the other pages of Settings: connected apps
 * (`/settings/connected-apps`) and, for an administrator, the administration
 * (`/admin/**`). Open to every session: whoever installs the gateway
 * configures it from here too.
 */
import { SettingsFrame } from '@/components/shell/AppShell';
import { ADMIN_PAGES } from '@/components/shell/settings-nav';
import { ThemeChoiceControl } from '@/components/shell/ThemeToggle';
import { isOperatorPrincipal } from '@/components/auth/principal';
import { ButtonLink, PageHeader, Row, Rows, Section } from '@/components/ui';
import { requirePrincipal } from '@/lib/auth/session';
import { currentTheme } from '@/lib/theme-server';
import { PAGES, ROUTES, SECTIONS, THEME_WORDS } from '@/lib/vocabulary';

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
          <Row
            title={SECTIONS.connectedApps}
            description="The apps you allowed to prepare missions in your name. They can never execute a call or answer for you."
            end={
              <ButtonLink href={ROUTES.connectedApps} size="sm">
                Open
              </ButtonLink>
            }
          />
          <Row
            title={PAGES.design.title}
            description={PAGES.design.lede}
            end={
              <ButtonLink href={ROUTES.design} size="sm">
                Open
              </ButtonLink>
            }
          />
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
              description="Sign-in, company apps, people and teams, telemetry: what a gateway needs, and what is left to do."
              end={
                <ButtonLink href={ADMIN_PAGES.setup} size="sm">
                  Open
                </ButtonLink>
              }
            />
          </Rows>
        </Section>
      )}
    </SettingsFrame>
  );
}
