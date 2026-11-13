/**
 * `/plugins/<id>` in the C3 layout (website spec §2.3, sections 1–8, in
 * order): the opening, the map, one spread per macro-action, the worked
 * examples, Anything else, a mission worked out, connecting an account, then
 * retired permissions, tools, health and links. Everything comes from the
 * page data of `content/plugin-page.ts`, the same the Markdown twin reads.
 *
 * Static HTML, complete without scripts (spec §2.6): the tool list is a
 * `<details>`. Imports are relative so the unit tests can render it.
 */
import { Fragment, type ReactNode } from 'react';

import { SEVERITY_LABEL, TRUST_LEVELS, TRUST_LEVEL_LABELS } from '@vaubaan/policy-engine';

import { gatewaysSentence, healthFootnote, NOT_READ } from '../../content/health';
import { WORKED_TRUST_LEVEL } from '../../content/plugin-examples';
import {
  BROKER_ADMIN_TITLE,
  BROKER_DOC,
  brokerAdminSentences,
  callWords,
  capitalise,
  carefulGateOf,
  CONNECT_ANCHOR,
  connectKindBadge,
  connectKindCode,
  connectSentences,
  DAY_NOTE,
  levelCellWords,
  levelHeadings,
  listWords,
  mapOf,
  missionOf,
  openingOf,
  PATH_SEPARATOR,
  retiredOf,
  spreadsOf,
  TOOLS_NOTE,
  type MapColumn,
  type MapRow,
  type Spread,
} from '../../content/plugin-page';
import {
  expiryWords,
  figureCells,
  GIT_REMOTE_SENTENCE,
  pluginLinks,
  validatedSentence,
  type PluginWithHealth,
} from '../../content/plugin-pages';
import type {
  ConnectStepInfo,
  CredentialInfo,
  LevelBudgets,
  PluginInfo,
} from '../../content/plugins';
import type { ValidationThresholds } from '../../content/thresholds';
import { FactCells, GateMark, Mono, PermissionBox, RiskWord, Tag } from './Codes';

/**
 * A sentence carrying `code` spans, and with `links` `[links](/path)`: the
 * only markup the page data holds (a catalog's reason quotes a path between
 * backticks; the site's own sentences link a page).
 */
export function Inline({ text, links = true }: { text: string; links?: boolean }) {
  const parts = text.split(links ? /(`[^`]+`|\[[^\]]+\]\([^)]+\))/g : /(`[^`]+`)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('`') && part.endsWith('`')) {
          return <Mono key={i}>{part.slice(1, -1)}</Mono>;
        }
        const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
        if (link) {
          return (
            <a key={i} href={link[2]}>
              {link[1]}
            </a>
          );
        }
        return <Fragment key={i}>{part}</Fragment>;
      })}
    </>
  );
}

function Section({
  id,
  title,
  children,
  className,
}: {
  id: string;
  title: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={className}>
      <h2 id={`${id}-title`}>{title}</h2>
      {children}
    </section>
  );
}

// ── 2 · The map ──────────────────────────────────────────────────────────────

function RowHeading({ row }: { row: MapRow }) {
  return (
    <th scope="row" className="map-row">
      <b>{capitalise(row.word)}</b>
      {row.sensitiveBy.length > 0 && <span>{row.sensitiveBy.join(', ')}</span>}
      <span>{row.levelsSentence}</span>
    </th>
  );
}

