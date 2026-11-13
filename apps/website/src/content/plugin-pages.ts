/**
 * The Markdown of the plugin pages (website spec §2.3, §2.4), the connect guide
 * included (section 7). One string per page: the site renders it as HTML and
 * serves it as the page's Markdown twin.
 */
import { githubBlob, githubTree } from '../site/constants';
import {
  callsWords,
  countWords,
  gatewaysSentence,
  healthFootnote,
  healthOf,
  type HealthSnapshot,
  type LineFigures,
  NOT_READ,
  type PluginHealth,
  rateWords,
} from './health';
import { code, markdownTable, text } from './markdown';
import type { TokenExpiry } from '@vaubaan/plugin-sdk';
import {
  GATE_WORDS,
  SEVERITY_LABEL,
  TRUST_LEVEL_LABELS,
  TRUST_LEVELS,
  type TrustLevel,
} from '@vaubaan/policy-engine';

import { twinPathOf } from './outputs';
import { WORKED_TRUST_LEVEL, type ExampleInfo } from './plugin-examples';
import {
  BROKER_ADMIN_TITLE,
  BROKER_DOC,
  brokerAdminSentences,
  callWords,
  capitalise,
  carefulGateOf,
  connectGuidePath,
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
  screenshotCredits,
  spreadsOf,
  TOOLS_NOTE,
  type MapColumn,
  type MapRow,
  type Spread,
} from './plugin-page';
import type {
  ConnectStepInfo,
  CredentialInfo,
  FactInfo,
  LevelBudgets,
  PluginInfo,
} from './plugins';
import { thresholdsSentence, type ValidationThresholds } from './thresholds';

export interface PluginWithHealth extends PluginInfo {
  readonly health: PluginHealth;
}

export function withHealth(
  plugins: readonly PluginInfo[],
  snapshot: HealthSnapshot,
): PluginWithHealth[] {
  return plugins.map((p) => ({ ...p, health: healthOf(snapshot, p.id, p.version) }));
}

/** `/plugins`, `/plugins/health`, `/plugins/<id>`: the pages that carry health. */
export const PLUGIN_GROUP_PATH = /^\/plugins(\/health|\/[a-z][a-z0-9-]*)?$/;

/**
 * The Markdown of every page that carries health, by path. Built once at
 * build time with nothing read (the shape of the pages), and again at request
 * time with the collector's snapshot (`src/site/live.ts`).
 */
export function pluginGroupMarkdown(
  plugins: readonly PluginWithHealth[],
  thresholds: ValidationThresholds,
  snapshot: HealthSnapshot,
): Record<string, string> {
  const markdown: Record<string, string> = {
    '/plugins': pluginListMarkdown(plugins, thresholds),
    '/plugins/health': healthPageMarkdown(thresholds, snapshot),
  };
  for (const plugin of plugins) {
    markdown[`/plugins/${plugin.id}`] = pluginPageMarkdown(plugin, thresholds);
  }
  return markdown;
}

export function pluginPageTitle(plugin: Pick<PluginInfo, 'name'>): string {
  return `${plugin.name} plugin`;
}

export function pluginPageDescription(plugin: PluginInfo): string {
  return `${plugin.name} plugin of Vaubaan Gateway, version ${plugin.version}: ${plugin.counts.permissions} permissions, ${plugin.counts.macroActions} macro-actions, ${plugin.counts.tools} tools.`;
}

/** The links of a plugin page (section 8): connect, handbook, catalog as code, Markdown twin. */
export function pluginLinks(
  plugin: PluginInfo,
): { readonly label: string; readonly href: string }[] {
  return [
    { label: `Connect a ${plugin.name} account`, href: connectGuidePath(plugin.id) },
    ...(plugin.docsUrl ? [{ label: `How ${plugin.name} is modelled`, href: plugin.docsUrl }] : []),
    {
      label: 'The catalog, as code',
      href: githubBlob(`${plugin.dir}/src/risk-catalog.yaml`),
    },
    { label: 'The plugin source', href: githubTree(plugin.dir) },
    { label: 'This page as Markdown', href: twinPathOf(`/plugins/${plugin.id}`) },
  ];
}

