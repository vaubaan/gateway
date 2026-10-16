/**
 * The instance's own identity in the interface (spec §4.2, §4.3): its name,
 * set by the configuration or by an administrator, and the host it stands
 * beside. Built once by the composition root as `root.instance`.
 * Handbook: docs/handbook/configuration.md, "Instance name".
 */
import type { AuditWriter } from '@vaubaan/gateway-core';

import type { Authenticator } from '../auth/authenticator';
import type { InstanceConfig } from '../config';
import type { Logger } from '../logging';
import { systemClock, type Clock } from '../store/clock';
import type { ConfigRepo } from '../store/repositories/config';
import { createInstanceNameHandlers, type InstanceNameHandlers } from './handlers';
import { InstanceNameService } from './settings';

export {
  INSTANCE_NAME_ACTION,
  INSTANCE_NAME_ANCHOR,
  INSTANCE_NAME_PAGE,
  NAME_FIELD,
  NAME_PROBLEM_PARAM,
  type InstanceNameProblem,
} from './handlers';
export {
  INSTANCE_NAME_KEY,
  INSTANCE_NAME_OBJECT_ID,
  InstanceNameLockedError,
  InstanceNameService,
  InvalidInstanceNameError,
  type InstanceIdentity,
  type InstanceNameSource,
  type InstanceNameState,
} from './settings';

export interface InstanceModuleDeps {
  readonly config: Pick<InstanceConfig, 'instanceName' | 'publicUrl'>;
  readonly store: { readonly config: ConfigRepo; readonly auditWriter: AuditWriter };
  readonly authenticator: Authenticator;
  readonly logger: Logger;
  readonly clock?: Clock;
}

export interface InstanceModule {
  readonly name: InstanceNameService;
  readonly handlers: InstanceNameHandlers;
}

export function createInstanceModule(deps: InstanceModuleDeps): InstanceModule {
  const name = new InstanceNameService({ config: deps.config, store: deps.store.config });
  const handlers = createInstanceNameHandlers({
    publicUrl: deps.config.publicUrl,
    authenticator: deps.authenticator,
    settings: name,
    audit: deps.store.auditWriter,
    logger: deps.logger.child({ component: 'instance' }),
    clock: deps.clock ?? systemClock,
  });
  return { name, handlers };
}
