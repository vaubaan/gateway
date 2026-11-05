/**
 * The Markdown of the plugin pages (website spec §2.3, §2.4) and of the docs
 * page "Connect <service>" (§2.2). One string per page: the site renders it as
 * HTML and serves it as the page's Markdown twin.
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
import type { GuideStep, TokenExpiry } from '@vaubaan/plugin-sdk';

import type { CredentialInfo, MacroActionEntryInfo, PluginInfo } from './plugins';
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

function windowWords(seconds: number): string {
  if (seconds === 60) return 'minute';
  if (seconds === 3600) return 'hour';
  if (seconds === 86400) return 'day';
  return `${seconds} s`;
}

function macroActionRow(
  entry: MacroActionEntryInfo,
  labels: ReadonlyMap<string, string>,
): string[] {
  return [
    code(entry.riskId),
    text(labels.get(entry.riskId) ?? ''),
    String(entry.quota),
    `${entry.rateMax} per ${windowWords(entry.rateWindowSeconds)}`,
  ];
}

export function pluginPageTitle(plugin: Pick<PluginInfo, 'name'>): string {
  return `${plugin.name} plugin`;
}

export function pluginPageDescription(plugin: PluginInfo): string {
  return `${plugin.name} plugin of Vaubaan Gateway, version ${plugin.version}: ${plugin.risks.length} permissions, ${plugin.macroActions.length} macro-actions, ${plugin.tools.length} tools.`;
}

/** `/plugins/<id>`: what the plugin covers, its permissions, macro-actions, tools and health. */
export function pluginPageMarkdown(
  plugin: PluginWithHealth,
  thresholds: ValidationThresholds,
): string {
  const labels = new Map(plugin.risks.map((r) => [r.id, r.label]));
  const lines: string[] = [
    `# ${pluginPageTitle(plugin)}`,
    '',
    `The ${plugin.name} plugin lets a Vaubaan Gateway mission use ${plugin.name} without handing the agent a credential. ${text(plugin.description)}`,
    '',
    `- Version: ${code(plugin.version)} (package ${code(plugin.packageName)})`,
    `- Gateways: ${gatewaysSentence(plugin.health, thresholds.windowDays)} [Health per version](#health)`,
    `- Source: [${plugin.dir}](${githubTree(plugin.dir)}), catalog [risk-catalog.yaml](${githubBlob(`${plugin.dir}/src/risk-catalog.yaml`)})${plugin.catalogVersion !== null ? ` version ${plugin.catalogVersion}` : ''}${plugin.catalogDate ? ` of ${plugin.catalogDate}` : ''}`,
    `- How to connect an account: [Connect ${plugin.name}](/docs/providers/${plugin.id})`,
  ];
  if (plugin.docsUrl) lines.push(`- How it is modelled: [handbook](${plugin.docsUrl})`);
  lines.push('');
  if (plugin.summary) lines.push(text(plugin.summary), '');

  lines.push(
    '## Permissions',
    '',
    `Each permission is a named risk of the plugin's catalog: a mission holds an explicit list of them, never "all". The severity is computed from the permission's six axes (undo, blast radius, data, cost, visible to, lasts); nothing is decided from it.`,
    '',
    markdownTable(
      ['Permission', 'What it allows', 'Severity', 'Why it is a risk'],
      plugin.risks.map((risk) => {
        const notes: string[] = [];
        if (risk.severityByEnv.length > 0) {
          notes.push(
            risk.severityByEnv.map((row) => `${row.severity} on ${code(row.env)}`).join(', '),
          );
        }
        if (risk.acceptableInEnvs) {
          notes.push(`only for ${risk.acceptableInEnvs.map(code).join(', ')}`);
        }
        if (risk.fallback)
          notes.push('the catch-all: touched only by a call no other permission covers');
        if (risk.deprecated) notes.push('deprecated');
        const severity =
          notes.length > 0 ? `${risk.severity} (${notes.join('; ')})` : risk.severity;
        return [code(risk.id), text(risk.label), severity, text(risk.reason)];
      }),
    ),
    '',
    '## Macro-actions',
    '',
    'A macro-action groups the permissions of one thing to do with the service, each with a base limit per period and a base rate. The person creating a mission ticks macro-actions and sets each to a trust level, Careful, Trusting or Autonomous: the level decides, from how hard each permission is to undo, whether it runs freely, asks first or is left out, and raises the limits. "Anything else", added by the gateway, holds the catch-all permission. The mission stores the explicit list, which the person can still edit line by line.',
    '',
  );
  for (const action of plugin.macroActions) {
    lines.push(
      `### ${text(action.label)}`,
      '',
      `${code(action.id)} — ${text(action.description)}`,
      '',
      ...(action.narrative ? [text(action.narrative), ''] : []),
      markdownTable(
        ['Permission', 'What it allows', 'Base limit per period', 'Base rate'],
        action.entries.map((entry) => macroActionRow(entry, labels)),
      ),
      '',
    );
  }

  lines.push('## Tools', '');
  if (plugin.tools.length === 0) {
    lines.push('This plugin exposes no tool yet.', '');
  } else {
    lines.push(
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
  if (plugin.excludedTools.length > 0) {
    lines.push(
      'Left out on purpose — tools of the service this plugin does not expose:',
      '',
      ...plugin.excludedTools.map((tool) => `- ${code(tool.name)}: ${text(tool.reason)}`),
      '',
    );
  }
  if (plugin.gitRemote) {
    lines.push(
      "The instance is also the agents' git remote for this service: `git clone` and `git push` go through the gateway with the mission key, every pushed ref decided like a tool call ([git remote](/docs/missions/git-remote)).",
      '',
    );
  }

  lines.push(
    '## Health',
    '',
    gatewaysSentence(plugin.health, thresholds.windowDays),
    '',
    versionsTable(plugin.health),
    '',
    `A version is marked validated by the community with ${thresholdsSentence(thresholds)}; a gateway shows that mark on the accounts of this service. The figures are refreshed at most hourly ([what they mean](/plugins/health)). It is a community signal, not a security guarantee.`,
    '',
    healthFootnote(thresholds.windowDays),
    '',
  );
  return lines.join('\n').trimEnd() + '\n';
}

function credentialKindWords(c: CredentialInfo): string {
  switch (c.clientSource) {
    case 'broker':
      return `by signing in at the service through an OAuth broker's client (nothing to create or paste; the instance must be enrolled with a broker serving ${code(c.brokerProvider ?? '')}: one someone else operates, or the published image run with your own client, [Your own OAuth broker](/docs/operations/oauth-broker); the gateway's pages tell whether the broker is attested)`;
    case 'gateway-registered':
      return 'by signing in at the service and allowing the gateway (nothing to create or paste: the gateway registers its own client there)';
    case 'pasted-key':
      return c.kind === 'ssh-key'
        ? 'with a key pair the instance generates; you install its public key on the host'
        : `with a ${c.label ?? 'key'} pasted by hand`;
  }
}

/** One step of the guide: the sentence, its page as a link, its command as code. */
function stepMarkdown(step: GuideStep, n: number): string {
  const where = step.url ? ` ([open](${step.url}))` : '';
  const command = step.code ? ` ${code(step.code)}` : '';
  return `${n}. ${text(step.do)}${where}${command}`;
}

function expiryWords(expiry: TokenExpiry): string {
  switch (expiry.kind) {
    case 'provider-reports':
      return 'Expiry: the service tells the gateway the date, and the account page warns before it.';
    case 'person-types':
      return `Expiry: about ${expiry.recommendedDays} days, chosen at the service; the service does not tell the gateway the date.`;
    case 'none':
      return `Expiry: ${text(expiry.reason)}`;
  }
}

function credentialMarkdown(c: CredentialInfo): string[] {
  const lines: string[] = [`### The way: ${credentialKindWords(c)}`, ''];
  if (c.reach) {
    lines.push(
      `How wide to grant — ${text(c.reach.what)}: ${text(c.reach.grant)}. ${text(c.reach.why)}`,
      '',
    );
  }
  if (c.steps.length > 0) {
    lines.push(...c.steps.map((step, i) => stepMarkdown(step, i + 1)), '');
  }
  if (c.createUrl) lines.push(`Where: [${c.createUrl}](${c.createUrl})`, '');
  if (c.permissions.length > 0) {
    lines.push(
      'Permissions to grant at the service, all of them: each mission narrows what an agent may do.',
      '',
      ...c.permissions.map(
        (p) => `- ${text(p.name)}: ${p.access} (for ${p.tools.map(code).join(', ')})`,
      ),
      '',
    );
  }
  if (c.expiry) lines.push(expiryWords(c.expiry), '');
  if (c.scopes.length > 0) lines.push(`Scopes asked: ${c.scopes.map(code).join(', ')}.`, '');
  if (c.fields.length > 0) {
    lines.push(
      'What the connect page asks:',
      '',
      ...c.fields.map(
        (f) =>
          `- ${text(f.label)}${f.secret ? ' (secret)' : ''}${f.help ? `: ${text(f.help)}` : ''}`,
      ),
      '',
    );
  }
  if (c.docsUrl) lines.push(`The service's documentation: [${c.docsUrl}](${c.docsUrl})`, '');
  return lines;
}

/**
 * `/docs/providers/<id>`: how an account of this service is connected. The
 * steps come from the plugin's declaration; the registration notes are the
 * hand-written "Credential" sections of the plugin's README, with their links
 * pointed at GitHub.
 */
export function connectPageMarkdown(plugin: PluginInfo, readmeCredentialSections: string): string {
  const lines: string[] = [
    `# Connect ${plugin.name}`,
    '',
    `An account of ${plugin.name} is connected once, on the instance, by a person who then gives missions access to its resources; the agent never receives the credential. ${text(plugin.description)}`,
    '',
  ];
  if (plugin.summary) lines.push(text(plugin.summary), '');
  lines.push(
    `Permissions, macro-actions and tools of this service: [${plugin.name} plugin](/plugins/${plugin.id}).`,
    '',
    '## How to connect',
    '',
    'On the instance: Accounts → Connect an account, then pick the service. Most services take a key the person creates at the service and pastes (a token, or for Gmail an app password); nobody declares anything beforehand. A service that signs people in through its own authorization (Miro) needs nothing either: the gateway registers its own client there the first time someone connects. Every instance has its own client: this gateway never uses one shared with another instance. Google takes no client registered that way: Google Calendar signs in through an OAuth broker the instance is enrolled with, which holds one client and keeps no token ([Your own OAuth broker](/docs/operations/oauth-broker)).',
    '',
  );
  plugin.credentials.forEach((c) => lines.push(...credentialMarkdown(c)));
  if (plugin.manualRevocation) {
    lines.push('## Disconnecting', '', text(plugin.manualRevocation), '');
  }
  if (readmeCredentialSections.trim() !== '') {
    lines.push(
      '## Registration notes from the plugin',
      '',
      `From the plugin's [README](${githubBlob(`${plugin.dir}/README.md`)}), written for the people who create the key.`,
      '',
      // The README's own headings start at level 2; under this section they move one level down.
      readmeCredentialSections.replace(/^(#{2,5}) /gm, '#$1 '),
      '',
    );
  }
  return lines.join('\n').trimEnd() + '\n';
}

/** The figures of a line, in the columns Gateways | Calls | Success. */
function figureCells(line: LineFigures): string[] {
  return [countWords(line.gateways), callsWords(line.calls), rateWords(line.successRate)];
}

/** The last versions the collector knows, newest first, or why there is none. */
function versionsTable(health: PluginHealth): string {
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
  ].join('\n');
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
