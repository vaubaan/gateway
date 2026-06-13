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

/** Per-provider terminology for the env dimension. Avoids "env" everywhere when
 *  the operator actually picks a branch (github), a target (vercel), a host
 *  (bash/ssh) — the concept-naming gap was a clarity bug. */
function envLabel(providerSlug: string): { column: string; plural: string } {
  switch (providerSlug) {
    case 'github':
      return { column: 'branch', plural: 'branches' };
    case 'vercel':
      return { column: 'target', plural: 'targets' };
    case 'supabase':
      return { column: 'env', plural: 'envs' };
    case 'bash':
    case 'ssh':
      return { column: 'host', plural: 'hosts' };
    case 'railway':
      return { column: 'env', plural: 'envs' };
    default:
      return { column: 'env', plural: 'envs' };
  }
}

export interface RingGridBindings {
  /** provider_bindings rows of the project (any provider). The optional
   *  `env_less_exclude_branch` / `env_less_exclude_protected` fields are
   *  github-only ; they describe what an env-less write grant *won't* touch
   *  on that binding (cf. spec §5.1 — fan-out can be narrowed per binding). */
  rows: Array<{
    provider: string;
    resource_ref: string;
    environment: string | null;
    env_less_exclude_branch?: string | null;
    env_less_exclude_protected?: boolean | null;
  }>;
  /** Registered Bash host slugs (per-project bash bindings). */
  bashHosts: string[];
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
//   - read  : grant the read capability on this level.
//   - write : grant the write capability on this level.
//   - envs  : selected env slugs (shared between R and W ; empty = env-less
//             which means *fan-out* in the runtime — covers any env unless the
//             binding declares an exclude list).
//
// R and W are independent on purpose : the policy engine treats them as two
// distinct capabilities (no implicit ladder), so an operator who wants both
// must grant both. The UI helps by auto-ticking R when W goes on (the common
// case ; almost any write also needs a readback).
type CellKey = `${string}/${string}/${string}`;
interface CellState {
  read: boolean;
  write: boolean;
  envs: string[];
}
type CellMap = Record<CellKey, CellState>;

function emptyCell(): CellState {
  return { read: false, write: false, envs: [] };
}

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
    const existing = cells[key] ?? emptyCell();
    if (p.action === 'read') existing.read = true;
    if (p.action === 'write') existing.write = true;
    if (p.env && !existing.envs.includes(p.env)) existing.envs.push(p.env);
    cells[key] = existing;
  }
  return { cells, orphans };
}

/** Compute the caps that the cells encode. Each cell emits up to 2 actions ×
 *  (envs.length || 1) caps. Empty envs[] = env-less = fan-out at runtime. */
