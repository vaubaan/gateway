'use client';

/**
 * RingGrid — visual composer for capability sets, project-aware.
 *
 * Spec : docs/spec/gateway-capability-model.md §2 (rings), §3 (notation).
 *
 * Renders one card per provider present in the project's bindings, each
 * with the plane(s) and their concentric levels. For every (plane,level)
 * the user toggles R / W ; for env-scoped levels they pick one or more
 * env slugs (multi-select chips drawn from the bindings + known catalog
 * envs + free input).
 *
 * The composed capability set is emitted as an array of notation strings
 * (`provider:level:action@env` short form when the provider has a single
 * plane, `provider:plane/level:action@env` otherwise). Levels with an action picked but
 * no env selected (when env-scoped) are emitted env-less, with a UI hint
 * that explains the *fan-out* implication for writes (spec §5.1 #3).
 */

import { useMemo, useState } from 'react';
// Direct path import (not the package barrel) so the client bundle stays
// free of the Node-only `argon2` dep that `@vaubaan/shared` re-exports.
import { formatCapability, parseCapability } from '@vaubaan/shared/capability';
import { Badge, Card, CardBody, CardHeader, CardTitle, Code } from '@/components/ui';
import {
  PROVIDER_CATALOG,
  type Action,
  type LevelDescriptor,
  type PlaneDescriptor,
  type ProviderDescriptor,
} from './ring-catalog';

function ringLabel(rank: number): string {
  return `ring ${rank}`;
}

export interface RingGridBindings {
  /** provider_bindings rows of the project (any provider). */
  rows: Array<{ provider: string; resource_ref: string; environment: string | null }>;
  /** Registered SSH host slugs (per-project ssh_bindings). */
  sshHosts: string[];
}

export interface RingGridProps {
  bindings: RingGridBindings;
  /** Already-selected caps as notation strings (controlled). */
  value: string[];
  onChange: (caps: string[]) => void;
}

// ─── Internal state model ────────────────────────────────────────────────────
//
// One cell per (provider, plane, level) :
//   - action : 'read' | 'write' | null
//   - envs   : selected env slugs (env-less when array empty AND no envs ever
//              available for this level).
type CellKey = `${string}/${string}/${string}`;
interface CellState {
  action: Action | null;
  envs: string[];
}
type CellMap = Record<CellKey, CellState>;

function cellKey(p: string, plane: string, level: string): CellKey {
  return `${p}/${plane}/${level}`;
}

// Notation building/parsing delegates to @vaubaan/shared so we emit the short
// form (`provider:level:action@env`) for single-plane providers, and accept
// either form on input.
function buildNotation(p: string, plane: string, level: string, action: Action, env?: string) {
  return formatCapability(
    env ? { provider: p, plane, level, action, env } : { provider: p, plane, level, action },
  );
}

function parseNotation(s: string) {
  try {
    return parseCapability(s);
  } catch {
    return null;
  }
}

/** Build initial cell state from a current `value` array. */
function valueToCells(value: readonly string[]): { cells: CellMap; orphans: string[] } {
  const cells: CellMap = {};
  const orphans: string[] = [];
  for (const s of value) {
    const p = parseNotation(s);
    if (!p) {
      orphans.push(s);
      continue;
    }
    const key = cellKey(p.provider, p.plane, p.level);
    const existing = cells[key] ?? { action: null, envs: [] };
    // If the existing action conflicts with this notation's action, we
    // can't represent both R and W on the same cell — fall back to orphan
    // (the cap remains in the set via the orphan list, the UI flags it).
    if (existing.action && existing.action !== p.action) {
      orphans.push(s);
      continue;
    }
    existing.action = p.action;
    if (p.env && !existing.envs.includes(p.env)) existing.envs.push(p.env);
    cells[key] = existing;
  }
  return { cells, orphans };
}

/** Compute the caps that the cells encode. Each cell emits :
 *   - 1 cap per env when envs[] is non-empty,
 *   - 1 env-less cap when envs[] is empty (level env-scoped → fan-out warning shown).
 */