/** A permission as the twin names it: its label, its id, its environment. */
function permissionWords(
  label: string,
  riskId: string,
  envs: readonly string[] | string | null,
): string {
  const list = envs === null ? [] : typeof envs === 'string' ? [envs] : envs;
  return `${text(label)} ${code(riskId)}${list.length > 0 ? ` [${list.join(', ')}]` : ''}`;
}

function gateCell(levels: LevelBudgets, level: TrustLevel): string {
  const { gate, quota } = levelCellWords(levels, level);
  if (quota === null) return GATE_WORDS[gate];
  return gate === 'free' ? quota : `${GATE_WORDS[gate]}, ${quota}`;
}

function factsWords(facts: readonly FactInfo[]): string {
  return facts
    .map((f) => (f.movesGate ? `**${f.label} ${f.word}**` : `${f.label} ${f.word}`))
    .join(' · ');
}

function mapColumnMarkdown(rows: readonly MapRow[], columns: readonly MapColumn[]): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    const boxes = row.cells.flatMap((cell, i) =>
      cell.map((b) => ({ ...b, column: columns[i]?.label ?? '' })),
    );
    const sensitive = row.sensitiveBy.length > 0 ? ` (${row.sensitiveBy.join(', ')})` : '';
    lines.push(`- **${capitalise(row.word)}**${sensitive} — ${row.levelsSentence}.`);
    for (const b of boxes) {
      lines.push(
        `  - ${columns.length > 1 ? `${text(b.column)}: ` : ''}${permissionWords(b.label, b.riskId, b.envs)}, ${b.severity}${b.fallback ? ', the fallback' : ''}`,
      );
    }
  }
  return lines;
}

function spreadMarkdown(spread: Spread): string[] {
  const lines: string[] = [
    `### ${text(spread.label)}`,
    '',
    `${code(spread.id)} — ${text(spread.description)}`,
    '',
  ];
  if (spread.narrative) lines.push(text(spread.narrative), '');
  lines.push(
    markdownTable(
      [
        'Permission',
        'The six facts',
        SEVERITY_LABEL,
        ...spread.levelHeadings.map((h) => h.heading),
      ],
      spread.lines.map((line) => [
        `${permissionWords(line.label, line.riskId, line.env)}: ${text(line.reason)}`,
        factsWords(line.facts),
        line.severity,
        ...TRUST_LEVELS.map((level) => gateCell(line.levels, level)),
      ]),
    ),
    '',
    spread.limitsNote,
    '',
  );
  return lines;
}

function exampleMarkdown(example: ExampleInfo, labels: ReadonlyMap<string, string>): string {
  return [
    `- ${code(callWords(example))}`,
    `  - the plugin sees: ${example.slices.map(code).join(', ')}`,
    `  - the catalog answers: ${example.permissions.map((id) => `${text(labels.get(id) ?? id)} ${code(id)}`).join(', ')}`,
    `  - a ${TRUST_LEVEL_LABELS[WORKED_TRUST_LEVEL]} mission: ${GATE_WORDS[carefulGateOf(example)]}`,
  ].join('\n');
}

/**
 * Section 7 as Markdown, in the page's order: the kind, the administrator's block of
 * a brokered service, what the person does, the steps with their paths in bold and
 * their screenshots as images with the provenance line, then permissions, expiry,
 * fields and the documentation.
 */