function cellsToValue(cells: CellMap, catalog: readonly ProviderDescriptor[]): string[] {
  const out: string[] = [];
  const ACTIONS: readonly Action[] = ['read', 'write'];
  for (const provider of catalog) {
    for (const plane of provider.planes) {
      for (const level of plane.levels) {
        const c = cells[cellKey(provider.slug, plane.slug, level.slug)];
        if (!c) continue;
        for (const action of ACTIONS) {
          if (!c[action]) continue;
          if (c.envs.length === 0) {
            out.push(buildNotation(provider.slug, plane.slug, level.slug, action));
          } else {
            for (const env of c.envs) {
              out.push(buildNotation(provider.slug, plane.slug, level.slug, action, env));
            }
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
    if (bindings.bashHosts.length > 0) set.add('bash');
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
    const cur = cells[key] ?? emptyCell();
    const next: CellMap = { ...cells };

    if (cur[action]) {
      // Untoggle just this action ; leave its sibling and outer rings alone
      // (operator's choice — they may still want the read after dropping write).
      next[key] = { ...cur, [action]: false };
      update(next);
      return;
    }

    // Toggle on. Writes auto-tick read on the same cell : the runtime treats
    // R and W as independent capabilities, so a write-only grant is almost
    // always useless (no readback). Operator can untick R after if they want
    // strict write-only.
    const newCell: CellState = { ...cur, [action]: true };
    if (action === 'write') newCell.read = true;
    next[key] = newCell;

    // Cascade to all *outer* rings (lower rank) of the same plane that are
    // currently entirely off. Blast invariant : the inner ring is the keep ;
    // granting it implies the outer walls. Cascaded outer rings inherit R+W
    // when the trigger is write, R-only when the trigger is read.
    const planeDesc = PROVIDER_CATALOG.find((pp) => pp.slug === p)?.planes.find(
      (pl) => pl.slug === plane,
    );
    const triggerRank = planeDesc?.levels.find((l) => l.slug === level)?.rank;
    if (planeDesc && triggerRank !== undefined) {
      const newEnvs = cur.envs.length > 0 ? cur.envs : newCell.envs;
      for (const outer of planeDesc.levels) {
        if (outer.rank < triggerRank) {
          const k = cellKey(p, plane, outer.slug);
          const existing = next[k] ?? emptyCell();
          if (!existing.read && !existing.write) {
            next[k] = { read: true, write: action === 'write', envs: [...newEnvs] };
          }
        }
      }
    }
    update(next);
  }

  function toggleEnv(p: string, plane: string, level: string, env: string) {
    const key = cellKey(p, plane, level);
    const cur = cells[key] ?? emptyCell();
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
  const excludeSummary = excludeSummaryFor(bindings, provider.slug);
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
            excludeSummary={excludeSummary}
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
  excludeSummary,
  cells,
  onToggleAction,
  onToggleEnv,
}: {
  provider: string;
  plane: PlaneDescriptor;
  envs: string[];
  /** Per-binding exclude descriptions for fan-out warnings (github only for
   *  now). Undefined / empty array → no exclusion known. */
  excludeSummary: readonly string[];
  cells: CellMap;
  onToggleAction: (plane: string, level: string, action: Action) => void;
  onToggleEnv: (plane: string, level: string, env: string) => void;
}) {
  const envLbl = envLabel(provider);
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
            <th style={{ padding: '6px 8px' }}>{envLbl.column}</th>
          </tr>
        </thead>
        <tbody>
          {[...plane.levels]
            .sort((a, b) => a.rank - b.rank)
            .map((level) => {
              const c = cells[cellKey(provider, plane.slug, level.slug)] ?? emptyCell();
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
                      read={c.read}
                      write={c.write}
                      onClick={(a) => onToggleAction(plane.slug, level.slug, a)}
                    />
                  </td>
                  <td style={{ padding: '8px', verticalAlign: 'top' }}>
                    {level.envScoped ? (
                      <EnvPicker
                        hint={plane.envHint}
                        envs={envs}
                        selected={c.envs}
                        disabled={!c.read && !c.write}
                        onToggle={(env) => onToggleEnv(plane.slug, level.slug, env)}
                      />
                    ) : (
                      <span style={{ color: 'var(--text-subtle)', fontSize: 12 }}>env-less</span>
                    )}
                    {(c.read || c.write) && level.envScoped && c.envs.length === 0 && (
                      <div style={{ marginTop: 'var(--space-2)' }}>
                        <FanOutWarning
                          envLabelPlural={envLbl.plural}
                          hasWrite={c.write}
                          excludeSummary={excludeSummary}
                        />
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

function FanOutWarning({
  envLabelPlural,
  hasWrite,
  excludeSummary,
}: {
  envLabelPlural: string;
  hasWrite: boolean;
  excludeSummary: readonly string[];
}) {
  const tone = hasWrite ? 'warning' : 'info';
  const base = `aucun ${envLabelPlural === 'envs' ? 'env' : envLabelPlural.replace(/s$/, '')} coché = ${hasWrite ? 'écrit sur' : 'lit'} TOUS les ${envLabelPlural} (fan-out)`;
  return (
    <div>
      <Badge tone={tone}>{base}</Badge>
      {excludeSummary.length > 0 && (
        <div
          style={{
            marginTop: 4,
            color: 'var(--text-subtle)',
            fontSize: 12,
          }}
        >
          sauf, par binding : {excludeSummary.join(' · ')}
        </div>
      )}
    </div>
  );
}

function RWToggle({
  read,
  write,
  onClick,
}: {
  read: boolean;
  write: boolean;
  onClick: (action: Action) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      <button
        type="button"
        onClick={() => onClick('read')}
        title={
          read
            ? 'Read granted — click to remove'
            : 'Click to grant read. Required for almost any write to be useful.'
        }
        style={{
          padding: '4px 10px',
          background: read ? 'var(--accent-success-bg)' : 'var(--surface-base)',
          color: read ? 'var(--accent-success-fg)' : 'var(--text-muted)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 4,
          cursor: 'pointer',
          fontSize: 13,
          fontWeight: read ? 600 : 400,
        }}
      >
        R
      </button>
      <button
        type="button"
        onClick={() => onClick('write')}
        title={
          write
            ? 'Write granted — click to remove (read stays on, untoggle separately).'
            : 'Click to grant write. Read is auto-ticked (untoggle separately if you really want write-only).'
        }
        style={{
          padding: '4px 10px',
          background: write ? 'var(--accent-warning-bg)' : 'var(--surface-base)',
          color: write ? 'var(--accent-warning-fg)' : 'var(--text-muted)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 4,
          cursor: 'pointer',
          fontSize: 13,
          fontWeight: write ? 600 : 400,
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
  if (provider === 'bash') return bindings.bashHosts.length;
  return bindings.rows.filter((b) => b.provider === provider).length;
}

function envsForPlane(
  bindings: RingGridBindings,
  provider: string,
  plane: PlaneDescriptor,
): string[] {
  // Bash : envs = host slugs.
  if (provider === 'bash') return bindings.bashHosts;
  // Supabase : envs come strictly from the bindings — no a-priori catalog
  // suggestion (we used to surface 'staging'/'prod' as defaults, but they were
  // misleading whenever the operator bound a project with a different env slug
  // or no env slug at all). Empty when no env-named binding exists.
  if (provider === 'supabase') {
    const fromBindings = bindings.rows
      .filter((b) => b.provider === 'supabase')
      .map((b) => b.environment)
      .filter((e): e is string => !!e);
    return Array.from(new Set(fromBindings));
  }
  // GitHub / Vercel / Railway : the catalog already has the canonical set.
  return [...plane.knownEnvs];
}

/** Build a per-binding summary of what env-less grants will NOT touch.
 *  Github-only for now ; other providers return []. */
function excludeSummaryFor(bindings: RingGridBindings, provider: string): string[] {
  if (provider !== 'github') return [];
  const out: string[] = [];
  for (const b of bindings.rows) {
    if (b.provider !== 'github') continue;
    const parts: string[] = [];
    if (b.env_less_exclude_branch) parts.push(`@${b.env_less_exclude_branch}`);
    if (b.env_less_exclude_protected) parts.push('protected branches');
    if (parts.length > 0) out.push(`${b.resource_ref} → ${parts.join(', ')}`);
  }
  return out;
}

// Re-exported for bash-bindings count in the page.
export type { LevelDescriptor };
