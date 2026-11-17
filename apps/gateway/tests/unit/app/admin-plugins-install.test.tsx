/**
 * The installing part of Administration › Plugins rendered to static markup over
 * invented views (ADR plugins-activated-by-an-administrator-on-trial): the upload form,
 * or why there is none; one row per installed version with its state and trust; what an
 * activation would change, with the id to type; the restart once a trial is marked; and
 * what the last act said. What the forms do is `tests/integration/plugins/`.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  flashOf,
  InstallSection,
  type InstallView,
} from '@/app/admin/(guarded)/plugins/install-view';
import { INSTALL_WORDS } from '@/lib/vocabulary';
import { PLUGIN_ACTIONS } from '@/server/plugins/handlers';
import type { PluginVersionRecord } from '@/server/store/repositories/plugin-versions';

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');

function version(
  digest: string,
  state: PluginVersionRecord['state'],
  more: Partial<PluginVersionRecord> = {},
): PluginVersionRecord {
  return {
    digest: digest.repeat(64).slice(0, 64),
    pluginId: 'crm',
    version: '1.0.0',
    packageName: '@acme/crm',
    sdkRange: '^0.9.4',
    trust: 'unsigned',
    signer: null,
    riskIds: ['crm.contact-read'],
    state,
    failure: null,
    uploadedAt: '2026-11-17T10:00:00.000Z',
    uploadedBy: 'user-ops',
    viaMissionId: null,
    changedAt: '2026-11-17T10:00:00.000Z',
    changedBy: 'user-ops',
    ...more,
  };
}

function render(view: Partial<InstallView>): string {
  return renderToStaticMarkup(
    <InstallSection
      view={{ canInstall: true, versions: [], activations: {}, flash: null, ...view }}
    />,
  );
}

describe('Administration › Plugins, installing', () => {
  it('offers the upload form, or says why nothing can be installed', () => {
    expect(render({})).toContain(`action="${PLUGIN_ACTIONS.upload}"`);
    const memory = render({ canInstall: false });
    expect(memory).not.toContain(`action="${PLUGIN_ACTIONS.upload}"`);
    expect(text(memory)).toContain(INSTALL_WORDS.noDataDirectory);
  });

  it('shows what an activation changes, warns it is not Vaubaan’s, and asks for the id', () => {
    const pending = version('a', 'pending', {
      riskIds: ['crm.contact-read', 'crm.contact-delete'],
    });
    const html = render({
      versions: [pending],
      activations: {
        [pending.digest]: {
          version: pending,
          running: null,
          added: ['crm.contact-read', 'crm.contact-delete'],
          deprecated: [],
          unknownToIt: [],
          accounts: 0,
        },
      },
    });
    const page = text(html);
    expect(page).toContain(INSTALL_WORDS.states.pending);
    expect(page).toContain(INSTALL_WORDS.trust.unsigned);
    expect(page).toContain(INSTALL_WORDS.notVaubaan);
    expect(page).toContain('crm.contact-delete');
    expect(page).toContain(INSTALL_WORDS.typeToConfirm('crm'));
    expect(html).toContain(`action="${PLUGIN_ACTIONS.activate}"`);
    expect(html).toContain(`action="${PLUGIN_ACTIONS.refuse}"`);
  });

  it('offers to go back to a kept version, naming what it does not know', () => {
    const kept = version('b', 'previous');
    const page = text(
      render({
        versions: [version('c', 'active', { version: '1.1.0' }), kept],
        activations: {
          [kept.digest]: {
            version: kept,
            running: { version: '1.1.0', origin: 'installed' },
            added: [],
            deprecated: [],
            unknownToIt: ['crm.contact-merge'],
            accounts: 2,
          },
        },
      }),
    );
    expect(page).toContain(INSTALL_WORDS.goBack);
    expect(page).toContain('crm.contact-merge');
    expect(page).toContain(INSTALL_WORDS.followImage);
  });

  it('asks for a restart once a trial is marked, and says why a version did not load', () => {
    const page = render({
      versions: [version('d', 'trial'), version('e', 'failed', { failure: 'broken at import' })],
    });
    expect(page).toContain(`action="${PLUGIN_ACTIONS.restart}"`);
    expect(text(page)).toContain('broken at import');
  });

  it('reads what the last act said from the query, and ignores what it does not know', () => {
    expect(flashOf({ done: 'activated' })).toEqual({ kind: 'done', code: 'activated' });
    expect(flashOf({ problem: 'unsigned-not-allowed', detail: 'x' })).toEqual({
      kind: 'problem',
      code: 'unsigned-not-allowed',
      detail: 'x',
    });
    expect(flashOf({ done: '<script>' })).toBeNull();
    expect(text(render({ flash: flashOf({ done: 'uploaded' }) }))).toContain(
      INSTALL_WORDS.done.uploaded,
    );
  });
});
