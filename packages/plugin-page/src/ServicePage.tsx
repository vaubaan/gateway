/**
 * The page of a service, drawn from its plugin, in the "Atlas" layout (website
 * spec §2.3, sections 1–8 in order): the header, the model, the macro-actions,
 * the map, a few calls, Anything else, the tools, the retired permissions,
 * connecting an account. Everything comes from the page data of
 * `page-data.ts` over `PluginInfo` (`info.ts`). The public site renders it at
 * `/plugins/<id>` and adds its health and links sections; the gateway renders it
 * at `/reference/<id>` for the plugin version it runs (gateway spec §4.2). What
 * only an app knows comes in through the props: where a link of the page goes
 * (`href`, `sourceHref`), what is above the title (`crumbs`) and beside it
 * (`titleAside`), more of the counts line (`meta`), the app's own sections after
 * connecting (`sections`) and the foot (`footer`). Nothing of either app is
 * written here.
 *
 * Static HTML, complete without scripts (spec §2.6): the trust level, the
 * environment and the shape of the key are CSS-only radio groups — every
 * state is in the DOM, the radios placed before what they switch so the
 * style sheet shows one state with `:checked ~` (`plugin-page.css`). Every
 * permission has an anchor `#risk-<id>`, every macro-action `#macro-<id>`:
 * the gateway's other pages link to them. Imports are relative so the unit
 * tests render it.
 */
import { Fragment, type ReactNode } from 'react';

import {
  GATE_WORDS,
  REASON_WORDS,
  ROW_LABEL,
  ROW_WORDS,
  TREE_LEGEND,
  TRUST_LEVEL_BUDGET_FACTOR,
  TRUST_LEVEL_HINTS,
  TRUST_LEVEL_LABELS,
  TRUST_LEVELS,
  type Row,
  type TrustLevel,
} from '@vaubaan/policy-engine';

import type { ConnectStepInfo, CredentialInfo, LevelBudgets, PluginInfo } from './info';
import { Gate, Info, Mono, ServiceMark } from './marks';
import {
  ALTERNATIVES_LEGEND,
  anythingElseSentence,
  BROKER_ADMIN_TITLE,
  BROKER_DOC,
  brokerAdminSentences,
  callsOf,
  capitalise,
  callWords,
  carefulGateOf,
  cellSuffix,
  CARDINALITY_MARKS,
  CARDINALITY_WORDS,
  CONNECT_ANCHOR,
  connectKindBadge,
  connectKindCode,
  connectSentences,
  countsOf,
  DAY_NOTE,
  expiryText,
  GIT_REMOTE_SENTENCE,
  grantsHeading,
  LEFT_OUT_SENTENCE,
  ledeOf,
  levelHeading,
  listWords,
  MACRO_ACTIONS_SENTENCE,
  macroActionsTitle,
  mapOf,
  modelOf,
  MODEL_SENTENCE,
  plural,
  retiredOf,
  RETIRED_SENTENCE,
  sectionNumbers,
  toolsCount,
  toolsIntro,
  type CellValue,
  type MapChip,
  type MapView,
  type ModelNode,
} from './page-data';

/** Where a link of the page goes: a path of the documentation site (`/docs/…`, `/plugins/<id>`) → its address in the app. */
export type HrefOf = (path: string) => string;

const SAME: HrefOf = (path) => path;

/** The anchor of a permission, from its unqualified id (`risk-github.read-code`): the gateway's pages link to it. */
export function riskAnchorOf(riskId: string): string {
  return `risk-${riskId}`;
}

/** The anchor of a macro-action (`macro-read`). */
export function macroAnchorOf(actionId: string): string {
  return `macro-${actionId}`;
}

/** The levels of the page's headings: the title's, then one under it for the sections, two for their parts. */
type Depth = 0 | 1;

function H({
  depth,
  level,
  id,
  children,
}: {
  depth: Depth;
  level: 1 | 2 | 3;
  id?: string;
  children: ReactNode;
}) {
  const n = level + depth;
  if (n === 1) return <h1 id={id}>{children}</h1>;
  if (n === 2) return <h2 id={id}>{children}</h2>;
  if (n === 3) return <h3 id={id}>{children}</h3>;
  return <h4 id={id}>{children}</h4>;
}

/**
 * A sentence carrying `code` spans, and with `links` `[links](/path)`: the
 * only markup the page data holds (a catalog's reason quotes a path between
 * backticks; the site's own sentences link a page).
 */
