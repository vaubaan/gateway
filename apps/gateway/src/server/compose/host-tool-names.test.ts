/**
 * The host answers its own tools by exact name before the registry (ADR
 * platform-management-is-a-plugin-on-the-execution-door): a plugin tool named
 * like one of them would never run, so the boot refuses it, naming the plugin.
 */
import { PluginRegistry, PluginRegistryError } from '@vaubaan/plugin-sdk';
import { vaubaanPlugin } from '@vaubaan/plugin-vaubaan';
import { describe, expect, it } from 'vitest';

import { permissionRequestTool } from '../execution/permission-request';
import { checkHostToolNames, HOST_TOOL_NAMES, hostToolNameProblems } from './registry';
import { SHIPPED_PLUGINS } from './shipped-plugins';
import { REPOSITORY_PLUGINS } from '../../../tests/support/plugins/repository';

describe('host tool names', () => {
  it('the host answers `vaubaan__request_permission`, under the prefix of the `vaubaan` plugin', () => {
    expect(HOST_TOOL_NAMES).toEqual(['vaubaan__request_permission']);
    expect(HOST_TOOL_NAMES).toContain(permissionRequestTool.name);
  });

  it('no shipped plugin takes a host tool name, the `vaubaan` plugin included', () => {
    expect(hostToolNameProblems(REPOSITORY_PLUGINS)).toEqual([]);
    // The server compiles the `vaubaan` plugin, whatever the catalog installs beside it.
    expect(SHIPPED_PLUGINS).toContain(vaubaanPlugin);
  });

  it('a plugin tool named like a host tool stops the boot, naming the plugin and the tool', () => {
    const base = vaubaanPlugin;
    const intruder = {
      ...base,
      tools: [
        ...base.tools,
        {
          name: 'vaubaan__request_permission',
          description: 'x',
          inputSchema: { type: 'object' as const },
        },
      ],
    };
    expect(hostToolNameProblems([intruder])).toEqual([
      `plugin '${base.id}' declares the tool 'vaubaan__request_permission', which the gateway itself answers: rename it`,
    ]);
    // The registry itself is built from validated plugins; the check reads it as the root does.
    const registry = Object.create(PluginRegistry.prototype) as PluginRegistry;
    Object.defineProperty(registry, 'all', { value: () => [{ plugin: intruder }] });
    expect(() => checkHostToolNames(registry)).toThrow(PluginRegistryError);
  });
});
