import { describe, expect, test } from 'vitest';
import type { McpToolDeclaration, ProviderBinding } from '@vauban/shared';
import {
  injectionPlanFor,
  mergeInjectedArgs,
  stripInjectedArgs,
} from '../../src/scope-injection.ts';

const ghBinding: ProviderBinding = {
  id: 'b-gh',
  project_id: 'p1',
  provider: 'github',
  resource_ref: 'acme/app',
  display_name: null,
  created_at: '2026-01-01',
};

const vercelBinding: ProviderBinding = {
  id: 'b-v',
  project_id: 'p1',
  provider: 'vercel',
  resource_ref: 'prj_xxx',
  display_name: null,
  created_at: '2026-01-01',
};

const supaBinding: ProviderBinding = {
  id: 'b-s',
  project_id: 'p1',
  provider: 'supabase',
  resource_ref: 'abcdefghijklmnopqrst',
  display_name: null,
  created_at: '2026-01-01',
};

describe('injectionPlanFor', () => {
  test('github: owner + repo from owner/repo binding', () => {
    expect(injectionPlanFor('github', { bindings: [ghBinding] })).toEqual({
      owner: 'acme',
      repo: 'app',
    });
  });

  test('vercel: projectId + teamId (when admin has team_id)', () => {
    expect(
      injectionPlanFor('vercel', { bindings: [vercelBinding], vercelTeamId: 'team_z' }),
    ).toEqual({ projectId: 'prj_xxx', teamId: 'team_z' });
  });

  test('supabase: project_ref', () => {
    expect(injectionPlanFor('supabase', { bindings: [supaBinding] })).toEqual({
      project_ref: 'abcdefghijklmnopqrst',
    });
  });

  test('null when zero bindings for the provider', () => {
    expect(injectionPlanFor('github', { bindings: [] })).toBeNull();
  });

  test('null when 2+ bindings for the provider (ambiguous)', () => {
    expect(
      injectionPlanFor('github', { bindings: [ghBinding, { ...ghBinding, id: 'b2' }] }),
    ).toBeNull();
  });

  test('github: malformed binding resource_ref → null', () => {
    expect(
      injectionPlanFor('github', { bindings: [{ ...ghBinding, resource_ref: 'no-slash' }] }),
    ).toBeNull();
  });
});

describe('stripInjectedArgs', () => {
  const baseTool: McpToolDeclaration = {
    name: 'github__list_branches',
    description: '',
    inputSchema: {
      type: 'object',
      properties: { owner: {}, repo: {}, per_page: {} },
      required: ['owner', 'repo'],
    },
  };

  test('removes injected keys from properties + required', () => {
    const out = stripInjectedArgs(baseTool, { owner: 'acme', repo: 'app' });
    expect(out.inputSchema.properties).toEqual({ per_page: {} });
    expect(out.inputSchema.required).toEqual([]);
  });

  test('keeps the tool intact when nothing is injected', () => {
    const out = stripInjectedArgs(baseTool, {});
    expect(out.inputSchema.properties).toEqual({ owner: {}, repo: {}, per_page: {} });
  });

  test('does not mutate the input tool', () => {
    const out = stripInjectedArgs(baseTool, { owner: 'a', repo: 'b' });
    expect(baseTool.inputSchema.properties).toEqual({ owner: {}, repo: {}, per_page: {} });
    expect(out).not.toBe(baseTool);
  });
});

describe('mergeInjectedArgs', () => {
  test('fills missing args', () => {
    expect(mergeInjectedArgs({ branch: 'feature/x' }, { owner: 'acme', repo: 'app' })).toEqual({
      branch: 'feature/x',
      owner: 'acme',
      repo: 'app',
    });
  });

  test('caller-provided values take precedence (admin override)', () => {
    expect(
      mergeInjectedArgs({ owner: 'other', repo: 'app' }, { owner: 'acme', repo: 'app' }),
    ).toEqual({ owner: 'other', repo: 'app' });
  });

  test('empty string is treated as missing (auto-filled)', () => {
    expect(mergeInjectedArgs({ owner: '' }, { owner: 'acme' })).toEqual({ owner: 'acme' });
  });
});