function connectMarkdown(plugin: PluginInfo, c: CredentialInfo): string[] {
  const lines = [`**${connectKindBadge(c)}** — ${code(connectKindCode(c))}`, ''];
  if (c.clientSource === 'broker') {
    lines.push(
      `**${BROKER_ADMIN_TITLE}** (an administrator, once):`,
      '',
      ...brokerAdminSentences(c, plugin.name).map((sentence) => `- ${sentence}`),
      `- Provider ${code(c.brokerProvider ?? '')}; scopes asked: ${c.scopes.map(code).join(', ')}. [Your own OAuth broker](${BROKER_DOC})`,
      '',
    );
  }
  lines.push(...connectSentences(c, plugin.name).flatMap((sentence) => [sentence, '']));
  if (c.clientSource === 'broker') return lines;
  if (c.clientSource === 'gateway-registered') {
    if (c.scopes.length > 0) lines.push(`Scopes asked: ${c.scopes.map(code).join(', ')}.`, '');
    return lines;
  }
  if (c.reach) {
    lines.push(
      `Grant it wide, once — ${text(c.reach.what)}: ${text(c.reach.grant)}. ${text(c.reach.why)}`,
      '',
    );
  }
  if (c.steps.length > 0)
    lines.push(...c.steps.flatMap((step, i) => stepMarkdown(step, i + 1)), '');
  if (c.createUrl) lines.push(`Where: [${c.createUrl}](${c.createUrl})`, '');
  if (c.permissions.length > 0) {
    lines.push(
      ...c.permissions.map(
        (p) => `- ${text(p.name)}: ${p.access} (for ${p.tools.map(code).join(', ')})`,
      ),
      '',
    );
  }
  if (c.expiry) lines.push(expiryWords(c.expiry), '');
  if (c.fields.length > 0) {
    lines.push(
      `The connect page asks: ${c.fields.map((f) => `${text(f.label)}${f.secret ? ' (secret)' : ''}`).join(', ')}.`,
      '',
    );
  }
  if (c.docsUrl) lines.push(`The service's documentation: [${c.docsUrl}](${c.docsUrl})`, '');
  return lines;
}

/** Section 7 of a plugin page as Markdown: every way of connecting, then how to disconnect. */
export function connectSectionMarkdown(plugin: PluginInfo): string {
  const lines = plugin.credentials.flatMap((c) => connectMarkdown(plugin, c));
  if (plugin.manualRevocation) lines.push(`Disconnecting: ${text(plugin.manualRevocation)}`, '');
  return lines.join('\n').trimEnd();
}

/**
 * `/plugins/<id>` as Markdown: the sections of the page in the same order
 * (website spec §2.3, 1–8), the map as a list by undo row.
 */
