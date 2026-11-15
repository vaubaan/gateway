/**
 * What each tool of the `ssh` service does, in a few words a person reads at
 * a glance (`ServicePlugin.toolTitles`) : the head of an approval request in
 * the web interface, before the resource the call resolves to. A verb and its
 * object, sentence case, no final period. For people only : never part of
 * `tools/list`, and the host decides nothing from it.
 *
 * A structural test of the gateway checks that every tool of a shipped plugin
 * has its title : a new tool is added here with its declaration.
 */

import { TOOL } from './identity.ts';

export const sshToolTitles: Readonly<Record<string, string>> = {
  [TOOL.exec]: 'Run a shell command on a host',
};
