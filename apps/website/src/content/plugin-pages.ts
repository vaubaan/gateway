/**
 * The Markdown of the plugin pages (website spec §2.3, §2.4), the connect guide
 * included (section 9). One string per page: the site renders it as HTML and
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
import {
  GATE_WORDS,
  REASON_WORDS,
  ROW_LABEL,
  ROW_WORDS,
  TREE_LEGEND,
  TRUST_LEVEL_HINTS,
  TRUST_LEVEL_LABELS,
  TRUST_LEVELS,
  type TrustLevel,
} from '@vaubaan/policy-engine';

import { connectGuidePath, siteDir, twinPathOf } from './outputs';
import {
  ALTERNATIVES_LEGEND,
  anythingElseSentence,
  BROKER_ADMIN_TITLE,
  BROKER_DOC,
  brokerAdminSentences,
  callsOf,
  callWords,
  carefulGateOf,
  cellWords,
  CARDINALITY_MARKS,
  CARDINALITY_WORDS,
  connectKindBadge,
  connectKindCode,
  connectSentences,
  countsOf,
  DAY_NOTE,
  expiryText,
  GATE_SHORT,
  GIT_REMOTE_SENTENCE,
  grantsHeading,
  LEFT_OUT_SENTENCE,
  ledeOf,
  levelHeading,
  MACRO_ACTIONS_SENTENCE,
  macroActionsTitle,
  mapOf,
  modelOf,
  MODEL_SENTENCE,
  PATH_SEPARATOR,
  plural,
  retiredOf,
  RETIRED_SENTENCE,
  screenshotCredits,
  toolsIntro,
  type MapChip,
  type ModelNode,
} from '@vaubaan/plugin-page/page-data';
import type {
  ConnectStepInfo,
  CredentialInfo,
  ExampleInfo,
  LevelBudgets,
  PluginInfo,
} from '@vaubaan/plugin-page/info';
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
      href: githubBlob(`${siteDir(plugin)}/src/risk-catalog.yaml`),
    },
    { label: 'The plugin source', href: githubTree(siteDir(plugin)) },
    { label: 'This page as Markdown', href: twinPathOf(`/plugins/${plugin.id}`) },
  ];
}

/** A permission as the twin names it: its label and its id. */
function permissionWords(label: string, riskId: string): string {
  return `${text(label)} ${code(riskId)}`;
}

/** "Careful: no · Trusting: ask me, 150 a day · …" for the values of one environment (or none). */
function levelsWords(values: MapChip['values'], env: string | null): string {
  return TRUST_LEVELS.map((level) => {
    const value = values.find((v) => v.level === level && v.env === env);
    return value ? `${TRUST_LEVEL_LABELS[level]}: ${cellWords(value)}` : '';
  })
    .filter(Boolean)
    .join(' · ');
}

/** The trust levels' lines for a fallback entry. */
function fallbackLevels(levels: LevelBudgets): string[] {
  return TRUST_LEVELS.map((level: TrustLevel) => {
    const line = levels[level];
    return line.gateWord === 'off'
      ? GATE_SHORT.off
      : `${GATE_SHORT[line.gateWord]} · ${line.quota.toLocaleString('en-US')} a day`;
  });
}

/** One entity of the model as an outline line, then its children, indented. */
function entityLines(node: ModelNode, depth: number, envs: readonly string[]): string[] {
  const facts = [
    node.marks.join(' '),
    ...(node.resource ? ['the resource'] : []),
    ...(node.carriesEnv
      ? [
          envs.length > 0
            ? `carries the environment (${envs.join(', ')})`
            : 'carries the environment, in the model only',
        ]
      : []),
    ...(node.touched ? [] : ['no tool touches it']),
  ];
  return [
    `${'  '.repeat(depth + 1)}- ${code(node.name)} (${facts.join('; ')}) — ${text(node.description)}`,
    ...node.children.flatMap((child) => entityLines(child, depth + 1, envs)),
  ];
}