export function Inline({
  text,
  links = true,
  href = SAME,
}: {
  text: string;
  links?: boolean;
  /** Where a link's path goes in the app rendering the page. */
  href?: HrefOf;
}) {
  const parts = text.split(links ? /(`[^`]+`|\[[^\]]+\]\([^)]+\))/g : /(`[^`]+`)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
          return <Mono key={i}>{part.slice(1, -1)}</Mono>;
        }
        const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
        if (link) {
          return (
            <a key={i} href={href(link[2]!)}>
              {link[1]}
            </a>
          );
        }
        return <Fragment key={i}>{part}</Fragment>;
      })}
    </>
  );
}

/** What every part of the page reads from the app: its heading depth and where links go. */
interface Ctx {
  readonly depth: Depth;
  readonly href: HrefOf;
  /** The address of a file of the repository (`plugins/github/src/examples.ts`); `null`: not linked. */
  readonly sourceHref: ((path: string) => string) | null;
}

function Section({
  id,
  n,
  kicker,
  title,
  children,
  before,
  depth,
}: {
  id: string;
  n: number;
  depth: Depth;
  kicker: string;
  title: ReactNode;
  children: ReactNode;
  /** What must precede the heading: the radios of a CSS-only toggle. */
  before?: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="pp-s">
      {before}
      <p className="pp-k">
        {n} · {kicker}
      </p>
      <H depth={depth} level={2} id={`${id}-title`}>
        {title}
      </H>
      {children}
    </section>
  );
}

/** The short id of a trust level in the classes the style sheet switches (`l-c`). */
const LEVEL_KEY: Readonly<Record<TrustLevel, string>> = {
  careful: 'c',
  trusting: 't',
  autonomous: 'a',
};

// ── 1 · The model ────────────────────────────────────────────────────────────

function Marks({ marks }: { marks: readonly string[] }) {
  return (
    <span className="pp-cm">
      {marks.map((m) => (
        <i key={m}>{m}</i>
      ))}
    </span>
  );
}

function EnvTags({ envs }: { envs: readonly string[] }) {
  return (
    <span className="pp-envs">
      {envs.map((e) => (
        <span key={e} className="pp-env">
          {e}
        </span>
      ))}
    </span>
  );
}

function Entity({
  node,
  depth,
  envs,
  envLive,
}: {
  node: ModelNode;
  depth: number;
  envs: readonly string[];
  /** The catalog names environments: a carrier is drawn with them; else dashed, in the model only. */
  envLive: boolean;
}) {
  const info = <Info label={node.name} text={node.description} />;
  const carrier = node.carriesEnv ? (envLive ? 'carrier' : 'envlike') : '';
  const ghost = node.touched ? '' : 'ghost';
  if (node.children.length === 0 && depth > 0) {
    return (
      <span className={['pp-lf', carrier, ghost].filter(Boolean).join(' ')}>
        {node.name} <Marks marks={node.marks} />
        {info}
      </span>
    );
  }
  const leaves = node.children.filter((c) => c.children.length === 0);
  const boxes = node.children.filter((c) => c.children.length > 0);
  return (
    <div
      className={['pp-bx', node.resource ? 'res' : '', carrier, ghost].filter(Boolean).join(' ')}
    >
      <div className="pp-hd">
        <b>{node.name}</b>
        <Marks marks={node.marks} />
        {node.resource && <span className="pp-lbl">Resource</span>}
        {node.carriesEnv && envLive && <EnvTags envs={envs} />}
        {info}
      </div>
      {leaves.length > 0 && (
        <div className="pp-chain">
          {leaves.map((c) => (
            <Entity key={c.name} node={c} depth={depth + 1} envs={envs} envLive={envLive} />
          ))}
        </div>
      )}
      {boxes.length > 0 && (
        <div className="pp-kids">
          {boxes.map((c) => (
            <Entity key={c.name} node={c} depth={depth + 1} envs={envs} envLive={envLive} />
          ))}
        </div>
      )}
    </div>
  );
}

