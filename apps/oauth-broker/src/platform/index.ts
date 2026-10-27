/**
 * Picks the platform adapter named by OAUTH_BROKER_PLATFORM. The release
 * image fixes it (`ENV` in the Dockerfile) and its launch policy forbids
 * overriding it; it is not part of the operator's configuration.
 */
import {
  createGcpConfidentialSpaceAdapter,
  parseGcpSettings,
  PLATFORM as GCP,
} from './gcp-confidential-space.ts';
import { createLocalAdapter } from './local.ts';
import { type PlatformAdapter, PlatformError } from './types.ts';

export function selectPlatform(
  name: string | undefined,
  settings: Readonly<Record<string, unknown>>,
): PlatformAdapter {
  switch (name) {
    case GCP:
      return createGcpConfidentialSpaceAdapter(parseGcpSettings(settings[GCP]));
    case 'local':
      return createLocalAdapter(settings.local);
    default:
      throw new PlatformError(`OAUTH_BROKER_PLATFORM must be "${GCP}" or "local"`);
  }
}