function modelMarkdown(plugin: PluginInfo): string[] {
  const model = modelOf(plugin);
  return [
    `## How ${text(plugin.name)} is modelled`,
    '',
    `${model.counts} ${MODEL_SENTENCE}`,
    '',
    ...(model.account ? [`- **Account** — ${text(model.account)}`] : []),
    ...model.planes.flatMap((plane) => [
      `  - Plane ${code(plane.slug)}${plane.description ? ` — ${text(plane.description)}` : ''}`,
      ...plane.roots.flatMap((root) => entityLines(root, 1, model.envs)),
    ]),
    '',
    `Marks: ${(['one', 'bounded', 'unbounded'] as const).map((c) => `${CARDINALITY_MARKS[c]} ${CARDINALITY_WORDS[c]}`).join('; ')}.`,
    '',
    `- **Account**: ${text(model.account ?? '')}`,
    `- **Resource**: ${text(model.resource ?? '')}`,
    `- **Environment**: ${model.environmentRule} Known: ${model.envs.length > 0 ? model.envs.map(code).join(', ') : 'none'}. Carried by: ${model.carriers.length > 0 ? model.carriers.map(code).join(', ') + (model.envInModelOnly ? ', in the model only' : '') : 'nothing in the model'}.${model.environmentNotes.map((note) => ` ${text(note)}`).join('')}`,
    '',
  ];
}

function macroActionsMarkdown(plugin: PluginInfo): string[] {
  return [
    `## ${macroActionsTitle(plugin)}`,
    '',
    MACRO_ACTIONS_SENTENCE,
    '',
    ...plugin.macroActions.map(
      (a, i) =>
        `${i + 1}. **${text(a.label)}** — ${text(a.description)}${a.narrative ? ` ${text(a.narrative)}` : ''} (${plural(a.entries.length, 'permission', 'permissions')})`,
    ),
    '',
  ];
}

/** The map as one list per row: each permission, its reason, its three gates and quotas, per environment. */
function mapMarkdown(plugin: PluginInfo): string[] {
  const map = mapOf(plugin);
  const lines = [
    '## The map',
    '',
    `${map.introLead}${map.introTail}`,
    '',
    `${TRUST_LEVELS.map((l) => `${levelHeading(l)}: ${TRUST_LEVEL_HINTS[l]}`).join(' ')}`,
    '',
    `${GATE_SHORT.free}: ${GATE_WORDS.free}; ${GATE_SHORT.ask}: ${GATE_WORDS.ask}; ${GATE_SHORT.off}: ${GATE_WORDS.off}. ${TREE_LEGEND}`,
    '',
  ];
  for (const row of map.rows) {
    lines.push(`### ${row.word}`, '', row.gates, '');
    const items = row.cells.flatMap((cell, i) =>
      cell.map((chip) => ({ chip, column: map.columns[i]?.label ?? '' })),
    );
    if (items.length === 0) {
      lines.push('None.', '');
      continue;
    }
    for (const { chip, column } of items) {
      const envs = [...new Set(chip.values.flatMap((v) => (v.env ? [v.env] : [])))];
      const reason = chip.rowReason ? `, ${REASON_WORDS[chip.rowReason]}` : '';
      const head = `- ${text(column)}: ${permissionWords(chip.label, chip.riskId)}${chip.envs ? ` [${chip.envs.join(', ')}]` : ''}${reason} — ${text(chip.reason)}`;
      if (envs.length === 0) {
        lines.push(`${head} ${levelsWords(chip.values, null)}.`);
      } else {
        lines.push(head, ...envs.map((env) => `  - On ${env}: ${levelsWords(chip.values, env)}.`));
      }
    }
    lines.push('');
  }
  lines.push(...map.sums.map((s) => s.text), '', DAY_NOTE, '');
  if (map.notes.length > 0) lines.push(map.notes.join(' '), '');
  return lines;
}

