/**
 * Picks the platform adapter named by OAUTH_BROKER_PLATFORM. The release
 * image sets it to Confidential Space (`ENV` in the Dockerfile), and the
 * launch policy forbids overriding it there; outside an enclave the operator
 * sets `unattested`. It is not part of the operator's configuration.
 */
import {
  createGcpConfidentialSpaceAdapter,
  parseGcpSettings,
  PLATFORM as GCP,
} from './gcp-confidential-space.ts';
import { createLocalAdapter } from './local.ts';
import { createUnattestedAdapter, PLATFORM as UNATTESTED } from './unattested.ts';
import { type PlatformAdapter, PlatformError } from './types.ts';

export function selectPlatform(
  name: string | undefined,
  settings: Readonly<Record<string, unknown>>,
): PlatformAdapter {
  switch (name) {
    case GCP:
      return createGcpConfidentialSpaceAdapter(parseGcpSettings(settings[GCP]));
    case UNATTESTED:
      return createUnattestedAdapter();
    case 'local':
      return createLocalAdapter(settings.local);
    default:
      throw new PlatformError(`OAUTH_BROKER_PLATFORM must be "${GCP}", "${UNATTESTED}" or "local"`);
  }
}
