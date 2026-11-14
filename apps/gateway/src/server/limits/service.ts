/**
 * The ceilings of the instance against its counts (spec §4.3 bis). Built once by the
 * composition root as `root.limits` and handed to every place an item is added: the
 * sign-in and the people administration (users), the connect flows (accounts),
 * issuance and the revival of an ended mission (active missions).
 *
 * The check reads the count, then the caller writes: two additions racing each other
 * at the last free place may both pass. A ceiling is an operator's capacity rule, not
 * a security boundary; the next addition after them is refused.
 */
import type { LimitsConfig } from '../config/types';
import { systemClock, type Clock } from '../store/clock';
import { ceilingOf, CEILINGS, limitReached, type Ceiling, type LimitReached } from './ceilings';
import type { InstanceCounts } from './counts';

/** One count against its ceiling, for the administrator's view. */
export interface CeilingUsage {
  readonly ceiling: Ceiling;
  readonly count: number;
  /** `null`: unlimited. */
  readonly limit: number | null;
}

export interface InstanceLimitsDeps {
  readonly limits: LimitsConfig;
  readonly counts: InstanceCounts;
  readonly clock?: Clock;
}

/** What an adding path asks: may one more item of this count be added now? */
export interface CeilingCheck {
  /** `null` when one more fits (or the count is unlimited); else the refusal. */
  refusal(ceiling: Ceiling): Promise<LimitReached | null>;
}

export class InstanceLimits implements CeilingCheck {
  private readonly clock: Clock;

  constructor(private readonly deps: InstanceLimitsDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  get limits(): LimitsConfig {
    return this.deps.limits;
  }

  get counts(): InstanceCounts {
    return this.deps.counts;
  }

  async refusal(ceiling: Ceiling): Promise<LimitReached | null> {
    const limit = ceilingOf(this.deps.limits, ceiling);
    // Unlimited: nothing to count.
    if (limit === null) return null;
    return limitReached(ceiling, await this.count(ceiling), limit);
  }

  /** Every count against its ceiling, in the order of `CEILINGS`. */
  async usage(): Promise<CeilingUsage[]> {
    return Promise.all(
      CEILINGS.map(async (ceiling) => ({
        ceiling,
        count: await this.count(ceiling),
        limit: ceilingOf(this.deps.limits, ceiling),
      })),
    );
  }

  private async count(ceiling: Ceiling): Promise<number> {
    switch (ceiling) {
      case 'users':
        return this.deps.counts.users();
      case 'accounts':
        return (await this.deps.counts.accounts()).total;
      case 'active-missions':
        return this.deps.counts.activeMissions(this.clock.now());
    }
  }
}