function exampleMarkdown(example: ExampleInfo, labels: ReadonlyMap<string, string>): string {
  return [
    `- ${code(callWords(example))}`,
    `  - the plugin sees: ${example.slices.map(code).join(', ')}`,
    `  - the catalog answers: ${example.permissions.map((id) => `${text(labels.get(id) ?? id)} ${code(id)}`).join(', ')}`,
    `  - a ${TRUST_LEVEL_LABELS.careful} mission: ${GATE_SHORT[carefulGateOf(example)]}`,
  ].join('\n');
}

function callsMarkdown(plugin: PluginInfo): string[] {
  const calls = callsOf(plugin);
  const labels = new Map(plugin.risks.map((r) => [r.id, r.label]));
  const link =
    plugin.examplesSource && calls.total > 0
      ? ` [${calls.linkLabel}](${githubBlob(plugin.examplesSource)}).`
      : '';
  return [
    '## A few calls, classified by the plugin',
    '',
    `${calls.intro}${link}`,
    '',
    ...(calls.rows.length > 0 ? [...calls.rows.map((e) => exampleMarkdown(e, labels)), ''] : []),
  ];
}

function anythingElseMarkdown(plugin: PluginInfo): string[] {
  const risks = new Map(plugin.risks.map((r) => [r.id, r]));
  const fallback = plugin.anythingElse?.entries ?? [];
  const lines = ['## Anything else', '', anythingElseSentence(plugin), ''];
  if (fallback.length > 0) {
    lines.push(
      markdownTable(
        ['Permission', ROW_LABEL, ...TRUST_LEVELS.map(levelHeading)],
        fallback.map((entry) => {
          const risk = risks.get(entry.riskId);
          return [
            `${permissionWords(risk?.label ?? '', entry.riskId)}: ${text(risk?.reason ?? '')}`,
            risk
              ? `${ROW_WORDS[risk.row]}${risk.rowReason ? ` (${REASON_WORDS[risk.rowReason]})` : ''}`
              : '',
            ...fallbackLevels(entry.levels),
          ];
        }),
      ),
      '',
    );
  }
  if (plugin.excludedTools.length > 0) {
    lines.push(
      LEFT_OUT_SENTENCE,
      '',
      ...plugin.excludedTools.map((tool) => `- ${code(tool.name)}: ${text(tool.reason)}`),
      '',
    );
  }
  return lines;
}

/**
 * The connect guide as Markdown, in the page's order: the kind, the administrator's
 * block of a brokered service, what the person does, how wide to grant, the steps
 * (one list per alternative, the shared steps continuing it), the permissions to
 * grant, then where, the expiry, the fields and the documentation.
 */
function connectMarkdown(plugin: PluginInfo, c: CredentialInfo): string[] {
  const lines = [`**${connectKindBadge(c)}** — ${code(c.label ?? connectKindCode(c))}`, ''];
  if (c.clientSource === 'broker') {
    lines.push(
      `**${BROKER_ADMIN_TITLE}** (an administrator, once):`,
      '',
      ...brokerAdminSentences(c, plugin.name).map((s) => `- ${s}`),
      `- OAuth provider ${code(c.brokerProvider ?? '')}; scopes asked: ${c.scopes.map(code).join(', ')}. [Your own OAuth broker](${BROKER_DOC})`,
      '',
    );
  }
  lines.push(...connectSentences(c, plugin.name).flatMap((s) => [s, '']));
  if (c.clientSource === 'broker' || c.clientSource === 'host') return lines;
  if (c.clientSource === 'gateway-registered') {
    if (c.scopes.length > 0) lines.push(`Scopes asked: ${c.scopes.map(code).join(', ')}.`, '');
    return lines;
  }
  if (c.reach) {
    lines.push(`**${text(c.reach.what)}** — ${text(c.reach.grant)}. ${text(c.reach.why)}`, '');
  }
  if (c.alternatives.length > 0) {
    lines.push(`${ALTERNATIVES_LEGEND}:`, '');
    for (const alt of c.alternatives) {
      lines.push(`**${text(alt.label)}**${alt.help ? ` — ${text(alt.help)}` : ''}`, '');
      lines.push(...[...alt.steps, ...c.steps].flatMap((step, i) => stepMarkdown(step, i + 1)), '');
    }
  } else if (c.steps.length > 0) {
    lines.push(...c.steps.flatMap((step, i) => stepMarkdown(step, i + 1)), '');
  }
  if (c.permissions.length > 0) {
    lines.push(
      markdownTable(
        [grantsHeading(plugin.name), 'Access'],
        c.permissions.map((p) => [text(p.name), p.access]),
      ),
      '',
    );
  }
  if (c.createUrl) lines.push(`Where: [${c.createUrl}](${c.createUrl})`, '');
  if (c.expiry) lines.push(`Expiry: ${expiryText(c.expiry, text)}`, '');
  if (c.fields.length > 0) {
    lines.push(
      `The connect page asks: ${c.fields.map((f) => `${text(f.label)}${f.secret ? ' (secret)' : ''}`).join(', ')}.`,
      '',
    );
  }
  if (c.docsUrl) lines.push(`The service's documentation: [${c.docsUrl}](${c.docsUrl})`, '');
  return lines;
}

