/**
 * Ceilings and counters (spec §4.3 bis): the counts of the instance, its ceilings on
 * them, and the body of the counters endpoint. Built once by the composition root as
 * `root.limits`. Handbook: docs/handbook/limits-and-counters.md.
 */
import type { LimitsConfig } from '../config/types';
import type { Clock } from '../store/clock';
import { storeCounts, type CountedStore } from './counts';
import { InstanceLimits } from './service';

export {
  CEILINGS,
  ceilingOf,
  ceilingSentence,
  limitReached,
  LimitReachedError,
  UNLIMITED,
  type Ceiling,
  type LimitReached,
} from './ceilings';
export {
  countsAsActiveMission,
  revivesEndedMission,
  storeCounts,
  type AccountCounts,
  type CountedMission,
  type CountedStore,
  type InstanceCounts,
} from './counts';
export {
  InstanceLimits,
  type CeilingCheck,
  type CeilingUsage,
  type InstanceLimitsDeps,
} from './service';
export { collectOpsStats, utcMidnight, type OpsStats, type OpsStatsSources } from './stats';

/** The ceilings of the configuration over the counts of the store. */
export function createInstanceLimits(
  limits: LimitsConfig,
  store: CountedStore,
  clock?: Clock,
): InstanceLimits {
  return new InstanceLimits({ limits, counts: storeCounts(store), clock });
}
