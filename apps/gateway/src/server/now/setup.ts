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
  readonly idp: Pick<AuthModule['idp'], 'current'>;
  readonly providerApps: Pick<ProviderAppsService, 'list'>;
  readonly telemetry: Pick<TelemetryModule, 'overview'>;
}

export interface SetupView {
  /** The host of the identity provider people sign in through; `null` until one is configured. */
  readonly sign_in: string | null;
  /** The services that need an app of the company before anyone can connect an account. */
  readonly company_apps: {
    readonly registered: readonly string[];
    readonly missing: readonly string[];
  };
  readonly telemetry: {
    readonly enabled: boolean;
    /** An administrator chose, here or in the mounted configuration; `false`: still the default. */
    readonly decided: boolean;
  };
}

export async function readSetup(deps: SetupDeps): Promise<SetupView> {
  const idp = await deps.idp.current();
  const apps = (await deps.providerApps.list()).filter((app) => app.needsApp);
  const { state } = await deps.telemetry.overview();
  return {
    sign_in: idp ? idp.settings.issuer.hostname : null,
    company_apps: {
      registered: apps.filter((app) => app.configured).map((app) => app.displayName),
      missing: apps.filter((app) => !app.configured).map((app) => app.displayName),
    },
    telemetry: { enabled: state.enabled, decided: state.source !== 'default' },
  };
}
