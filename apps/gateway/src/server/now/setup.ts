/**
 * What is left to set up on this gateway — the checklist an administrator
 * reads on their first visit of the home (spec §7.1). Read-only: each line is
 * a fact another module already holds; the pages that change them are under
 * Settings.
 */
import type { AuthModule } from '../auth';
import type { TelemetryModule } from '../telemetry';

export interface SetupDeps {
  readonly providers: Pick<AuthModule['providers'], 'views'>;
  readonly telemetry: Pick<TelemetryModule, 'overview'>;
}

export interface SetupView {
  /** The sign-in providers people sign in through, by name ("GitHub, Acme"); `null` until one is configured. */
  readonly sign_in: string | null;
  readonly telemetry: {
    readonly enabled: boolean;
    /** An administrator chose, here or in the mounted configuration; `false`: still the default. */
    readonly decided: boolean;
  };
}

export async function readSetup(deps: SetupDeps): Promise<SetupView> {
  const providers = await deps.providers.views();
  const { state } = await deps.telemetry.overview();
  return {
    sign_in: providers.length > 0 ? providers.map((provider) => provider.name).join(', ') : null,
    telemetry: { enabled: state.enabled, decided: state.source !== 'default' },
  };
}
