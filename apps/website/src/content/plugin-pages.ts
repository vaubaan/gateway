/**
 * The Markdown of the plugin pages (website spec §2.3, §2.4) and of the docs
 * page "Connect <service>" (§2.2). One string per page: the site renders it as
 * HTML and serves it as the page's Markdown twin.
 */
import { githubBlob, githubTree } from '../site/constants';
import { type Health, type HealthSnapshot, healthOf, healthWords } from './health';
import { code, markdownTable, text } from './markdown';
import type { GuideStep, TokenExpiry } from '@vaubaan/plugin-sdk';

import type { CredentialInfo, MacroActionEntryInfo, PluginInfo } from './plugins';
import { thresholdsSentence, type ValidationThresholds } from './thresholds';

export interface PluginWithHealth extends PluginInfo {
  readonly health: Health;
}

export function withHealth(
  plugins: readonly PluginInfo[],
  snapshot: HealthSnapshot,
  thresholds: ValidationThresholds,
): PluginWithHealth[] {
  return plugins.map((p) => ({ ...p, health: healthOf(snapshot, p.id, p.version, thresholds) }));
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
    `- Health: ${healthWords(plugin.health)} — [what this means](/plugins/health)`,
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
        ['Tool', 'What it does'],
        plugin.tools.map((tool) => [code(tool.name), text(tool.title ?? tool.description)]),
      ),
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
    `Health: ${healthWords(plugin.health)}. A plugin version is deemed validated by the community with ${thresholdsSentence(thresholds)}, as reported by the instances whose operators turned community telemetry on. It is a community signal, not a security guarantee.`,
    '',
  );
  return lines.join('\n').trimEnd() + '\n';
}

function credentialKindWords(c: CredentialInfo): string {
  switch (c.kind) {
    case 'oauth2':
      return 'by signing in at the service and allowing the gateway (nothing to create or paste: the gateway registers its own client there)';
    case 'api-key':
      return `with a ${c.label ?? 'key'} pasted by hand`;
    case 'ssh-key':
      return 'with a key pair the instance generates; you install its public key on the host';
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
      ...c.permissions.map((p) => `- ${text(p.name)}: ${p.access}`),
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
    'On the instance: Accounts → Connect an account, then pick the service. Most services take a key the person creates at the service and pastes (a token, or for Gmail an app password); nobody declares anything beforehand. A service that signs people in through its own authorization (Miro) needs nothing either: the gateway registers its own client there the first time someone connects. Every instance has its own client: this gateway never uses one shared with another instance.',
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

/** `/plugins`: every plugin, with its version and health. */
export function pluginListMarkdown(plugins: readonly PluginWithHealth[]): string {
  return [
    '# Plugins',
    '',
    `A plugin teaches Vaubaan Gateway one service: how to classify a call into permissions, how to execute it, how to connect an account. ${plugins.length} plugins ship with the gateway; this list is generated from the repository's \`plugins/\` folder.`,
    '',
    markdownTable(
      ['Plugin', 'Version', 'Permissions', 'Health'],
      plugins.map((p) => [
        `[${p.name}](/plugins/${p.id})`,
        code(p.version),
        String(p.risks.length),
        healthWords(p.health),
      ]),
    ),
    '',
    `Write a plugin for another service: the [plugin guide](${githubBlob('plugins/README.md')}) and the kit in [plugins/_template](${githubTree('plugins/_template')}). Every plugin as data: [/plugins.json](/plugins.json).`,
    '',
  ].join('\n');
}

/** `/plugins/health`: the thresholds and every plugin version's status. */
export function healthPageMarkdown(
  plugins: readonly PluginWithHealth[],
  thresholds: ValidationThresholds,
  snapshot: HealthSnapshot,
): string {
  const when = snapshot.fetchedAt
    ? `The figures below were read from the collector when this site was built (${snapshot.fetchedAt.slice(0, 16).replace('T', ' ')} UTC).`
    : 'The collector could not be read when this site was built, so no figure is shown.';
  return [
    '# Plugin health',
    '',
    `Plugin health says, per plugin version, how many calls the instances that opted in to community telemetry reported, and how many worked. A version is deemed validated with ${thresholdsSentence(thresholds)}; below the minimum of reports the site says "not enough reports yet" and shows no rate.`,
    '',
    when,
    '',
    markdownTable(
      ['Plugin', 'Version', 'Health'],
      plugins.map((p) => [`[${p.name}](/plugins/${p.id})`, code(p.version), healthWords(p.health)]),
    ),
    '',
    '## How it is measured',
    '',
    `- Telemetry is off on every instance unless its operator turns it on; what an instance sends is listed on the [trust center](/trust#what-leaves-an-instance).`,
    `- Every outcome that is not a success counts against the rate, including a provider refusing a call the agent got wrong: the rate measures calls that worked, not the plugin's code alone.`,
    `- Anyone can send reports, so a determined party could skew a plugin's figures; the thresholds and a global ingestion limit raise the cost, they do not remove it. The status is a community signal, not a security guarantee.`,
    `- The thresholds live in one SQL function of the collector, [\`plugin_validation_thresholds()\`](${githubBlob('deploy/collector/schema.sql')}), published in the [collector's README](${githubBlob('deploy/collector/README.md')}#published-thresholds).`,
    '',
  ].join('\n');
}
