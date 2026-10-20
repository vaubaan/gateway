/**
 * What is left to set up on this gateway — the checklist an administrator
 * reads on their first visit of the home (spec §7.1). Read-only: each line is
 * a fact another module already holds; the pages that change them are under
 * Settings.
 */
import type { AuthModule } from '../auth';
import type { ProviderAppsService, ProviderAppStatus } from '../provider-apps';
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

/** The services split by what they need from an administrator before anyone connects them. */
export interface OAuthClientChecklist {
  /** Services whose OAuth client is declared. */
  readonly registered: readonly ProviderAppStatus[];
  /** Services whose OAuth client is still to declare. */
  readonly missing: readonly ProviderAppStatus[];
  /** Services connected with a key: nothing to declare. */
  readonly keyed: readonly ProviderAppStatus[];
}

/** The one split of the OAuth clients the admin home and the first run both show. */
export function oauthClientChecklist(apps: readonly ProviderAppStatus[]): OAuthClientChecklist {
  return {
    registered: apps.filter((app) => app.needsApp && app.configured),
    missing: apps.filter((app) => app.needsApp && !app.configured),
    keyed: apps.filter((app) => !app.needsApp),
  };
}

export async function readSetup(deps: SetupDeps): Promise<SetupView> {
  const providers = await deps.providers.views();
  const apps = oauthClientChecklist(await deps.providerApps.list());
  const { state } = await deps.telemetry.overview();
  return {
    sign_in: providers.length > 0 ? providers.map((provider) => provider.name).join(', ') : null,
    company_apps: {
      registered: apps.registered.map((app) => app.displayName),
      missing: apps.missing.map((app) => ({ id: app.providerId, name: app.displayName })),
    },
    telemetry: { enabled: state.enabled, decided: state.source !== 'default' },
  };
}
