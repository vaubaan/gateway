/**
 * Representative calls of the `ssh` service's tool
 * (`ServicePlugin.examples`) : the samples the plugin's tests run through the
 * kit and the site classifies when it builds (ADR
 * plugin-contract-and-credential-spec, amendment 2026-11-05).
 *
 * One command line per command class (read, secret read, write, destructive,
 * package install, service control, sudo), on one staging host ; a host the
 * mission does not hold is refused.
 */
import { samplesOn, type Resource, type ToolSamples } from '@vaubaan/plugin-sdk';

import { SERVICE_ID, TOOL } from './identity.ts';

export const EXAMPLE_HOST = 'vps-1.example.com';
const OTHER_HOST = '10.0.0.7';

/** The one host the samples run on. */
export const EXAMPLE_STAGING_HOST: Resource = {
  service: SERVICE_ID,
  ref: EXAMPLE_HOST,
  env: 'staging',
  displayName: `deploy@${EXAMPLE_HOST}:22`,
};

export const sshExamples: ToolSamples = samplesOn([EXAMPLE_STAGING_HOST], {
  [TOOL.exec]: [
    { args: { cmd: 'uptime' } },
    { args: { host: EXAMPLE_HOST, cmd: 'cat /etc/shadow' } },
    { args: { cmd: 'touch /tmp/x' } },
    { args: { cmd: 'rm -rf /srv/app/releases/old' } },
    { args: { cmd: 'sudo apt-get install -y nginx' } },
    { args: { cmd: 'systemctl restart nginx' } },
    { args: { host: OTHER_HOST, cmd: 'ls' }, expectDenied: true },
  ],
});