function cellsToValue(cells: CellMap, catalog: readonly ProviderDescriptor[]): string[] {
  const out: string[] = [];
  for (const provider of catalog) {
    for (const plane of provider.planes) {
      for (const level of plane.levels) {
        const c = cells[cellKey(provider.slug, plane.slug, level.slug)];
        if (!c?.action) continue;
        if (c.envs.length === 0) {
          out.push(buildNotation(provider.slug, plane.slug, level.slug, c.action));
        } else {
          for (const env of c.envs) {
            out.push(buildNotation(provider.slug, plane.slug, level.slug, c.action, env));
          }
        }
      }
    }
  }
  return out;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function RingGrid({ bindings, value, onChange }: RingGridProps) {
  const initial = useMemo(() => valueToCells(value), [value]);
  const [cells, setCells] = useState<CellMap>(initial.cells);

  // Which providers to show : those bound on the project, plus any
  // capability the user has already in `value` (so orphans/free-text
  // additions still surface their grid).
  const usedProviders = useMemo(() => {
    const set = new Set<string>(bindings.rows.map((b) => b.provider));
    if (bindings.sshHosts.length > 0) set.add('ssh');
    for (const k of Object.keys(cells)) {
      const provider = k.split('/')[0]!;
      set.add(provider);
    }
    return set;
  }, [bindings, cells]);

  const visibleProviders = PROVIDER_CATALOG.filter((p) => usedProviders.has(p.slug));

  function update(next: CellMap) {
    setCells(next);
    const emitted = cellsToValue(next, PROVIDER_CATALOG);
    // Preserve orphans the user typed in the free-text field.
    const orphanSet = new Set(initial.orphans);
    onChange([...emitted, ...orphanSet]);
  }

  function toggleAction(p: string, plane: string, level: string, action: Action) {
    const key = cellKey(p, plane, level);
    const cur = cells[key] ?? { action: null, envs: [] };
    const next: CellMap = { ...cells };
    if (cur.action === action) {
      // Untoggle this ring — don't cascade off the outer rings (the operator
      // might want to keep them granted).
      next[key] = { ...cur, action: null };
    } else {
      // Set/swap : cascade to all *outer* rings (lower rank) of the same plane
      // that are currently OFF. The blast invariant says granting the inner
      // ring already implies the outer ones, so we tick them too with the
      // same envs as the trigger ring (operator can fine-tune by untoggling).
      next[key] = { ...cur, action };
      const planeDesc = PROVIDER_CATALOG.find((pp) => pp.slug === p)?.planes.find(
        (pl) => pl.slug === plane,
      );
      const triggerRank = planeDesc?.levels.find((l) => l.slug === level)?.rank;
      if (planeDesc && triggerRank !== undefined) {
        const newEnvs = cur.envs.length > 0 ? cur.envs : (next[key]?.envs ?? []);
        for (const outer of planeDesc.levels) {
          if (outer.rank < triggerRank) {
            const k = cellKey(p, plane, outer.slug);
            const existing = next[k] ?? { action: null, envs: [] };
            if (existing.action === null) {
              next[k] = { action, envs: [...newEnvs] };
            }
          }
        }
      }
    }
    update(next);
  }

  function toggleEnv(p: string, plane: string, level: string, env: string) {
    const key = cellKey(p, plane, level);
    const cur = cells[key] ?? { action: null, envs: [] };
    const envs = cur.envs.includes(env) ? cur.envs.filter((e) => e !== env) : [...cur.envs, env];
    update({ ...cells, [key]: { ...cur, envs } });
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <DocCard />
      {visibleProviders.map((p) => (
        <ProviderCard
          key={p.slug}
          provider={p}
          bindings={bindings}
          cells={cells}
          onToggleAction={(plane, level, action) => toggleAction(p.slug, plane, level, action)}
          onToggleEnv={(plane, level, env) => toggleEnv(p.slug, plane, level, env)}
        />
      ))}
      {visibleProviders.length === 0 && (
        <p style={{ color: 'var(--text-subtle)' }}>
          No providers bound to this project yet. Bind a resource first, or type a custom capability
          below.
        </p>
      )}
    </div>
  );
}

// ─── Subcomponents ───────────────────────────────────────────────────────────

function DocCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>How to read this</CardTitle>
      </CardHeader>
      <CardBody style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', lineHeight: 1.5 }}>
        <p style={{ marginTop: 0 }}>
          A capability is a 5-tuple <Code>provider:plane/level:action@env</Code>. Pick R or W on
          each ring you need ; for env-scoped rings also pick one or more envs. Toggle nothing to
          leave a ring out of the token.
        </p>
        <ul style={{ paddingLeft: 'var(--space-4)', margin: 0 }}>
          <li>
            Each <strong>plane</strong> is a fortress of concentric <strong>rings</strong>.{' '}
            <strong>ring 1</strong> is the outer wall (the living data — code, rows, builds).{' '}
            <strong>ring N</strong> is the keep at the center (account, credentials, install
            tokens). Writing an inner ring forces every outer ring to obey — blast grows inward.
          </li>
          <li>
            <strong>R</strong> = read (observe), <strong>W</strong> = write (mutate). No
            propose/apply/provision — those collapse into write + a more or less exposed env.
          </li>
          <li>
            <strong>env</strong> = which instance (a Vercel target, a Supabase project, a git
            branch, an SSH host). Env-less caps cover the data when it has no env dimension ;
            env-less <em>writes</em> on env-scoped rings (e.g. Vercel all-environments env var) are{' '}
            <strong>fan-outs</strong> — the policy defaults treat them like the strictest env
            covered.
          </li>
          <li>
            The policy on the project decides at mint time what each requested cap resolves to :{' '}
            <strong style={{ color: 'var(--accent-success-fg)' }}>allow</strong>,{' '}
            <strong style={{ color: 'var(--accent-warning-fg)' }}>confirm</strong> (Telegram / UI),
            or <strong style={{ color: 'var(--accent-danger-fg)' }}>deny</strong>.
          </li>
        </ul>
      </CardBody>
    </Card>
  );
}

