/**
 * Test helpers of the authentication module. Not for production.
 */
import type { ConfigRepo } from '../store/repositories/config';

/**
 * Switches a provider saved in Settings on without a test beside the session: the
 * state a passed test then "Switch on" leaves (ADR administrators-live-in-the-instance,
 * §5), for tests whose subject is not the switch.
 */
export async function switchOnForTests(config: Pick<ConfigRepo, 'set'>, id: string): Promise<void> {
  await config.set(`sign_in_state.${id}`, JSON.stringify({ enabled: true, changed_at: null }));
}