/** The connect section of a plugin page as Markdown: every way of connecting, then how to disconnect. */
export function connectSectionMarkdown(plugin: PluginInfo): string {
  const lines = plugin.credentials.flatMap((c) => connectMarkdown(plugin, c));
  if (plugin.manualRevocation) lines.push(`Disconnecting: ${text(plugin.manualRevocation)}`, '');
  return lines.join('\n').trimEnd();
}

/**
 * `/plugins/<id>` as Markdown: the sections of the page in the same order
 * (website spec §2.3, 1–10), the model as an outline, the map as one list per row.
 */
export function pluginPageMarkdown(
  plugin: PluginWithHealth,
  thresholds: ValidationThresholds,
): string {
  const lines: string[] = [
    `# ${pluginPageTitle(plugin)}`,
    '',
    text(ledeOf(plugin)),
    '',
    `Version ${code(plugin.version)} · ${[...countsOf(plugin), gatewaysSentence(plugin.health, thresholds.windowDays)].join(' · ')}`,
    '',
    ...modelMarkdown(plugin),
    ...macroActionsMarkdown(plugin),
    ...mapMarkdown(plugin),
    ...callsMarkdown(plugin),
    ...anythingElseMarkdown(plugin),
    '## Tools',
    '',
  ];
  if (plugin.tools.length === 0) {
    lines.push('This plugin exposes no tool yet.', '');
  } else {
    lines.push(
      toolsIntro(plugin),
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
  if (plugin.gitRemote) lines.push(GIT_REMOTE_SENTENCE, '');

  const retired = retiredOf(plugin);
  if (retired.length > 0) {
    lines.push(
      '## Retired permissions',
      '',
      RETIRED_SENTENCE,
      '',
      ...retired.map(
        (r) =>
          `- ${permissionWords(r.label, r.riskId)}${r.replacedBy ? `: replaced by ${code(r.replacedBy)}` : ''}`,
      ),
      '',
    );
  }

  lines.push(
    '## Connecting an account',
    '',
    connectSectionMarkdown(plugin),
    '',
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
      l.href === twinPathOf(`/plugins/${plugin.id}`)
        ? `- The page: [/plugins/${plugin.id}](/plugins/${plugin.id})`
        : `- [${l.label}](${l.href})`,
    ),
    '',
  );
  return lines.join('\n').trimEnd() + '\n';
}

export function validatedSentence(thresholds: ValidationThresholds): string {
  return `A version is marked validated by the community with ${thresholdsSentence(thresholds)}; a gateway shows that mark on the accounts of this service. The figures are refreshed at most hourly ([what they mean](/plugins/health)). It is a community signal, not a security guarantee.`;
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
    `Write a plugin for another service: [the plugin author's guide](/docs/plugins-guide), with the published kit (\`npx @vaubaan/plugin-cli init\`). Every plugin as data: [/plugins.json](/plugins.json).`,
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