function ProviderCard({
  provider,
  bindings,
  cells,
  onToggleAction,
  onToggleEnv,
}: {
  provider: ProviderDescriptor;
  bindings: RingGridBindings;
  cells: CellMap;
  onToggleAction: (plane: string, level: string, action: Action) => void;
  onToggleEnv: (plane: string, level: string, env: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {provider.displayName}{' '}
          <Code style={{ marginLeft: 'var(--space-2)' }}>{provider.slug}</Code>
        </CardTitle>
        <span style={{ color: 'var(--text-subtle)', fontSize: 13 }}>
          {bindingsForProvider(bindings, provider.slug)} binding(s)
        </span>
      </CardHeader>
      <CardBody>
        {provider.planes.map((plane) => (
          <PlaneBlock
            key={plane.slug}
            provider={provider.slug}
            plane={plane}
            envs={envsForPlane(bindings, provider.slug, plane)}
            cells={cells}
            onToggleAction={onToggleAction}
            onToggleEnv={onToggleEnv}
          />
        ))}
      </CardBody>
    </Card>
  );
}

function PlaneBlock({
  provider,
  plane,
  envs,
  cells,
  onToggleAction,
  onToggleEnv,
}: {
  provider: string;
  plane: PlaneDescriptor;
  envs: string[];
  cells: CellMap;
  onToggleAction: (plane: string, level: string, action: Action) => void;
  onToggleEnv: (plane: string, level: string, env: string) => void;
}) {
  return (
    <div style={{ marginBottom: 'var(--space-3)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 'var(--space-2)',
          marginBottom: 'var(--space-2)',
        }}
      >
        <strong>plane</strong>
        <Code>{plane.slug}</Code>
        <span style={{ color: 'var(--text-subtle)', fontSize: 13 }}>{plane.description}</span>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <thead>
          <tr style={{ color: 'var(--text-subtle)', fontSize: 12, textAlign: 'left' }}>
            <th style={{ padding: '6px 8px', width: 100 }}>ring</th>
            <th style={{ padding: '6px 8px', width: 180 }}>level</th>
            <th style={{ padding: '6px 8px', width: 110 }}>R / W</th>
            <th style={{ padding: '6px 8px' }}>env</th>
          </tr>
        </thead>
        <tbody>
          {[...plane.levels]
            .sort((a, b) => a.rank - b.rank)
            .map((level) => {
              const c = cells[cellKey(provider, plane.slug, level.slug)] ?? {
                action: null,
                envs: [],
              };
              return (
                <tr key={level.slug} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                  <td
                    style={{
                      padding: '8px',
                      color: 'var(--text-subtle)',
                      verticalAlign: 'top',
                      fontWeight: 600,
                    }}
                  >
                    {ringLabel(level.rank)}
                  </td>
                  <td style={{ padding: '8px', verticalAlign: 'top' }}>
                    <Code>{level.slug}</Code>
                    <div style={{ color: 'var(--text-subtle)', fontSize: 12, marginTop: 4 }}>
                      {level.description}
                    </div>
                  </td>
                  <td style={{ padding: '8px', verticalAlign: 'top' }}>
                    <RWToggle
                      action={c.action}
                      onClick={(a) => onToggleAction(plane.slug, level.slug, a)}
                    />
                  </td>
                  <td style={{ padding: '8px', verticalAlign: 'top' }}>
                    {level.envScoped ? (
                      <EnvPicker
                        hint={plane.envHint}
                        envs={envs}
                        selected={c.envs}
                        disabled={!c.action}
                        onToggle={(env) => onToggleEnv(plane.slug, level.slug, env)}
                      />
                    ) : (
                      <span style={{ color: 'var(--text-subtle)', fontSize: 12 }}>env-less</span>
                    )}
                    {c.action === 'write' && level.envScoped && c.envs.length === 0 && (
                      <div style={{ marginTop: 'var(--space-2)' }}>
                        <Badge tone="warning">env-less write = fan-out (touches every env)</Badge>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
        </tbody>
      </table>
    </div>
  );
}

function RWToggle({
  action,
  onClick,
}: {
  action: Action | null;
  onClick: (action: Action) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      <button
        type="button"
        onClick={() => onClick('read')}
        style={{
          padding: '4px 10px',
          background: action === 'read' ? 'var(--accent-success-bg)' : 'var(--surface-base)',
          color: action === 'read' ? 'var(--accent-success-fg)' : 'var(--text-muted)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 4,
          cursor: 'pointer',
          fontSize: 13,
          fontWeight: action === 'read' ? 600 : 400,
        }}
      >
        R
      </button>
      <button
        type="button"
        onClick={() => onClick('write')}
        style={{
          padding: '4px 10px',
          background: action === 'write' ? 'var(--accent-warning-bg)' : 'var(--surface-base)',
          color: action === 'write' ? 'var(--accent-warning-fg)' : 'var(--text-muted)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 4,
          cursor: 'pointer',
          fontSize: 13,
          fontWeight: action === 'write' ? 600 : 400,
        }}
      >
        W
      </button>
    </div>
  );
}

function EnvPicker({
  hint,
  envs,
  selected,
  disabled,
  onToggle,
}: {
  hint: string;
  envs: string[];
  selected: string[];
  disabled: boolean;
  onToggle: (env: string) => void;
}) {
  const [custom, setCustom] = useState('');
  const all = Array.from(new Set([...envs, ...selected]));
  return (
    <div style={{ opacity: disabled ? 0.4 : 1 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {all.length === 0 && (
          <span style={{ color: 'var(--text-subtle)', fontSize: 12 }}>
            (no env yet — type one below)
          </span>
        )}
        {all.map((env) => {
          const on = selected.includes(env);
          return (
            <button
              type="button"
              key={env}
              onClick={() => !disabled && onToggle(env)}
              disabled={disabled}
              style={{
                padding: '2px 8px',
                background: on ? 'var(--accent-info-bg)' : 'var(--surface-base)',
                color: on ? 'var(--accent-info-fg)' : 'var(--text-muted)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 999,
                cursor: disabled ? 'not-allowed' : 'pointer',
                fontSize: 12,
                fontFamily: 'var(--font-geist-mono)',
              }}
            >
              @{env}
            </button>
          );
        })}
      </div>
      <input
        type="text"
        placeholder={hint}
        value={custom}
        disabled={disabled}
        onChange={(e) => setCustom(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && custom.trim()) {
            e.preventDefault();
            onToggle(custom.trim());
            setCustom('');
          }
        }}
        style={{
          marginTop: 4,
          width: '100%',
          padding: 4,
          background: 'var(--surface-base)',
          color: 'var(--text-default)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 4,
          fontSize: 12,
          fontFamily: 'var(--font-geist-mono)',
        }}
      />
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function bindingsForProvider(bindings: RingGridBindings, provider: string): number {
  if (provider === 'ssh') return bindings.sshHosts.length;
  return bindings.rows.filter((b) => b.provider === provider).length;
}

function envsForPlane(
  bindings: RingGridBindings,
  provider: string,
  plane: PlaneDescriptor,
): string[] {
  // SSH : envs = host slugs.
  if (provider === 'ssh') return bindings.sshHosts;
  // Supabase : env per binding row.
  if (provider === 'supabase') {
    const fromBindings = bindings.rows
      .filter((b) => b.provider === 'supabase')
      .map((b) => b.environment)
      .filter((e): e is string => !!e);
    return Array.from(new Set([...plane.knownEnvs, ...fromBindings]));
  }
  // GitHub / Vercel / Railway : the catalog already has the canonical set.
  return [...plane.knownEnvs];
}

// Re-exported for ssh-bindings count in the page.
export type { LevelDescriptor };
