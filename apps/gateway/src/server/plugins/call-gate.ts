/**
 * The calls of each service against a swap of its plugin's version (ADR
 * plugins-activated-by-an-administrator-on-trial, amendment 2026-11-19).
 *
 * A call reads the registry at several stages (resource, risk, upstream, what it created): it
 * must meet one version from its first stage to its last, or a call the old classifier judged
 * would run on the new executor. So a call `enter`s its service before its first stage and
 * releases it after its last; a swap waits until no call of that service runs, then replaces
 * the entry at once, while every call of that service arriving meanwhile waits for the swap.
 * The other services are never held. In-process only: one instance, one registry.
 */

/** Ends a call's hold on its service; calling it twice does nothing. */
export type CallRelease = () => void;

export interface PluginCallGate {
  /** Waits for a swap of `service` under way, then holds the service until released. */
  enter(service: string): Promise<CallRelease>;
  /**
   * Runs `swap` once no call of `service` runs, new calls of it waiting meanwhile; resolves
   * with what it returned. `swap` must be synchronous: nothing may run between the drain and
   * the change.
   */
  swap<T>(service: string, swap: () => T): Promise<T>;
  /** The calls of `service` running now. */
  running(service: string): number;
}

interface ServiceState {
  running: number;
  /** The swap under way: new calls wait on it. */
  swapping: Promise<unknown> | null;
  /** Resolved when `running` falls to zero while a swap waits. */
  drained: (() => void) | null;
}

export function createPluginCallGate(): PluginCallGate {
  const states = new Map<string, ServiceState>();
  const stateOf = (service: string): ServiceState => {
    let state = states.get(service);
    if (!state) {
      state = { running: 0, swapping: null, drained: null };
      states.set(service, state);
    }
    return state;
  };

  return {
    async enter(service) {
      const state = stateOf(service);
      // A swap may follow another: wait until none is under way.
      while (state.swapping !== null) {
        await state.swapping.catch(() => undefined);
      }
      state.running += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        state.running -= 1;
        if (state.running === 0) state.drained?.();
      };
    },

    async swap(service, swap) {
      const state = stateOf(service);
      while (state.swapping !== null) {
        await state.swapping.catch(() => undefined);
      }
      const done = (async () => {
        if (state.running > 0) {
          await new Promise<void>((resolve) => {
            state.drained = resolve;
          });
          state.drained = null;
        }
        return swap();
      })();
      state.swapping = done;
      try {
        return await done;
      } finally {
        state.swapping = null;
      }
    },

    running: (service) => states.get(service)?.running ?? 0,
  };
}
