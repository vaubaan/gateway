/**
 * What is left to set up on this gateway — the checklist an administrator
 * reads on their first visit of the home (spec §7.1). Read-only: each line is
 * a fact another module already holds; the pages that change them are under
 * Settings.
 */
import type { AuthModule } from '../auth';
import { requiresApp, type ProviderAppsService } from '../provider-apps';
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
   * The services that need an app of the company before anyone can connect an
   * account (`requiresApp`). A service that also connects with a token is in
   * `optional` instead, never in `missing`.
   */
  readonly company_apps: {
    readonly registered: readonly string[];
    readonly missing: readonly string[];
    readonly optional: readonly string[];
  };
  readonly telemetry: {
    readonly enabled: boolean;
    /** An administrator chose, here or in the mounted configuration; `false`: still the default. */
    readonly decided: boolean;
  };
}

export async function readSetup(deps: SetupDeps): Promise<SetupView> {
  const providers = await deps.providers.views();
  const all = await deps.providerApps.list();
  const apps = all.filter(requiresApp);
  const { state } = await deps.telemetry.overview();
  return {
    sign_in: providers.length > 0 ? providers.map((provider) => provider.name).join(', ') : null,
    company_apps: {
      registered: apps.filter((app) => app.configured).map((app) => app.displayName),
      missing: apps.filter((app) => !app.configured).map((app) => app.displayName),
      optional: all
        .filter((app) => app.needsApp && !requiresApp(app))
        .map((app) => app.displayName),
    },
    telemetry: { enabled: state.enabled, decided: state.source !== 'default' },
  };
}