export function pluginPageMarkdown(
  plugin: PluginWithHealth,
  thresholds: ValidationThresholds,
): string {
  const labels = new Map(plugin.risks.map((r) => [r.id, r.label]));
  const opening = openingOf(plugin);
  const map = mapOf(plugin);
  const lines: string[] = [
    `# ${pluginPageTitle(plugin)}`,
    '',
    `The ${plugin.name} plugin lets a Vaubaan Gateway mission use ${plugin.name} without handing the agent a credential. ${text(plugin.description)}`,
    '',
    opening.verbs,
    '',
    `Version ${code(plugin.version)} · ${opening.counts.join(' · ')} · ${gatewaysSentence(plugin.health, thresholds.windowDays)}`,
    '',
  ];
  if (plugin.summary) lines.push(text(plugin.summary), '');
  lines.push(
    ...opening.dimensions.map((d) => `- **${d.term}**: ${d.line}`),
    ...opening.levels.map((l) => `  - ${l.label} ×${l.factor}: ${l.hint}`),
    '',
    '## The map',
    '',
    'Every permission by its undo fact, the rows, and its macro-action; each row says what the trust levels do with it.',
    '',
    ...mapColumnMarkdown(map.rows, map.columns),
    '',
    `Read it: ${map.reading}`,
    '',
  );

  for (const spread of spreadsOf(plugin, map)) lines.push(...spreadMarkdown(spread));

  lines.push('## Worked examples', '');
  if (plugin.examples.length === 0) {
    lines.push('This plugin declares no example yet.', '');
  } else {
    lines.push(
      `The plugin's declared calls, run through its own classifier when this page was built: what it sees, the permissions the catalog answers, and what a ${TRUST_LEVEL_LABELS[WORKED_TRUST_LEVEL]} mission does.`,
      '',
      ...plugin.examples.map((e) => exampleMarkdown(e, labels)),
      '',
    );
  }

  lines.push('## Anything else', '');
  const fallback = plugin.anythingElse?.entries ?? [];
  lines.push(
    fallback.length > 0
      ? `A call no permission covers touches ${listWords(fallback.map((e) => code(e.riskId)))} instead of slipping through. No macro-action holds it; a person ticks "${text(plugin.anythingElse?.label ?? '')}" knowingly. ${DAY_NOTE}`
      : 'This plugin has no fallback permission.',
    '',
  );
  if (fallback.length > 0) {
    lines.push(
      markdownTable(
        ['Permission', SEVERITY_LABEL, ...levelHeadings().map((h) => h.heading)],
        fallback.map((entry) => [
          permissionWords(labels.get(entry.riskId) ?? '', entry.riskId, null),
          plugin.risks.find((r) => r.id === entry.riskId)?.severity ?? '',
          ...TRUST_LEVELS.map((level) => gateCell(entry.levels, level)),
        ]),
      ),
      '',
    );
  }
  if (plugin.excludedTools.length > 0) {
    lines.push(
      'Left out on purpose — tools of the service this plugin does not expose:',
      '',
      ...plugin.excludedTools.map((tool) => `- ${code(tool.name)}: ${text(tool.reason)}`),
      '',
    );
  }

  const mission = missionOf(plugin);
  lines.push('## A mission, worked out', '', text(mission.intro), '');
  for (const group of mission.groups) {
    lines.push(`**${group.heading}** (${group.items.length})`, '');
    if (group.items.length > 0) {
      lines.push(...group.items.map((i) => `- ${permissionWords(i.label, i.riskId, null)}`), '');
    }
  }
  if (mission.notTicked) lines.push(text(mission.notTicked), '');

  lines.push('## Connecting an account', '', connectSectionMarkdown(plugin), '');

  const retired = retiredOf(plugin);
  if (retired.length > 0) {
    lines.push(
      '## Retired permissions',
      '',
      'Kept so the missions that hold them still read; no tool touches them and no new mission is offered them.',
      '',
      ...retired.map(
        (r) =>
          `- ${permissionWords(r.label, r.riskId, null)}${r.replacedBy ? `: replaced by ${code(r.replacedBy)}` : ''}`,
      ),
      '',
    );
  }

  lines.push('## Tools', '');
  if (plugin.tools.length === 0) {
    lines.push('This plugin exposes no tool yet.', '');
  } else {
    lines.push(
      `${plural(plugin.tools.length, 'tool', 'tools')}. ${TOOLS_NOTE}`,
      '',
      markdownTable(
        ['Tool', 'What it does', 'Usually touches'],
        plugin.tools.map((tool) => [
          code(tool.name),
          text(tool.title ?? tool.description),
          tool.touches.map(code).join(', '),
        ]),
      ),
      '',
    );
  }
  if (plugin.gitRemote) {
    lines.push(GIT_REMOTE_SENTENCE, '');
  }

  lines.push(
    '## Health',
    '',
    gatewaysSentence(plugin.health, thresholds.windowDays),
    '',
    versionsTable(plugin.health),
    '',
    validatedSentence(thresholds),
    '',
    healthFootnote(thresholds.windowDays),
    '',
    '## Links',
    '',
    // The twin is this text: it names the page it repeats instead.
    ...pluginLinks(plugin).map((l) =>
      l.href.endsWith('.md')
        ? `- The page: [/plugins/${plugin.id}](/plugins/${plugin.id})`
        : `- [${l.label}](${l.href})`,
    ),
    '',
  );
  return lines.join('\n').trimEnd() + '\n';
}

