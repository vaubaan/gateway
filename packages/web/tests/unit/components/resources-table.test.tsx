/**
 * Unit tests for `<ResourceTable>` (resources-list-ui — Phase 4 wave B).
 *
 * Asserts the client-side filters (provider, kindClass, variant,
 * status) narrow the row set without re-fetching, and that badges
 * render with the spec §11.2 status taxonomy.
 *
 * jsdom env (`tests/unit/components/**` matched in vitest.config.ts).
 */

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

import { ResourceStatusBadge } from '@/components/resources/ResourceStatusBadge';
import { ResourceTable, type ResourceRow } from '@/components/resources/ResourceTable';

function makeRow(over: Partial<ResourceRow>): ResourceRow {
  return {
    id: 'r0',
    organization_id: 'org-1',
    project_id: null,
    provider_name: 'github',
    kind: 'github-org',
    scope: 'org',
    is_admin: false,
    name: 'r0',
    variant: null,
    status: 'pending',
    connection_status: 'unknown',
    connection_checked_at: null,
    connection_message: null,
    ...over,
  };
}

describe('<ResourceTable>', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the empty state when no rows match', () => {
    render(<ResourceTable orgSlug="acme" resources={[]} />);
    expect(screen.getByTestId('resource-table-empty')).toBeTruthy();
    expect(screen.getByTestId('resource-table-count').textContent).toBe('0 / 0');
  });

  it('renders one row per resource and links to the detail page', () => {
    const rows: ResourceRow[] = [
      makeRow({ id: 'a', name: 'gh', kind: 'github-org' }),
      makeRow({
        id: 'b',
        name: 'repo-a',
        kind: 'github-repo',
        scope: 'project',
        project_id: 'p1',
      }),
    ];
    render(<ResourceTable orgSlug="acme" resources={rows} />);
    expect(screen.getByTestId('resource-row-a')).toBeTruthy();
    expect(screen.getByTestId('resource-row-b')).toBeTruthy();
    const ghLink = screen.getByText('gh').closest('a');
    expect(ghLink?.getAttribute('href')).toBe('/orgs/acme/resources/a');
  });

  it('filters by provider', () => {
    const rows: ResourceRow[] = [
      makeRow({ id: 'a', provider_name: 'github', kind: 'github-org', name: 'gh' }),
      makeRow({ id: 'b', provider_name: 'vercel', kind: 'vercel-team', name: 'vc' }),
    ];
    render(<ResourceTable orgSlug="acme" resources={rows} />);
    const sel = screen.getByTestId<HTMLSelectElement>('filter-provider');
    fireEvent.change(sel, { target: { value: 'vercel' } });
    expect(screen.queryByTestId('resource-row-a')).toBeNull();
    expect(screen.getByTestId('resource-row-b')).toBeTruthy();
    expect(screen.getByTestId('resource-table-count').textContent).toBe('1 / 2');
  });

  it('filters by kindClass', () => {
    const rows: ResourceRow[] = [
      makeRow({ id: 'a', kind: 'github-org', name: 'gh', scope: 'org' }),
      makeRow({
        id: 'b',
        kind: 'github-repo',
        name: 'repo',
        scope: 'project',
        project_id: 'p',
      }),
      makeRow({
        id: 'c',
        kind: 'github-org-admin',
        name: 'admin',
        is_admin: true,
      }),
    ];
    render(<ResourceTable orgSlug="acme" resources={rows} />);
    fireEvent.change(screen.getByTestId('filter-kindClass'), {
      target: { value: 'project' },
    });
    expect(screen.queryByTestId('resource-row-a')).toBeNull();
    expect(screen.getByTestId('resource-row-b')).toBeTruthy();
    expect(screen.queryByTestId('resource-row-c')).toBeNull();
  });

  it('filters by variant', () => {
    const rows: ResourceRow[] = [
      makeRow({ id: 'a', variant: 'staging' }),
      makeRow({ id: 'b', variant: 'prod' }),
    ];
    render(<ResourceTable orgSlug="acme" resources={rows} />);
    fireEvent.change(screen.getByTestId('filter-variant'), {
      target: { value: 'prod' },
    });
    expect(screen.queryByTestId('resource-row-a')).toBeNull();
    expect(screen.getByTestId('resource-row-b')).toBeTruthy();
  });

  it('filters by status', () => {
    const rows: ResourceRow[] = [
      makeRow({ id: 'a', status: 'pending' }),
      makeRow({ id: 'b', status: 'active' }),
    ];
    render(<ResourceTable orgSlug="acme" resources={rows} />);
    fireEvent.change(screen.getByTestId('filter-status'), {
      target: { value: 'active' },
    });
    expect(screen.queryByTestId('resource-row-a')).toBeNull();
    expect(screen.getByTestId('resource-row-b')).toBeTruthy();
  });
});

describe('<ResourceStatusBadge>', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the success variant for active statuses', () => {
    const { container } = render(<ResourceStatusBadge label="active" />);
    const badge = container.querySelector('[data-testid="badge-active"]');
    expect(badge?.getAttribute('data-variant')).toBe('success');
  });

  it('falls back to the neutral variant for unknown labels', () => {
    const { container } = render(<ResourceStatusBadge label="weird" />);
    const badge = container.querySelector('[data-testid="badge-weird"]');
    expect(badge?.getAttribute('data-variant')).toBe('neutral');
  });

  it('renders the title attribute when provided', () => {
    render(<ResourceStatusBadge label="broken" title="auth expired" />);
    expect(screen.getByTestId('badge-broken').getAttribute('title')).toBe('auth expired');
  });
});