function ModelSection({ plugin, n, ctx }: { plugin: PluginInfo; n: number; ctx: Ctx }) {
  const model = modelOf(plugin);
  const envLive = model.envs.length > 0;
  return (
    <Section
      id="model"
      n={n}
      depth={ctx.depth}
      kicker="The model"
      title={`How ${plugin.name} is modelled`}
    >
      <p className="pp-intro">
        {model.counts} {MODEL_SENTENCE}
      </p>
      <div className="pp-acct" role="img" aria-label={model.label}>
        {model.account && (
          <p className="pp-tagline">
            <b>Account</b> <span>{model.account}</span>
          </p>
        )}
        <div className={`pp-planes p${Math.min(model.planes.length, 4)}`}>
          {model.planes.map((plane) => (
            <div key={plane.slug} className="pp-plane">
              <p className="pp-ptag">
                <b>
                  Plane · <code>{plane.slug}</code>
                </b>
                {plane.description && (
                  <span>
                    <Inline text={plane.description} links={false} />
                  </span>
                )}
              </p>
              <div className="pp-roots">
                {plane.roots.map((root, i) => (
                  <div key={root.name} className={i === 0 ? 'pp-root main' : 'pp-root'}>
                    <Entity node={root} depth={0} envs={model.envs} envLive={envLive} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <p className="pp-legend">
        {(['one', 'bounded', 'unbounded'] as const).map((c) => (
          <span key={c}>
            <Marks marks={[CARDINALITY_MARKS[c]]} /> {CARDINALITY_WORDS[c]}
          </span>
        ))}
        <span>
          <span className="pp-sw res" aria-hidden="true" /> the resource
        </span>
        <span>
          <span className={envLive ? 'pp-sw env' : 'pp-sw env none'} aria-hidden="true" /> carries
          the environment{model.envInModelOnly ? ', in the model only' : ''}
        </span>
        {model.someUntouched && (
          <span>
            <span className="pp-sw ghost" aria-hidden="true" /> no tool touches it
          </span>
        )}
      </p>
      <div className="pp-defs">
        <div className="pp-def">
          <H depth={ctx.depth} level={3}>
            Account
          </H>
          <p>{model.account ?? `One account is one account to ${plugin.name}.`}</p>
        </div>
        <div className="pp-def">
          <H depth={ctx.depth} level={3}>
            Resource
          </H>
          <p>{model.resource ?? ''}</p>
        </div>
        <div className="pp-def wide">
          <H depth={ctx.depth} level={3}>
            Environment
          </H>
          <dl>
            <dt>Rule</dt>
            <dd>{model.environmentRule}</dd>
            <dt>Known</dt>
            <dd>{model.envs.length > 0 ? <EnvTags envs={model.envs} /> : 'none'}</dd>
            <dt>Carried by</dt>
            <dd>
              {model.carriers.length > 0 ? (
                <>
                  {model.carriers.map((c, i) => (
                    <Fragment key={c}>
                      {i > 0 && ', '}
                      <code>{c}</code>
                    </Fragment>
                  ))}
                  {model.envInModelOnly ? ', in the model only' : ''}
                </>
              ) : (
                'nothing in the model'
              )}
            </dd>
          </dl>
          {model.environmentNotes.map((note) => (
            <p key={note}>
              <Inline text={note} links={false} />
            </p>
          ))}
        </div>
      </div>
    </Section>
  );
}

// ── 2 · Macro-actions ────────────────────────────────────────────────────────

function MacroActionsSection({ plugin, n, ctx }: { plugin: PluginInfo; n: number; ctx: Ctx }) {
  const count = Math.min(Math.max(plugin.macroActions.length, 1), 5);
  return (
    <Section
      id="macro-actions"
      n={n}
      depth={ctx.depth}
      kicker="Macro-actions"
      title={macroActionsTitle(plugin)}
    >
      <p className="pp-intro">{MACRO_ACTIONS_SENTENCE}</p>
      <ol className={`pp-strip n${count}`}>
        {plugin.macroActions.map((action, i) => (
          <li
            key={action.id}
            id={macroAnchorOf(action.id)}
            className="pp-vc"
            data-macro-action={action.id}
          >
            <span className="pp-n">{i + 1}</span>
            <H depth={ctx.depth} level={3}>
              {action.label}
            </H>
            <p className="pp-ds">{action.description}</p>
            {action.narrative && (
              <p className="pp-nv">
                <Inline text={action.narrative} links={false} />
              </p>
            )}
            <p className="pp-ct">{plural(action.entries.length, 'permission', 'permissions')}</p>
          </li>
        ))}
      </ol>
    </Section>
  );
}

// ── 3 · The map ──────────────────────────────────────────────────────────────

/** The class of a value: switched by the trust level, and by the environment when it has one. */
function valueClass(value: CellValue, envIndex: (env: string) => number): string {
  const level = `l-${LEVEL_KEY[value.level]}`;
  return value.env === null ? `q ${level}` : `qe ${level} e-${envIndex(value.env)}`;
}

function Chip({
  chip,
  envIndex,
  anchor,
}: {
  chip: MapChip;
  envIndex: (env: string) => number;
  /** This chip carries the permission's anchor (`#risk-<id>`). */
  anchor: boolean;
}) {
  // A chip of some environments only is shown when one of them is chosen (`eo`); a chip
  // the catalog refuses there is dashed (`pref`) when one of them is chosen.
  const envs = chip.envs ?? [...new Set(chip.values.flatMap((v) => (v.env ? [v.env] : [])))];
  const classes = [
    'pp-ch',
    ...(chip.envs !== null ? ['eo'] : []),
    ...(chip.refused ? ['pref'] : []),
    ...(chip.envs !== null || chip.refused ? envs.map((e) => `e-${envIndex(e)}`) : []),
  ];
  return (
    <li
      id={anchor ? riskAnchorOf(chip.riskId) : undefined}
      className={classes.join(' ')}
      data-risk-id={chip.riskId}
      data-row={chip.row}
      data-envs={chip.envs?.join(' ')}
    >
      <p className="pp-cl">
        {chip.label}
        {chip.rowReason && <span className="pp-why"> {REASON_WORDS[chip.rowReason]}</span>}
        <Info label="Why it sits here" text={chip.reason} code={chip.riskId} />
      </p>
      <p className="pp-cv">
        {chip.values.map((value) => (
          <span key={`${value.level}/${value.env ?? ''}`} className={valueClass(value, envIndex)}>
            <Gate gate={value.gate} />
            {cellSuffix(value)}
          </span>
        ))}
      </p>
    </li>
  );
}

/**
 * The chip that carries each permission's anchor: its first in the map's order
 * (rows worst first, then macro-actions) shown before anyone toggles, so a link
 * to `#risk-<id>` lands on something visible.
 */
function anchoredChips(map: MapView): ReadonlySet<MapChip> {
  const seen = new Set<string>();
  const anchored = new Set<MapChip>();
  const firstEnv = map.envs[0];
  for (const row of map.rows) {
    for (const cell of row.cells) {
      for (const chip of cell) {
        const shown = chip.envs === null || firstEnv === undefined || chip.envs.includes(firstEnv);
        if (!shown || seen.has(chip.riskId)) continue;
        seen.add(chip.riskId);
        anchored.add(chip);
      }
    }
  }
  return anchored;
}

function MapSection({ plugin, n, ctx }: { plugin: PluginInfo; n: number; ctx: Ctx }) {
  const map = mapOf(plugin);
  const anchored = anchoredChips(map);
  const envIndex = (env: string): number => map.envs.indexOf(env);
  const radios = (
    <>
      {TRUST_LEVELS.map((level, i) => (
        <input
          key={level}
          className="sr"
          type="radio"
          name="trust-level"
          id={`lvl-${LEVEL_KEY[level]}`}
          defaultChecked={i === 0}
        />
      ))}
      {map.envs.map((env, i) => (
        <input
          key={env}
          className="sr"
          type="radio"
          name="map-env"
          id={`env-${i}`}
          defaultChecked={i === 0}
        />
      ))}
    </>
  );
  return (
    <Section id="map" n={n} depth={ctx.depth} kicker="The map" title="The map" before={radios}>
      <p className="pp-intro">
        {map.introLead}
        {map.envs.length > 0 && (
          <>
            {' '}
            (
            {map.envs.map((env, i) => (
              <span key={env} className={`et e-${i}`}>
                <code>
                  {plugin.id}[{env}].…
                </code>
              </span>
            ))}
            )
          </>
        )}
        {map.introTail}
      </p>
      <div className="pp-bar">
        <fieldset>
          <legend>Trust level</legend>
          {TRUST_LEVELS.map((level) => (
            <label key={level} htmlFor={`lvl-${LEVEL_KEY[level]}`}>
              {TRUST_LEVEL_LABELS[level]} <small>×{TRUST_LEVEL_BUDGET_FACTOR[level]}</small>
            </label>
          ))}
        </fieldset>
        {map.envs.length > 0 && (
          <fieldset className="pp-envf">
            <legend>Environment</legend>
            {map.envs.map((env, i) => (
              <label key={env} htmlFor={`env-${i}`}>
                {env}
              </label>
            ))}
          </fieldset>
        )}
        <p className="pp-key">
          {(['free', 'ask', 'off'] as const).map((g) => (
            <span key={g}>
              <Gate gate={g} /> {GATE_WORDS[g]}
            </span>
          ))}
        </p>
        <p className="pp-lvdesc">
          {TRUST_LEVELS.map((level) => (
            <span key={level} className={`q l-${LEVEL_KEY[level]}`}>
              {TRUST_LEVEL_HINTS[level]}
            </span>
          ))}
        </p>
      </div>
      <p className="pp-dtree">{TREE_LEGEND}</p>
      <div
        className="pp-gridwrap"
        role="region"
        aria-label={`${plugin.name} permissions by macro-action and row`}
        tabIndex={0}
      >
        <table className={`pp-grid c${Math.min(map.columns.length, 6)}`}>
          <caption className="sr">
            {plugin.name} permissions by macro-action and row of the tree, with what the chosen
            trust level does and the quota a day
          </caption>
          <thead>
            <tr>
              <th scope="col">
                <span>{ROW_LABEL}</span>
              </th>
              {map.columns.map((c) => (
                <th scope="col" key={c.id}>
                  <b>{c.label}</b>
                  <span>{c.description}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {map.rows.map((row) => (
              <tr key={row.row} className={`r-${row.row}`} data-row={row.row}>
                <th scope="row">
                  <span className="pp-rw">{row.word}</span>
                  <p>{row.gates}</p>
                </th>
                {row.cells.map((cell, i) => (
                  <td key={map.columns[i]?.id ?? i}>
                    {cell.length > 0 ? (
                      <ul className="pp-chips">
                        {cell.map((chip) => (
                          <Chip
                            key={`${chip.riskId}/${chip.envs?.join() ?? ''}`}
                            chip={chip}
                            envIndex={envIndex}
                            anchor={anchored.has(chip)}
                          />
                        ))}
                      </ul>
                    ) : (
                      <p className="pp-empty">None</p>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="pp-sum">
        {map.sums.map((sum) => (
          <span
            key={`${sum.level}/${sum.env ?? ''}`}
            className={
              sum.env === null
                ? `q l-${LEVEL_KEY[sum.level]}`
                : `qe l-${LEVEL_KEY[sum.level]} e-${envIndex(sum.env)}`
            }
          >
            {sum.text}{' '}
          </span>
        ))}
        {DAY_NOTE}
      </p>
      {map.notes.length > 0 && <p className="pp-foot">{map.notes.join(' ')}</p>}
    </Section>
  );
}

// ── 4 · A few calls ──────────────────────────────────────────────────────────

function CallsSection({ plugin, n, ctx }: { plugin: PluginInfo; n: number; ctx: Ctx }) {
  const calls = callsOf(plugin);
  const labels = new Map(plugin.risks.map((r) => [r.id, r.label]));
  const href =
    plugin.examplesSource && ctx.sourceHref ? ctx.sourceHref(plugin.examplesSource) : null;
  return (
    <Section
      id="examples"
      n={n}
      depth={ctx.depth}
      kicker="A few calls"
      title="A few calls, classified by the plugin"
    >
      <p className="pp-intro">
        {calls.intro}
        {href && calls.total > 0 && (
          <>
            {' '}
            <a href={href}>{calls.linkLabel}</a>.
          </>
        )}
      </p>
      {calls.rows.length > 0 && (
        <div className="table-wrap">
          <table className="pp-tbl ex">
            <thead>
              <tr>
                <th scope="col">The call</th>
                <th scope="col">The plugin sees</th>
                <th scope="col">The catalog answers</th>
                <th scope="col">A {TRUST_LEVEL_LABELS.careful} mission</th>
              </tr>
            </thead>
            <tbody>
              {calls.rows.map((e) => (
                <tr key={`${e.tool}#${e.sample}`}>
                  <td>
                    <Mono>{callWords(e)}</Mono>
                  </td>
                  <td>
                    <ul className="plain">
                      {e.slices.map((s, i) => (
                        <li key={i}>
                          <Mono quiet>{s}</Mono>
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td>
                    <ul className="plain">
                      {e.permissions.map((id) => (
                        <li key={id}>
                          {labels.get(id) ?? id} <Mono quiet>{id}</Mono>
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td>
                    <Gate gate={carefulGateOf(e)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

// ── 5 · Anything else ────────────────────────────────────────────────────────

function LevelCells({ levels }: { levels: LevelBudgets }) {
  return (
    <>
      {TRUST_LEVELS.map((level) => {
        const line = levels[level];
        return (
          <td key={level} data-level={level}>
            <Gate gate={line.gateWord} />
            {line.gateWord === 'off' ? '' : ` · ${line.quota.toLocaleString('en-US')} a day`}
          </td>
        );
      })}
    </>
  );
}

function RowTag({ row }: { row: Row }) {
  return (
    <span className={`pp-rowtag r-${row}`} data-row={row}>
      {ROW_WORDS[row]}
    </span>
  );
}

function AnythingElseSection({ plugin, n, ctx }: { plugin: PluginInfo; n: number; ctx: Ctx }) {
  const risks = new Map(plugin.risks.map((r) => [r.id, r]));
  const fallback = plugin.anythingElse?.entries ?? [];
  return (
    <Section
      id="anything-else"
      n={n}
      depth={ctx.depth}
      kicker="Anything else"
      title="Anything else"
    >
      <p className="pp-intro">
        <Inline text={anythingElseSentence(plugin)} links={false} />
      </p>
      {fallback.length > 0 && (
        <div className="table-wrap">
          <table className="pp-tbl">
            <thead>
              <tr>
                <th scope="col">Permission</th>
                <th scope="col">{ROW_LABEL}</th>
                {TRUST_LEVELS.map((level) => (
                  <th scope="col" key={level}>
                    {levelHeading(level)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {fallback.map((entry) => {
                const risk = risks.get(entry.riskId);
                return (
                  <tr
                    key={entry.riskId}
                    id={riskAnchorOf(entry.riskId)}
                    data-risk-id={entry.riskId}
                  >
                    <td>
                      {risk?.label ?? entry.riskId}
                      {risk && <Info label="Why it sits here" text={risk.reason} code={risk.id} />}
                    </td>
                    <td>
                      {risk && <RowTag row={risk.row} />}
                      {risk?.rowReason && (
                        <span className="pp-why"> {REASON_WORDS[risk.rowReason]}</span>
                      )}
                    </td>
                    <LevelCells levels={entry.levels} />
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {plugin.excludedTools.length > 0 && (
        <>
          <p>{LEFT_OUT_SENTENCE}</p>
          <ul className="pp-plain">
            {plugin.excludedTools.map((tool) => (
              <li key={tool.name}>
                <Mono>{tool.name}</Mono>: <Inline text={tool.reason} links={false} />
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

// ── 6 · Tools ────────────────────────────────────────────────────────────────

function ToolsSection({ plugin, n, ctx }: { plugin: PluginInfo; n: number; ctx: Ctx }) {
  return (
    <Section id="tools" n={n} depth={ctx.depth} kicker="Tools" title="Tools">
      <p className="pp-intro">
        {plugin.tools.length === 0 ? 'This plugin exposes no tool yet.' : toolsIntro(plugin)}
      </p>
      {plugin.tools.length > 0 && (
        <>
          <p className="pp-tcount">{toolsCount(plugin)}</p>
          <div
            className="pp-tscroll"
            role="region"
            aria-label={plural(plugin.tools.length, 'tool', 'tools')}
            tabIndex={0}
          >
            <table className="pp-tbl tools">
              <thead>
                <tr>
                  <th scope="col">Tool</th>
                  <th scope="col">What it does</th>
                  <th scope="col">Usually touches</th>
                </tr>
              </thead>
              <tbody>
                {plugin.tools.map((tool) => (
                  <tr key={tool.name}>
                    <td>
                      <Mono>{tool.name}</Mono>
                    </td>
                    <td>{tool.title ?? tool.description}</td>
                    <td>
                      {tool.touches.map((id, i) => (
                        <Fragment key={id}>
                          {i > 0 && ', '}
                          <Mono quiet>{id}</Mono>
                        </Fragment>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {plugin.gitRemote && (
        <p>
          <Inline text={GIT_REMOTE_SENTENCE} href={ctx.href} />
        </p>
      )}
    </Section>
  );
}

// ── 8 · Connecting an account ────────────────────────────────────────────────

function Scopes({ scopes }: { scopes: readonly string[] }) {
  return (
    <ul className="scopes">
      {scopes.map((s) => (
        <li key={s}>
          <Mono>{s}</Mono>
        </li>
      ))}
    </ul>
  );
}

/** The menus to follow at the service, as highlighted chips: "Settings", "Developer settings". */
function GuidePath({ path, service }: { path: readonly string[]; service: string }) {
  return (
    <span className="path" aria-label={`Where to click at ${service}`}>
      {path.map((segment, i) => (
        <span key={`${i}:${segment}`} className="path-seg">
          {segment}
        </span>
      ))}
    </span>
  );
}

function Step({ step, service }: { step: ConnectStepInfo; service: string }) {
  return (
    <li>
      {step.path.length > 0 && <GuidePath path={step.path} service={service} />}
      <span className="step-do">{step.do}</span>
      {step.url && (
        <>
          {' '}
          (<a href={step.url}>open</a>)
        </>
      )}
      {step.code && (
        <>
          {' '}
          <Mono>{step.code}</Mono>
        </>
      )}
      {step.figure && (
        <figure className="shot">
          <img src={step.figure.src} alt={step.figure.alt} loading="lazy" />
          <figcaption>{step.figure.attribution}</figcaption>
        </figure>
      )}
    </li>
  );
}

function Steps({ steps, service }: { steps: readonly ConnectStepInfo[]; service: string }) {
  return (
    <ol className="steps">
      {steps.map((step, i) => (
        <Step key={`${i}:${step.do}`} step={step} service={service} />
      ))}
    </ol>
  );
}

/** Two to four shapes of the key: a CSS-only toggle, each panel its own steps then the shared ones. */
function Alternatives({ credential: c, service }: { credential: CredentialInfo; service: string }) {
  return (
    <div className="pp-alts">
      {c.alternatives.map((alt, i) => (
        <input
          key={alt.id}
          className="sr"
          type="radio"
          name="key-shape"
          id={`alt-${i}`}
          defaultChecked={i === 0}
        />
      ))}
      <div className="pp-bar pp-altbar">
        <fieldset>
          <legend>{ALTERNATIVES_LEGEND}</legend>
          {c.alternatives.map((alt, i) => (
            <label key={alt.id} htmlFor={`alt-${i}`}>
              {alt.label}
            </label>
          ))}
        </fieldset>
      </div>
      <div className="pp-altpanels">
        {c.alternatives.map((alt, i) => (
          <div key={alt.id} className={`pp-altpanel alt-${i}`} data-alternative={alt.id}>
            {alt.help && <p className="pp-althelp">{alt.help}</p>}
            <Steps steps={[...alt.steps, ...c.steps]} service={service} />
          </div>
        ))}
      </div>
    </div>
  );
}

function PastedKey({ plugin, credential: c }: { plugin: PluginInfo; credential: CredentialInfo }) {
  const service = plugin.name;
  return (
    <>
      {c.reach && (
        <div className="pp-reach">
          <b>{c.reach.what}</b>
          <p>
            <strong>{c.reach.grant}</strong>. {c.reach.why}
          </p>
        </div>
      )}
      {c.alternatives.length > 0 ? (
        <Alternatives credential={c} service={service} />
      ) : (
        c.steps.length > 0 && <Steps steps={c.steps} service={service} />
      )}
      {c.permissions.length > 0 && (
        <div className="table-wrap">
          <table className="pp-tbl perms">
            <thead>
              <tr>
                <th scope="col">{grantsHeading(service)}</th>
                <th scope="col">Access</th>
              </tr>
            </thead>
            <tbody>
              {c.permissions.map((p) => (
                <tr key={p.name}>
                  <td>{p.name}</td>
                  <td>{p.access}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <dl className="facts pp-facts">
        {c.createUrl && (
          <>
            <dt>Where</dt>
            <dd>
              <a href={c.createUrl}>{c.createUrl}</a>
            </dd>
          </>
        )}
        {c.expiry && (
          <>
            <dt>Expiry</dt>
            <dd>{capitalise(expiryText(c.expiry))}</dd>
          </>
        )}
        {c.fields.length > 0 && (
          <>
            <dt>The connect page asks</dt>
            <dd>{listWords(c.fields.map((f) => `${f.label}${f.secret ? ' (secret)' : ''}`))}</dd>
          </>
        )}
        {c.docsUrl && (
          <>
            <dt>The service&apos;s documentation</dt>
            <dd>
              <a href={c.docsUrl}>{c.docsUrl}</a>
            </dd>
          </>
        )}
        {plugin.manualRevocation && (
          <>
            <dt>Disconnecting</dt>
            <dd>{plugin.manualRevocation}</dd>
          </>
        )}
      </dl>
    </>
  );
}

function ConnectBlock({
  plugin,
  credential: c,
  ctx,
}: {
  plugin: PluginInfo;
  credential: CredentialInfo;
  ctx: Ctx;
}) {
  return (
    <div className="connect" data-client-source={c.clientSource}>
      <p className="connect-kind">
        <span className="connect-badge">{connectKindBadge(c)}</span>{' '}
        <small>{c.label ?? connectKindCode(c)}</small>
      </p>
      {c.clientSource === 'broker' && (
        <aside className="connect-admin" aria-labelledby={`connect-admin-${plugin.id}`}>
          <H depth={ctx.depth} level={3} id={`connect-admin-${plugin.id}`}>
            {BROKER_ADMIN_TITLE}
          </H>
          {brokerAdminSentences(c, plugin.name).map((s) => (
            <p key={s}>
              <Inline text={s} href={ctx.href} />
            </p>
          ))}
          <dl className="facts">
            <dt>OAuth provider</dt>
            <dd>
              <Mono>{c.brokerProvider ?? ''}</Mono>
            </dd>
            <dt>Scopes asked</dt>
            <dd>
              <Scopes scopes={c.scopes} />
            </dd>
          </dl>
          <p>
            <a href={ctx.href(BROKER_DOC)}>Your own OAuth broker</a>
          </p>
        </aside>
      )}
      {connectSentences(c, plugin.name).map((s) => (
        <p key={s} className="pp-intro">
          <Inline text={s} href={ctx.href} />
        </p>
      ))}
      {c.clientSource === 'gateway-registered' && c.scopes.length > 0 && (
        <dl className="facts">
          <dt>Scopes asked</dt>
          <dd>
            <Scopes scopes={c.scopes} />
          </dd>
        </dl>
      )}
      {c.clientSource === 'pasted-key' ? (
        <PastedKey plugin={plugin} credential={c} />
      ) : (
        plugin.manualRevocation && (
          <dl className="facts pp-facts">
            <dt>Disconnecting</dt>
            <dd>{plugin.manualRevocation}</dd>
          </dl>
        )
      )}
    </div>
  );
}

// ── The page ─────────────────────────────────────────────────────────────────

/** A section an app adds after connecting an account (the site: health, links); numbered on. */
export interface ServicePageSection {
  readonly id: string;
  readonly kicker: string;
  readonly title: ReactNode;
  readonly body: ReactNode;
}

export interface ServicePageProps {
  readonly plugin: PluginInfo;
  /** The level of the service's name: 1 where the page is the document (the site), 2 under an app's own title (the gateway's Reference). */
  readonly titleLevel?: 1 | 2;
  /** Where a link of the page goes: its paths are the documentation site's (`/docs/…`). The site keeps them; the gateway resolves them under `docs.url`. */
  readonly href?: HrefOf;
  /** The address of a file of the repository, to link the examples' source; none: not linked. */
  readonly sourceHref?: ((path: string) => string) | null;
  /** Above the title: the site's crumbs. */
  readonly crumbs?: ReactNode;
  /** After the title: the gateway's (i) to the docs. */
  readonly titleAside?: ReactNode;
  /** More of the counts line, after the counts (the site: the gateways running the plugin). */
  readonly meta?: readonly string[];
  /** The app's own sections after connecting an account, numbered on. */
  readonly sections?: readonly ServicePageSection[];
  /** Under the last section (the site: when it changed, its Markdown twin). */
  readonly footer?: ReactNode;
}

export function ServicePage({
  plugin,
  titleLevel = 1,
  href = SAME,
  sourceHref = null,
  crumbs,
  titleAside,
  meta = [],
  sections = [],
  footer,
}: ServicePageProps) {
  const n = sectionNumbers(plugin);
  const numberOf: Readonly<Record<string, number>> = sectionNumbers(
    plugin,
    sections.map((section) => section.id),
  );
  const retired = retiredOf(plugin);
  const ctx: Ctx = { depth: titleLevel === 1 ? 0 : 1, href, sourceHref };
  const counts = [...countsOf(plugin), ...meta];

  return (
    <div className="plugin-page" data-service={plugin.id}>
      <article>
        <header className="pp-hero">
          {crumbs && <p className="crumbs">{crumbs}</p>}
          <div className="pp-title">
            {plugin.icon && <ServiceMark path={plugin.icon} color={plugin.iconColor} />}
            <H depth={ctx.depth} level={1}>
              {plugin.name} <span className="version">{plugin.version}</span>
            </H>
            {titleAside}
          </div>
          <p className="lede">{ledeOf(plugin)}</p>
          <p className="pp-meta">
            Version <code>{plugin.version}</code> · {counts.join(' · ')}
          </p>
        </header>

        <ModelSection plugin={plugin} n={n.model} ctx={ctx} />
        <MacroActionsSection plugin={plugin} n={n['macro-actions']} ctx={ctx} />
        <MapSection plugin={plugin} n={n.map} ctx={ctx} />
        <CallsSection plugin={plugin} n={n.examples} ctx={ctx} />
        <AnythingElseSection plugin={plugin} n={n['anything-else']} ctx={ctx} />
        <ToolsSection plugin={plugin} n={n.tools} ctx={ctx} />

        {retired.length > 0 && (
          <Section
            id="retired"
            n={n.retired}
            depth={ctx.depth}
            kicker="Retired permissions"
            title="Retired permissions"
          >
            <p className="pp-intro">{RETIRED_SENTENCE}</p>
            <ul className="pp-plain">
              {retired.map((r) => (
                <li key={r.riskId} id={riskAnchorOf(r.riskId)} data-risk-id={r.riskId}>
                  {r.label} <Mono quiet>{r.riskId}</Mono>
                  {r.replacedBy && (
                    <>
                      : replaced by <Mono>{r.replacedBy}</Mono>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </Section>
        )}

        <Section
          id={CONNECT_ANCHOR}
          n={n.connect}
          depth={ctx.depth}
          kicker="Connecting an account"
          title="Connecting an account"
        >
          {plugin.credentials.map((c) => (
            <ConnectBlock key={c.kind + c.clientSource} plugin={plugin} credential={c} ctx={ctx} />
          ))}
        </Section>

        {sections.map((section) => (
          <Section
            key={section.id}
            id={section.id}
            n={numberOf[section.id] ?? 0}
            depth={ctx.depth}
            kicker={section.kicker}
            title={section.title}
          >
            {section.body}
          </Section>
        ))}

        {footer}
      </article>
    </div>
  );
}
