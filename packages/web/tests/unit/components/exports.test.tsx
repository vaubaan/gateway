/**
 * Unit tests for the Phase 7 wave B exports UI :
 *
 *   - `<DotenvExportButton>` — POST /exports/env → unseal → download.
 *   - `<McpExportButton>` — POST /exports/mcp → 2 downloads.
 *   - `<CloudResourceMapButton>` — POST /exports/cloud-resource-map →
 *     direct JSON download (no unseal).
 *   - `<RegenerateMcpButton>` — POST /mcp-configs/regenerate.
 *   - `assembleDotenv` — placeholder substitution when unseal fails.
 *
 * The crypto module is mocked (same approach as the rotate-button
 * tests). We focus on the dispatch + download triggers, not the seal
 * math (covered in packages/core/tests/unit/crypto/).
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { CloudResourceMapButton } from '@/components/exports/CloudResourceMapButton';
import { DotenvExportButton } from '@/components/exports/DotenvExportButton';
import { McpExportButton } from '@/components/exports/McpExportButton';
import { RegenerateMcpButton } from '@/components/exports/RegenerateMcpButton';
import { assembleDotenv, assembleJson } from '@/lib/exports/dotenv-assembly';

vi.mock('@crm/core/crypto', () => ({
  unsealAs: (blob: { recipients: ReadonlyArray<{ fp: string }> }, fp: string) => {
    // Return a fake cleartext when the caller's fp is the first recipient,
    // null otherwise (simulates not_a_recipient).
    if (blob.recipients[0]?.fp === fp) {
      return Promise.resolve(new TextEncoder().encode(`cleartext-for-${fp.slice(0, 4)}`));
    }
    return Promise.resolve(null);
  },
  decodeUtf8: (b: Uint8Array) => new TextDecoder().decode(b),
}));

vi.mock('@/lib/crypto/identity-store', () => ({
  identityStore: {
    get: () => ({
      fingerprint: 'a'.repeat(32),
      publicKey: new Uint8Array(32),
      privateKey: new Uint8Array(32),
    }),
  },
}));

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body?: string;
}

function installFetchMock(handler: (call: FetchCall) => Response | Promise<Response>): {
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  global.fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : undefined;
    calls.push({ url, method, ...(body !== undefined ? { body } : {}) });
    return Promise.resolve(handler({ url, method, ...(body !== undefined ? { body } : {}) }));
  });
  return { calls };
}

function installDownloadCapture(): { files: Array<{ name: string }> } {
  const files: Array<{ name: string }> = [];
  globalThis.URL.createObjectURL = vi.fn(() => `blob://${Math.random().toString(36).slice(2)}`);
  globalThis.URL.revokeObjectURL = vi.fn();
  // Intercept any element appended to <body> that has a `download`
  // attribute. The helper creates an anchor, sets `.download`, then
  // `appendChild` → click → remove. We hook appendChild on body to
  // capture the filename.
  const origAppendChild = document.body.appendChild.bind(document.body);
  vi.spyOn(document.body, 'appendChild').mockImplementation(<T extends Node>(node: T) => {
    if ((node as unknown as HTMLAnchorElement).tagName === 'A') {
      const a = node as unknown as HTMLAnchorElement;
      if (typeof a.download === 'string' && a.download.length > 0) {
        files.push({ name: a.download });
      }
    }
    return origAppendChild(node);
  });
  return { files };
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 16; i++) await Promise.resolve();
  });
}

describe('assembleDotenv (unit)', () => {
  it('substitutes placeholders when unseal returns null (not_a_recipient)', async () => {
    const identity = {
      fingerprint: 'a'.repeat(32),
      publicKey: new Uint8Array(32),
      privateKey: new Uint8Array(32),
    };
    const result = await assembleDotenv(
      [
        {
          key: 'GITHUB_TOKEN',
          source_resource_id: 'r-gh',
          source_resource_name: 'acme-gh',
          source_kind: 'github-org',
          sealed_blob: {
            v: 1,
            recipients: [{ fp: 'a'.repeat(32), ct: 'CCCC' }],
          },
          recipient_fingerprints: ['a'.repeat(32)],
        },
        {
          key: 'NO_ACCESS_KEY',
          source_resource_id: 'r-no',
          source_resource_name: 'acme-secret',
          source_kind: 'github-org',
          sealed_blob: {
            v: 1,
            // Caller's fp not present → unseal returns null.
            recipients: [{ fp: 'b'.repeat(32), ct: 'BBBB' }],
          },
          recipient_fingerprints: ['b'.repeat(32)],
        },
      ],
      identity,
    );
    expect(result.text).toContain('GITHUB_TOKEN=cleartext-for-aaaa');
    expect(result.text).toContain('# UNAVAILABLE: NO_ACCESS_KEY');
    expect(result.resolved).toEqual(['GITHUB_TOKEN']);
    expect(result.unavailable).toEqual(['NO_ACCESS_KEY']);
  });

  it('assembleJson produces a JSON object with placeholders for unavailable keys', async () => {
    const identity = {
      fingerprint: 'a'.repeat(32),
      publicKey: new Uint8Array(32),
      privateKey: new Uint8Array(32),
    };
    const result = await assembleJson(
      [
        {
          key: 'X',
          source_resource_id: 'r-x',
          source_resource_name: 'n',
          source_kind: 'k',
          sealed_blob: { v: 1, recipients: [{ fp: 'a'.repeat(32), ct: 'CC' }] },
          recipient_fingerprints: ['a'.repeat(32)],
        },
        {
          key: 'Y',
          source_resource_id: 'r-y',
          source_resource_name: 'n',
          source_kind: 'k',
          sealed_blob: null,
          recipient_fingerprints: [],
        },
      ],
      identity,
    );
    const parsed = JSON.parse(result.text) as Record<string, string>;
    expect(parsed.X).toBe('cleartext-for-aaaa');
    expect(parsed.Y).toBe('UNAVAILABLE');
  });
});

describe('<DotenvExportButton>', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders an idle "Download .env" button', () => {
    installFetchMock(() => new Response('{}'));
    render(
      <DotenvExportButton orgSlug="acme" scope={{ kind: 'org' }} variant={null} format="dotenv" />,
    );
    expect(screen.getByTestId('dotenv-export-button').textContent).toBe('Download .env');
  });

  it('POSTs /exports/env then triggers a download summarising resolved+unavailable', async () => {
    const dl = installDownloadCapture();
    const { calls } = installFetchMock((call) => {
      if (call.url.endsWith('/exports/env') && call.method === 'POST') {
        return new Response(
          JSON.stringify({
            format: 'dotenv',
            entries: [
              {
                key: 'GITHUB_TOKEN',
                source_resource_id: 'r-gh',
                source_resource_name: 'acme-gh',
                source_kind: 'github-org',
                sealed_blob: { v: 1, recipients: [{ fp: 'a'.repeat(32), ct: 'CC' }] },
                recipient_fingerprints: ['a'.repeat(32)],
              },
              {
                key: 'NO_ACCESS_KEY',
                source_resource_id: 'r-no',
                source_resource_name: 'acme-secret',
                source_kind: 'github-org',
                sealed_blob: { v: 1, recipients: [{ fp: 'b'.repeat(32), ct: 'CC' }] },
                recipient_fingerprints: ['b'.repeat(32)],
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response('{}');
    });
    render(
      <DotenvExportButton orgSlug="acme" scope={{ kind: 'org' }} variant={null} format="dotenv" />,
    );
    fireEvent.click(screen.getByTestId('dotenv-export-button'));
    await flushAsync();
    expect(calls.find((c) => c.url.endsWith('/exports/env'))).toBeDefined();
    expect(dl.files).toHaveLength(1);
    expect(dl.files[0]!.name).toBe('acme.env');
    expect(screen.getByTestId('dotenv-export-summary').textContent).toContain('1 unsealed');
    expect(screen.getByTestId('dotenv-export-summary').textContent).toContain('1 placeholder');
  });

  it('surfaces an error when /exports/env returns 401', async () => {
    installFetchMock(
      () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
    );
    render(
      <DotenvExportButton orgSlug="acme" scope={{ kind: 'org' }} variant={null} format="dotenv" />,
    );
    fireEvent.click(screen.getByTestId('dotenv-export-button'));
    await flushAsync();
    expect(screen.getByTestId('dotenv-export-error').textContent).toContain('unauthorized');
  });
});

describe('<McpExportButton>', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('downloads mcp.json + .env-mcp on success', async () => {
    const dl = installDownloadCapture();
    installFetchMock((call) => {
      if (call.url.endsWith('/exports/mcp') && call.method === 'POST') {
        return new Response(
          JSON.stringify({
            mcp_json: { mcpServers: { 'acme-gh': { command: 'docker' } } },
            env_manifest: {
              keys: [
                { key: 'GITHUB_TOKEN', source_resource_id: 'r-gh', source_kind: 'github-org' },
              ],
            },
            env_dotenv_template: '# placeholder template',
            env_entries: [
              {
                key: 'GITHUB_TOKEN',
                source_resource_id: 'r-gh',
                source_resource_name: 'acme-gh',
                source_kind: 'github-org',
                sealed_blob: { v: 1, recipients: [{ fp: 'a'.repeat(32), ct: 'CC' }] },
                recipient_fingerprints: ['a'.repeat(32)],
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response('{}');
    });
    render(<McpExportButton orgSlug="acme" scope={{ kind: 'org' }} variant={null} />);
    fireEvent.click(screen.getByTestId('mcp-export-button'));
    await flushAsync();
    expect(dl.files).toHaveLength(2);
    expect(dl.files[0]!.name).toBe('acme.mcp.json');
    expect(dl.files[1]!.name).toBe('acme.env-mcp');
    expect(screen.getByTestId('mcp-export-summary').textContent).toContain('1 resolved');
  });
});

describe('<CloudResourceMapButton>', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('downloads the JSON map directly (no unseal involved)', async () => {
    const dl = installDownloadCapture();
    installFetchMock((call) => {
      if (call.url.endsWith('/exports/cloud-resource-map') && call.method === 'POST') {
        return new Response(
          JSON.stringify({
            version: 1,
            exported_at: '2026-05-21T10:00:00Z',
            organization_id: 'org-1',
            resources: [{ id: 'r-1', kind: 'github-org' }],
          }),
          { status: 200 },
        );
      }
      return new Response('{}');
    });
    render(<CloudResourceMapButton orgSlug="acme" />);
    fireEvent.click(screen.getByTestId('crm-map-button'));
    await flushAsync();
    expect(dl.files).toHaveLength(1);
    expect(dl.files[0]!.name).toBe('acme-cloud-resource-map.json');
    expect(screen.getByTestId('crm-map-summary').textContent).toContain('1 resource');
  });
});

describe('<RegenerateMcpButton>', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('POSTs /mcp-configs/regenerate and surfaces { regenerated, hash }', async () => {
    const { calls } = installFetchMock((call) => {
      if (call.url.endsWith('/mcp-configs/regenerate') && call.method === 'POST') {
        return new Response(
          JSON.stringify({
            regenerated: true,
            mcp_config: {
              id: 'mc-1',
              mcp_snapshot: { mcpServers: {} },
              env_snapshot: { keys: [] },
              generated_at: '2026-05-21T10:00:00Z',
            },
            hash: 'abc123def456' + '0'.repeat(52),
          }),
          { status: 200 },
        );
      }
      return new Response('{}');
    });
    render(<RegenerateMcpButton orgSlug="acme" scope={{ kind: 'org' }} variant={null} />);
    fireEvent.click(screen.getByTestId('regen-mcp-button'));
    await flushAsync();
    expect(calls.find((c) => c.url.endsWith('/mcp-configs/regenerate'))).toBeDefined();
    expect(screen.getByTestId('regen-mcp-summary').textContent).toContain('regenerated');
    expect(screen.getByTestId('regen-mcp-summary').textContent).toContain('abc123def456');
  });

  it('shows "unchanged (no-op)" when the server returns { regenerated: false }', async () => {
    installFetchMock((call) => {
      if (call.url.endsWith('/mcp-configs/regenerate') && call.method === 'POST') {
        return new Response(
          JSON.stringify({
            regenerated: false,
            mcp_config: { id: 'mc-1', generated_at: '2026-05-21T10:00:00Z' },
            hash: '0'.repeat(64),
          }),
          { status: 200 },
        );
      }
      return new Response('{}');
    });
    render(<RegenerateMcpButton orgSlug="acme" scope={{ kind: 'org' }} variant={null} />);
    fireEvent.click(screen.getByTestId('regen-mcp-button'));
    await flushAsync();
    expect(screen.getByTestId('regen-mcp-summary').textContent).toContain('unchanged');
  });

  it('surfaces a 403 (admin-only) as an error', async () => {
    installFetchMock(() => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }));
    render(<RegenerateMcpButton orgSlug="acme" scope={{ kind: 'org' }} variant={null} />);
    fireEvent.click(screen.getByTestId('regen-mcp-button'));
    await flushAsync();
    expect(screen.getByTestId('regen-mcp-error').textContent).toContain('forbidden');
  });
});
