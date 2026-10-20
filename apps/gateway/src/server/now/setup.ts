/**
 * What is left to set up on this gateway — the checklist an administrator
 * reads on their first visit of the home (spec §7.1). Read-only: each line is
 * a fact another module already holds; the pages that change them are under
 * Settings.
 */
import type { AuthModule } from '../auth';
import type { ProviderAppsService } from '../provider-apps';
import type { TelemetryModule } from '../telemetry';

export interface SetupDeps {
  readonly providers: Pick<AuthModule['providers'], 'views'>;
  readonly providerApps: Pick<ProviderAppsService, 'list'>;
  readonly telemetry: Pick<TelemetryModule, 'overview'>;
}

export interface SetupView {
  /** The sign-in providers people sign in through, by name ("GitHub, Acme"); `null` until one is configured. */
  readonly sign_in: string | null;
  /**
   * The services that connect through an OAuth client the company declares
   * (`needsApp`): nobody connects an account of a `missing` one until an
   * administrator declares it on the service's connect page.
   */
  readonly company_apps: {
    readonly registered: readonly string[];
    /** Each with the id of its service, for the link to its connect page. */
    readonly missing: readonly { readonly id: string; readonly name: string }[];
  };
  readonly telemetry: {
    readonly enabled: boolean;
    /** An administrator chose, here or in the mounted configuration; `false`: still the default. */
    readonly decided: boolean;
  };
}

export async function readSetup(deps: SetupDeps): Promise<SetupView> {
  const providers = await deps.providers.views();
  const apps = (await deps.providerApps.list()).filter((app) => app.needsApp);
  const { state } = await deps.telemetry.overview();
  return {
    sign_in: providers.length > 0 ? providers.map((provider) => provider.name).join(', ') : null,
    company_apps: {
      registered: apps.filter((app) => app.configured).map((app) => app.displayName),
      missing: apps
        .filter((app) => !app.configured)
        .map((app) => ({ id: app.providerId, name: app.displayName })),
    },
    telemetry: { enabled: state.enabled, decided: state.source !== 'default' },
  };
}
