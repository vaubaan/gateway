/**
 * The plugin acts of the `vaubaan` tools (spec §4.1 bis; ADR
 * plugins-activated-by-an-administrator-on-trial): an agent hands over the plugin it
 * built (`upload_plugin`) and reads what is installed (`plugin_status`). Both only for a
 * mission whose creator is an administrator of the instance; neither activates, rolls
 * back nor removes anything — those acts stay in the browser.
 *
 * The module is handed a `VaubaanPlugins` port of three closures (`ports.ts`): no install
 * service, no store, nothing that activates.
 */
import type { VaubaanCaller } from '@vaubaan/plugin-vaubaan';

import type { Logger } from '../logging';
import type { ActOutcome, ActRefusal } from './acts';
import type { VaubaanPlugins } from './ports';

/** The archive, as base64, at most this long (16 MB of bytes once decoded). */
export const MAX_ARCHIVE_BASE64 = Math.ceil((16 * 1024 * 1024) / 3) * 4;

export interface UploadedPluginAnswer {
  readonly plugin: string;
  readonly version: string;
  readonly digest: string;
  readonly state: 'pending';
  /** Where an administrator reads what it changes and activates it. */
  readonly activation_url: string;
  readonly next: string;
}

export interface PluginStatusAnswer {
  readonly plugins: readonly {
    readonly plugin: string;
    readonly version: string;
    readonly origin: string;
  }[];
  readonly installed: readonly {
    readonly plugin: string;
    readonly version: string;
    readonly digest: string;
    readonly state: string;
    readonly trust: string;
    readonly failure: string | null;
  }[];
}

const done = <T>(data: T): ActOutcome<T> => ({ ok: true, data });
const refused = (refusal: ActRefusal): ActOutcome<never> => ({ ok: false, refusal });

function administratorOnly(): ActRefusal {
  return {
    code: 'administrator-only',
    message:
      'Only a mission created by an administrator of this instance installs or reads plugins. Nothing was done.',
    hint: 'Ask an administrator of the instance to issue the mission, or to upload the archive in Administration › Plugins.',
  };
}

export class VaubaanPluginActs {
  constructor(
    private readonly deps: { readonly plugins: VaubaanPlugins; readonly logger: Logger },
  ) {}

  private log(act: string, caller: VaubaanCaller, outcome: string): void {
    this.deps.logger.info('vaubaan plugin act', { act, outcome, mission_id: caller.missionId });
  }

  async uploadPlugin(
    caller: VaubaanCaller,
    input: { readonly archive_base64: string },
  ): Promise<ActOutcome<UploadedPluginAnswer>> {
    if (!(await this.deps.plugins.isAdministrator(caller.userId))) {
      this.log('upload_plugin', caller, 'administrator-only');
      return refused(administratorOnly());
    }
    const bytes = Buffer.from(input.archive_base64, 'base64');
    const result = await this.deps.plugins.upload(new Uint8Array(bytes), {
      userId: caller.userId,
      viaMissionId: caller.missionId,
    });
    if (!result.ok) {
      this.log('upload_plugin', caller, result.code);
      return refused({
        code: 'plugin-refused',
        reason: result.code,
        message: `The archive was refused: ${result.message}. Nothing was installed.`,
        hint: 'Fix the archive (`vaubaan-plugin build` writes one this gateway reads), then upload it again.',
      });
    }
    this.log('upload_plugin', caller, 'pending');
    return done({
      plugin: result.version.pluginId,
      version: result.version.version,
      digest: result.version.digest,
      state: 'pending',
      activation_url: this.deps.plugins.activationUrl(result.version.digest),
      next: 'Nothing of it runs yet. Hand the activation URL to an administrator: they read what it changes, activate it, and it starts on trial at the next start of the instance.',
    });
  }

  async pluginStatus(caller: VaubaanCaller): Promise<ActOutcome<PluginStatusAnswer>> {
    if (!(await this.deps.plugins.isAdministrator(caller.userId))) {
      this.log('plugin_status', caller, 'administrator-only');
      return refused(administratorOnly());
    }
    const status = await this.deps.plugins.status();
    return done(status);
  }
}