function MapTable({
  rows,
  columns,
  caption,
}: {
  rows: readonly MapRow[];
  columns: readonly MapColumn[];
  caption: string;
}) {
  return (
    <div className="table-wrap">
      <table className="map">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Undo</th>
            {columns.map((c) => (
              <th scope="col" key={c.id} className={c.byGateway ? 'map-gateway' : undefined}>
                {c.label}
                <span>
                  {c.count}
                  {c.byGateway ? ' · by the gateway' : ''}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.row} data-undo-row={row.word}>
              <RowHeading row={row} />
              {row.cells.map((cell, i) => (
                <td key={columns[i]?.id ?? i}>
                  {cell.length > 0 && (
                    <ul className="perms">
                      {cell.map((box) => (
                        <PermissionBox key={`${box.riskId}${box.envs.join()}`} box={box} />
                      ))}
                    </ul>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── 3 · Spreads ──────────────────────────────────────────────────────────────

function LevelCell({
  levels,
  level,
}: {
  levels: LevelBudgets;
  level: (typeof TRUST_LEVELS)[number];
}) {
  const { gate, quota } = levelCellWords(levels, level);
  return (
    <td className="level" data-level={level}>
      {gate !== 'free' && <GateMark gate={gate} />}
      {quota !== null && <span className="num">{quota}</span>}
    </td>
  );
}

function SpreadTable({ spread }: { spread: Spread }) {
  return (
    <div className="table-wrap">
      <table className="spread-table">
        <thead>
          <tr>
            <th scope="col">Permission · the six facts</th>
            <th scope="col">{SEVERITY_LABEL}</th>
            {spread.levelHeadings.map((h) => (
              <th scope="col" key={h.level}>
                {h.heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {spread.lines.map((line, i) => (
            <tr key={`${line.riskId}${line.env ?? ''}`} data-risk-id={line.riskId}>
              <td>
                <span className="perm-label">{line.label}</span> <Mono quiet>{line.riskId}</Mono>{' '}
                {line.env && <Tag>{line.env}</Tag>}
                {/* The reason once per permission: its other environments follow it. */}
                {spread.lines[i - 1]?.riskId !== line.riskId && (
                  <p className="reason">
                    <Inline text={line.reason} links={false} />
                  </p>
                )}
                <FactCells facts={line.facts} />
              </td>
              <td>
                <RiskWord level={line.severity} />
              </td>
              {TRUST_LEVELS.map((level) => (
                <LevelCell key={level} levels={line.levels} level={level} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SpreadSection({ spread, columns }: { spread: Spread; columns: readonly MapColumn[] }) {
  const column = columns.filter((c) => c.id === spread.id);
  return (
    <Section id={`do-${spread.id}`} title={spread.label} className="spread">
      <p className="spread-what">
        <Mono quiet>{spread.id}</Mono> — <Inline text={spread.description} links={false} />
      </p>
      {spread.narrative && (
        <p className="narrative">
          <Inline text={spread.narrative} links={false} />
        </p>
      )}
      <div className="spread-grid">
        <div className="spread-main">
          <SpreadTable spread={spread} />
          <p className="note">{spread.limitsNote}</p>
        </div>
        <aside aria-label={`${spread.label}, on the map`} className="spread-aside">
          <MapTable rows={spread.column} columns={column} caption={`${spread.label}, on the map`} />
        </aside>
      </div>
    </Section>
  );
}

// ── 7 · Connecting an account ────────────────────────────────────────────────

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

/** The menus to follow at the service, as highlighted chips: "Settings › Developer settings". */
function GuidePath({ path, service }: { path: readonly string[]; service: string }) {
  return (
    <span className="path" aria-label={`Where to click at ${service}`}>
      {path.map((segment, i) => (
        <Fragment key={`${i}:${segment}`}>
          {i > 0 && (
            <span className="path-sep" aria-hidden="true">
              {PATH_SEPARATOR}
            </span>
          )}
          <span className="path-seg">{segment}</span>
        </Fragment>
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

function ConnectBlock({
  plugin,
  credential: c,
}: {
  plugin: PluginInfo;
  credential: CredentialInfo;
}) {
  return (
    <div className="connect" data-client-source={c.clientSource}>
      <p className="connect-kind">
        <span className="connect-badge">{connectKindBadge(c)}</span>{' '}
        <Mono quiet>{connectKindCode(c)}</Mono>
      </p>
      {c.clientSource === 'broker' && (
        <aside className="connect-admin" aria-labelledby={`connect-admin-${plugin.id}`}>
          <h3 id={`connect-admin-${plugin.id}`}>{BROKER_ADMIN_TITLE}</h3>
          {brokerAdminSentences(c, plugin.name).map((sentence) => (
            <p key={sentence}>
              <Inline text={sentence} />
            </p>
          ))}
          <dl className="facts">
            <dt>Provider</dt>
            <dd>
              <Mono>{c.brokerProvider ?? ''}</Mono>
            </dd>
            <dt>Scopes asked</dt>
            <dd>
              <Scopes scopes={c.scopes} />
            </dd>
          </dl>
          <p>
            <a href={BROKER_DOC}>Your own OAuth broker</a>
          </p>
        </aside>
      )}
      {connectSentences(c, plugin.name).map((sentence) => (
        <p key={sentence}>
          <Inline text={sentence} />
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
      {c.clientSource === 'pasted-key' && <PastedKey credential={c} service={plugin.name} />}
      {plugin.manualRevocation && (
        <p>
          <strong>Disconnecting</strong>: {plugin.manualRevocation}
        </p>
      )}
    </div>
  );
}

function PastedKey({ credential: c, service }: { credential: CredentialInfo; service: string }) {
  return (
    <>
      {c.reach && (
        <p className="connect-reach">
          <strong>Grant it wide, once.</strong> {c.reach.what}: <strong>{c.reach.grant}</strong>.{' '}
          {c.reach.why}
        </p>
      )}
      {c.steps.length > 0 && (
        <ol className="steps">
          {c.steps.map((step) => (
            <Step key={step.do} step={step} service={service} />
          ))}
        </ol>
      )}
      {c.createUrl && (
        <p>
          Where: <a href={c.createUrl}>{c.createUrl}</a>
        </p>
      )}
      {c.permissions.length > 0 && (
        <ul className="grants">
          {c.permissions.map((p) => (
            <li key={p.name}>
              {p.name}: <strong>{p.access}</strong>{' '}
              <span className="quiet">
                for{' '}
                {p.tools.map((tool, i) => (
                  <Fragment key={tool}>
                    {i > 0 && ', '}
                    <Mono quiet>{tool}</Mono>
                  </Fragment>
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
      {c.expiry && <p>{expiryWords(c.expiry, (v) => v)}</p>}
      {c.fields.length > 0 && (
        <p>
          The connect page asks:{' '}
          {listWords(c.fields.map((f) => `${f.label}${f.secret ? ' (secret)' : ''}`))}.
        </p>
      )}
      {c.docsUrl && (
        <p>
          The service&apos;s documentation: <a href={c.docsUrl}>{c.docsUrl}</a>
        </p>
      )}
    </>
  );
}

// ── The page ─────────────────────────────────────────────────────────────────

export function PluginPageView({
  plugin,
  thresholds,
  lastModified,
}: {
  plugin: PluginWithHealth;
  thresholds: ValidationThresholds;
  lastModified?: string | null;
}) {
  const opening = openingOf(plugin);
  const map = mapOf(plugin);
  const spreads = spreadsOf(plugin, map);
  const mission = missionOf(plugin);
  const retired = retiredOf(plugin);
  const labels = new Map(plugin.risks.map((r) => [r.id, r.label]));
  const severities = new Map(plugin.risks.map((r) => [r.id, r.severity]));
  const fallback = plugin.anythingElse?.entries ?? [];
  const links = pluginLinks(plugin);
  const twin = links[links.length - 1]!;
  const health = plugin.health;

  return (
    <div className="page plugin-page">
      <article>
        {/* 1 · Opening */}
        <header className="opening">
          <p className="crumbs">
            <a href="/plugins">Plugins</a> / {plugin.name}
          </p>
          <h1>
            {opening.title} <span className="version">{plugin.version}</span>
          </h1>
          <p className="lede">
            The {plugin.name} plugin lets a Vaubaan Gateway mission use {plugin.name} without
            handing the agent a credential. {plugin.description}
          </p>
          <p className="verbs">{opening.verbs}</p>
          <ul className="counts">
            {opening.counts.map((c) => (
              <li key={c}>{c}</li>
            ))}
            <li>{gatewaysSentence(health, thresholds.windowDays)}</li>
          </ul>
          {plugin.summary && <p>{plugin.summary}</p>}
          <dl className="dimensions">
            {opening.dimensions.map((d) => (
              <Fragment key={d.term}>
                <dt>{d.term}</dt>
                <dd>
                  {capitalise(d.line)}
                  {d.term === 'Trust' && (
                    <ul>
                      {opening.levels.map((l) => (
                        <li key={l.label}>
                          <b>
                            {l.label} ×{l.factor}
                          </b>{' '}
                          — {l.hint}
                        </li>
                      ))}
                    </ul>
                  )}
                </dd>
              </Fragment>
            ))}
          </dl>
        </header>

        {/* 2 · The map */}
        <Section id="map" title="The map">
          <p>
            Columns are the macro-actions. Rows are the undo fact, the easy row split by what makes
            a permission sensitive: together they set the gate, and each row says what the trust
            levels do with it. The tint is the risk word.
          </p>
          <MapTable
            rows={map.rows}
            columns={map.columns}
            caption={`${plugin.name}: every permission by macro-action and undo`}
          />
          <p className="reading">Read it: {map.reading}</p>
        </Section>

        {/* 3 · One spread per macro-action */}
        {spreads.map((spread) => (
          <SpreadSection key={spread.id} spread={spread} columns={map.columns} />
        ))}

        {/* 4 · Worked examples */}
        <Section id="examples" title="Worked examples">
          {plugin.examples.length === 0 ? (
            <p>This plugin declares no example yet.</p>
          ) : (
            <>
              <p>
                The plugin&apos;s declared calls, run through its own classifier when this page was
                built: what it sees, the permissions the catalog answers, and what a{' '}
                {TRUST_LEVEL_LABELS[WORKED_TRUST_LEVEL]} mission does.
              </p>
              <div className="table-wrap">
                <table className="examples">
                  <thead>
                    <tr>
                      <th scope="col">The agent calls</th>
                      <th scope="col">The plugin sees</th>
                      <th scope="col">The catalog answers</th>
                      <th scope="col">A {TRUST_LEVEL_LABELS[WORKED_TRUST_LEVEL]} mission</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plugin.examples.map((e) => (
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
                          <GateMark gate={carefulGateOf(e)} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Section>

        {/* 5 · Anything else and the tools left out */}
        <Section id="anything-else" title={plugin.anythingElse?.label ?? 'Anything else'}>
          {fallback.length > 0 ? (
            <>
              <p>
                A call no permission covers touches{' '}
                {fallback.map((e, i) => (
                  <Fragment key={e.riskId}>
                    {i > 0 && ', '}
                    <Mono>{e.riskId}</Mono>
                  </Fragment>
                ))}{' '}
                instead of slipping through. No macro-action holds it; a person ticks it knowingly.
              </p>
              <div className="table-wrap">
                <table className="spread-table">
                  <thead>
                    <tr>
                      <th scope="col">Permission</th>
                      <th scope="col">{SEVERITY_LABEL}</th>
                      {levelHeadings().map((h) => (
                        <th scope="col" key={h.level}>
                          {h.heading}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {fallback.map((entry) => (
                      <tr key={entry.riskId}>
                        <td>
                          <span className="perm-label">{labels.get(entry.riskId)}</span>{' '}
                          <Mono quiet>{entry.riskId}</Mono>
                        </td>
                        <td>
                          {severities.get(entry.riskId) && (
                            <RiskWord level={severities.get(entry.riskId)!} />
                          )}
                        </td>
                        {TRUST_LEVELS.map((level) => (
                          <LevelCell key={level} levels={entry.levels} level={level} />
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="note">{DAY_NOTE}</p>
            </>
          ) : (
            <p>This plugin has no fallback permission.</p>
          )}
          {plugin.excludedTools.length > 0 && (
            <>
              <h3>Left out on purpose</h3>
              <p>Tools of the service this plugin does not expose, each with its reason.</p>
              <ul>
                {plugin.excludedTools.map((tool) => (
                  <li key={tool.name}>
                    <Mono>{tool.name}</Mono>: <Inline text={tool.reason} links={false} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </Section>

        {/* 6 · A mission, worked out */}
        <Section id="mission" title="A mission, worked out">
          <p>{mission.intro}</p>
          <div className="allow" data-nothing-runs={mission.nothingRuns || undefined}>
            {mission.groups.map((group) => (
              <div key={group.key} className={`allow-group allow-${group.key}`}>
                <h3>
                  {group.heading} <span className="num">{group.items.length}</span>
                </h3>
                {group.items.length > 0 ? (
                  <ul className="plain">
                    {group.items.map((item) => (
                      <li key={item.riskId}>
                        {item.label} {item.env && <Tag>{item.env}</Tag>}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="quiet">—</p>
                )}
              </div>
            ))}
          </div>
          {mission.notTicked && <p className="note">{mission.notTicked}</p>}
        </Section>

        {/* 7 · Connecting an account */}
        <Section id={CONNECT_ANCHOR} title="Connecting an account">
          {plugin.credentials.map((c) => (
            <ConnectBlock key={c.kind + c.clientSource} plugin={plugin} credential={c} />
          ))}
        </Section>

        {/* 8 · Retired, tools, health, links */}
        {retired.length > 0 && (
          <Section id="retired" title="Retired permissions">
            <p>
              Kept so the missions that hold them still read; no tool touches them and no new
              mission is offered them.
            </p>
            <ul>
              {retired.map((r) => (
                <li key={r.riskId}>
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

        <Section id="tools" title="Tools">
          {plugin.tools.length === 0 ? (
            <p>This plugin exposes no tool yet.</p>
          ) : (
            <details>
              <summary>
                {plugin.tools.length} {plugin.tools.length === 1 ? 'tool' : 'tools'}, with what each
                usually touches
              </summary>
              <p className="note">{TOOLS_NOTE}</p>
              <div className="table-wrap">
                <table>
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
            </details>
          )}
          {plugin.gitRemote && (
            <p>
              <Inline text={GIT_REMOTE_SENTENCE} />
            </p>
          )}
        </Section>

        <Section id="health" title="Health">
          <p>{gatewaysSentence(health, thresholds.windowDays)}</p>
          {health.versions.length === 0 ? (
            <p>
              {health.minors[0]?.calls === NOT_READ && health.gateways === NOT_READ
                ? 'No figure: the collector did not answer when this page was rendered; the site tries again within the hour.'
                : 'No version of this plugin has reported a call or a gateway yet.'}
            </p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    {['Version', 'Gateways', 'Calls', 'Success', 'Validated'].map((h) => (
                      <th scope="col" key={h}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {health.versions.map((line) => (
                    <tr key={line.label}>
                      <td>
                        <Mono>{line.label}</Mono>
                      </td>
                      {figureCells(line).map((cell, i) => (
                        <td key={i}>{cell}</td>
                      ))}
                      <td>{line.validated ? 'validated' : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p>
            <Inline text={validatedSentence(thresholds)} />
          </p>
          <p className="note">{healthFootnote(thresholds.windowDays)}</p>
        </Section>

        <Section id="links" title="Links">
          <ul className="links">
            {links.map((l) => (
              <li key={l.href}>
                <a href={l.href}>{l.label}</a>
              </li>
            ))}
          </ul>
        </Section>

        <p className="meta">
          {lastModified ? `Last changed ${lastModified}. ` : ''}
          This page as Markdown: <a href={twin.href}>{twin.href}</a>
        </p>
      </article>
    </div>
  );
}
