/**
 * What is left to set up on this gateway — the checklist an administrator
 * reads on their first visit of the home (spec §7.1). Read-only: each line is
 * a fact another module already holds; the pages that change them are under
 * Settings.
 */
import type { AuthModule } from '../auth';
import type { TelemetryModule } from '../telemetry';

export interface SetupDeps {
  readonly signInProviders: Pick<AuthModule['signInProviders'], 'views'>;
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
  const signInProviders = await deps.signInProviders.views();
  const { state } = await deps.telemetry.overview();
  return {
    sign_in:
      signInProviders.length > 0
        ? signInProviders.map((signInProvider) => signInProvider.name).join(', ')
        : null,
    telemetry: { enabled: state.enabled, decided: state.source !== 'default' },
  };
}
