/**
 * The missions repository, one part per aggregate: the mission row and its lifecycle
 * (`lifecycle.ts`), the creator's edit (`edit.ts`), the policy lines and trust marks
 * (`policy.ts`), the resources of its accounts (`resources.ts`), its tokens and members
 * (`holders.ts`). They share the statements and mappers of `core.ts` and `rows.ts`.
 */
import type { RepoContext } from '../context.ts';
import { createMissionCore } from './core.ts';
import { createMissionEdit } from './edit.ts';
import { createMissionHolders } from './holders.ts';
import { createMissionLifecycle } from './lifecycle.ts';
import { createMissionPolicy } from './policy.ts';
import { createMissionResources } from './resources.ts';
import type { MissionsRepo } from './types.ts';

export { isRiskOfService } from './rows.ts';
export type {
  AddedMember,
  AddedMissionResources,
  AddMemberInput,
  AppliedLimitChange,
  CreatedBy,
  CreateMissionInput,
  IssuedToken,
  IssueTokenInput,
  LimitChange,
  MissionEditInput,
  MissionEditResult,
  MissionsRepo,
  MissionTokenKey,
  RemovedMember,
  ResourceChange,
  ResourceMove,
  ResourceMoveReason,
  SetGateOptions,
  StoredMissionStatus,
} from './types.ts';

export function createMissionsRepo(ctx: RepoContext): MissionsRepo {
  const core = createMissionCore(ctx);
  return {
    ...createMissionEdit(ctx, core),
    ...createMissionLifecycle(ctx, core),
    ...createMissionResources(ctx, core),
    ...createMissionPolicy(ctx, core),
    ...createMissionHolders(ctx, core),
  };
}
