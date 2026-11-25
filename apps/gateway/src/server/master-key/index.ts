/**
 * The master key as a module of the instance (ADR
 * master-key-generated-and-handed-over-by-the-instance): its state, the handover
 * step of Setup, the download of Administration → Encryption. Built once by the
 * composition root as `root.masterKey`. Handbook: docs/handbook/configuration.md,
 * "Master key generated at the first start".
 */
import type { AuditWriter } from '@vaubaan/gateway-core';

import type { Authenticator } from '../auth/authenticator';
import type { SessionService } from '../auth/session-service';
import type { InstanceConfig } from '../config';
import type { Logger } from '../logging';
import { systemClock, type Clock } from '../store/clock';
import type { ConfigRepo } from '../store/repositories/config';
import { createMasterKeyHandlers, type MasterKeyHandlers } from './handlers';
import { MasterKeyService } from './service';

export {
  CONFIRMED_FIELD,
  ENCRYPTION_PAGE,
  FRESH_SIGN_IN_MS,
  FROM_FIELD,
  HANDOVER_ANCHOR,
  KEY_PROBLEM_PARAM,
  MASTER_KEY_DOWNLOAD_ACTION,
  MASTER_KEY_HANDOVER_ACTION,
  SETUP_PAGE,
  signedInFreshly,
  WELCOME_PAGE,
  type DownloadOrigin,
  type MasterKeyProblem,
} from './handlers';
export {
  MASTER_KEY_GENERATED_KEY,
  MASTER_KEY_HANDED_OVER_KEY,
  MASTER_KEY_OBJECT_ID,
  MasterKeyService,
  type MasterKeyState,
} from './service';
export { MASTER_KEY_FILE_NAME } from '../crypto/master-key-file';

export interface MasterKeyModuleDeps {
  readonly config: Pick<InstanceConfig, 'encryption' | 'publicUrl'>;
  readonly store: { readonly config: ConfigRepo; readonly auditWriter: AuditWriter };
  readonly authenticator: Authenticator;
  readonly sessions: Pick<SessionService, 'read'>;
  readonly logger: Logger;
  readonly clock?: Clock;
}

export interface MasterKeyModule {
  readonly service: MasterKeyService;
  readonly handlers: MasterKeyHandlers;
}

export function createMasterKeyModule(deps: MasterKeyModuleDeps): MasterKeyModule {
  const clock = deps.clock ?? systemClock;
  const service = new MasterKeyService(deps.config.encryption, deps.store.config, clock);
  const handlers = createMasterKeyHandlers({
    publicUrl: deps.config.publicUrl,
    authenticator: deps.authenticator,
    sessions: deps.sessions,
    service,
    audit: deps.store.auditWriter,
    logger: deps.logger.child({ component: 'master-key' }),
    clock,
  });
  return { service, handlers };
}