export const GIT_REMOTE_SENTENCE =
  "The instance is also the agents' git remote for this service: `git clone` and `git push` go through the gateway with the mission key, every pushed ref decided like a tool call ([git remote](/docs/missions/git-remote)).";

export function validatedSentence(thresholds: ValidationThresholds): string {
  return `A version is marked validated by the community with ${thresholdsSentence(thresholds)}; a gateway shows that mark on the accounts of this service. The figures are refreshed at most hourly ([what they mean](/plugins/health)). It is a community signal, not a security guarantee.`;
}

function plural(n: number, one: string, other: string): string {
  return `${n} ${n === 1 ? one : other}`;
}

/**
 * One step of the guide: its menu path in bold ("**Settings › Tokens**"), the
 * sentence, its page as a link, its command as code; its screenshot as an image
 * with the provenance line under it.
 */
function stepMarkdown(step: ConnectStepInfo, n: number): string[] {
  const path =
    step.path.length > 0 ? `**${step.path.map(text).join(` ${PATH_SEPARATOR} `)}** — ` : '';
  const where = step.url ? ` ([open](${step.url}))` : '';
  const command = step.code ? ` ${code(step.code)}` : '';
  const lines = [`${n}. ${path}${text(step.do)}${where}${command}`];
  if (step.figure) {
    lines.push(
      '',
      `   ![${text(step.figure.alt)}](${step.figure.src})`,
      `   *${text(step.figure.attribution)}*`,
      '',
    );
  }
  return lines;
}

/** The expiry of a pasted key in one sentence; `escape` is `text` for Markdown, none for HTML. */
export function expiryWords(expiry: TokenExpiry, escape: (value: string) => string = text): string {
  switch (expiry.kind) {
    case 'provider-reports':
      return 'Expiry: the service tells the gateway the date, and the account page warns before it.';
    case 'person-types':
      return `Expiry: about ${expiry.recommendedDays} days, chosen at the service; the service does not tell the gateway the date.`;
    case 'none':
      return `Expiry: ${escape(expiry.reason)}`;
  }
}

/** The figures of a line, in the columns Gateways | Calls | Success. */
export function figureCells(line: LineFigures): string[] {
  return [countWords(line.gateways), callsWords(line.calls), rateWords(line.successRate)];
}

/** The last versions the collector knows, newest first, or why there is none. */
export function versionsTable(health: PluginHealth): string {
  if (health.versions.length === 0) {
    const unread = health.minors[0]?.calls === NOT_READ && health.gateways === NOT_READ;
    return unread
      ? 'No figure: the collector did not answer when this page was rendered; the site tries again within the hour.'
      : 'No version of this plugin has reported a call or a gateway yet.';
  }
  return markdownTable(
    ['Version', 'Gateways', 'Calls', 'Success', 'Validated'],
    health.versions.map((line) => [
      code(line.label),
      ...figureCells(line),
      line.validated ? 'validated' : '',
    ]),
  );
}

/** `/plugins`: every plugin, two rows each: the minor of this release, then the latest other one. */
export function pluginListMarkdown(
  plugins: readonly PluginWithHealth[],
  thresholds: ValidationThresholds,
): string {
  return [
    '# Plugins',
    '',
    `A plugin teaches Vaubaan Gateway one service: how to classify a call into permissions, how to execute it, how to connect an account. ${plugins.length} plugins ship with the gateway; this list is generated from the repository's \`plugins/\` folder.`,
    '',
    'Each plugin has a row for the minor version it ships at in this release, then one for the most recent other minor the community collector knows, if any; a minor adds up its patch versions.',
    '',
    markdownTable(
      ['Plugin', 'Version', 'Gateways', 'Calls', 'Success'],
      plugins.flatMap((p) =>
        p.health.minors.map((line, index) => [
          `[${p.name}](/plugins/${p.id})`,
          index === 0 ? `${code(line.label)} (this release)` : code(line.label),
          ...figureCells(line),
        ]),
      ),
    ),
    '',
    `${healthFootnote(thresholds.windowDays)} Refreshed at most hourly: [how it is measured](/plugins/health).`,
    '',
    `Write a plugin for another service: the [plugin guide](${githubBlob('plugins/README.md')}) and the kit in [plugins/_template](${githubTree('plugins/_template')}). Every plugin as data: [/plugins.json](/plugins.json).`,
    '',
    ...creditLines(plugins),
  ].join('\n');
}

/** The credits line of the screenshots, generated from the declarations; nothing when none. */
function creditLines(plugins: readonly PluginInfo[]): string[] {
  const credits = screenshotCredits(plugins);
  return credits ? [text(credits), ''] : [];
}

/** "2026-11-01 15:00 UTC" */
function utcMinute(iso: string): string {
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`;
}

/** `/plugins/health`: what the figures mean, and when they were read. */
export function healthPageMarkdown(
  thresholds: ValidationThresholds,
  snapshot: HealthSnapshot,
): string {
  const when = snapshot.fetchedAt
    ? `The figures on the plugin pages were read from the collector at ${utcMinute(snapshot.fetchedAt)}; they are read again at most once an hour.`
    : 'The collector could not be read, so the plugin pages show "not read"; the site tries again within the hour.';
  return [
    '# Plugin health',
    '',
    `Plugin health says, per plugin version, how many gateways run it, how many calls they reported and how many of those worked, as sent by the instances whose operators turned community telemetry on. The figures are on the [plugin list](/plugins) and on each plugin's page.`,
    '',
    when,
    '',
    '## What the figures are',
    '',
    `- **Calls**: the calls a plugin executed, over the last ${thresholds.windowDays} days, as reported by the instances that share plugin health (one report per call, nothing of the call itself).`,
    `- **Gateways**: the distinct gateways whose daily profile listed the plugin version, over the same window. Only instances that also share usage statistics send a profile, so the figure is a lower bound. A gateway is counted by a random identifier it keeps, sent with that profile only and never with a call, which its administrator can regenerate.`,
    "- **Success**: the share of calls that worked, leaving out calls refused because the service rejected the credential: a revoked or expired token is the user's configuration, not the plugin. Every other failure counts against it, including a service refusing a call the agent got wrong: the rate measures calls that worked, not the plugin's code alone.",
    `- **Validated**: a version with ${thresholdsSentence(thresholds)}. It is the collector's verdict, and what a gateway shows as "validated by the community" on the accounts of that service. The site shows every version's figures whatever their number; validated is only a mark.`,
    '- A minor version (`4.0`) adds up the calls of its patch versions (`4.0.1`, `4.0.2`); its gateways are counted once each, even one that moved from one patch to the next.',
    '',
    '## How it is read',
    '',
    '- The site reads the collector when a page is served and keeps what it read for an hour. When the collector does not answer, a figure reads "not read" — never a guess — and the next render tries again; calls and gateways come from two separate reads, so one can be read without the other.',
    `- Telemetry is off on every instance unless its operator turns it on; what an instance sends is listed on the [trust center](/trust#what-leaves-an-instance).`,
    "- Anyone can send reports, so a determined party could skew a plugin's figures; the thresholds and a global ingestion limit raise the cost, they do not remove it. The status is a community signal, not a security guarantee.",
    `- The thresholds live in one SQL function of the collector, [\`plugin_validation_thresholds()\`](${githubBlob('deploy/collector/schema.sql')}), published in the [collector's README](${githubBlob('deploy/collector/README.md')}#published-thresholds).`,
    '',
    healthFootnote(thresholds.windowDays),
    '',
  ].join('\n');
}
