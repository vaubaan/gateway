/**
 * The Markdown of the plugin pages (website spec §2.3, §2.4) and of the docs
 * page "Connect <service>" (§2.2). One string per page: the site renders it as
 * HTML and serves it as the page's Markdown twin.
 */
import { githubBlob, githubTree } from '../site/constants';
import { type Health, type HealthSnapshot, healthOf, healthWords } from './health';
import { code, markdownTable, text } from './markdown';
import type { CredentialInfo, PluginInfo, PresetEntryInfo } from './plugins';
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

export function statusWord(plugin: Pick<PluginInfo, 'experimental'>): string {
  return plugin.experimental ? 'experimental' : 'stable';
}

const EXPERIMENTAL_NOTE =
  'Experimental: the gateway registers this plugin and classifies its calls, but keeps it out of the connect and mission flows and lists none of its tools to agents.';

function windowWords(seconds: number): string {
  if (seconds === 60) return 'minute';
  if (seconds === 3600) return 'hour';
  if (seconds === 86400) return 'day';
  return `${seconds} s`;
}

function presetRow(entry: PresetEntryInfo, labels: ReadonlyMap<string, string>): string[] {
  return [
    code(entry.riskId),
    text(labels.get(entry.riskId) ?? ''),
    String(entry.quota),
    `${entry.rateMax} per ${windowWords(entry.rateWindowSeconds)}`,
    entry.gate === 'approval' ? 'ask me first' : 'runs freely',
  ];
}

export function pluginPageTitle(plugin: Pick<PluginInfo, 'name'>): string {
  return `${plugin.name} plugin`;
}

export function pluginPageDescription(plugin: PluginInfo): string {
  return `${plugin.name} plugin of Vaubaan Gateway, version ${plugin.version}: ${plugin.risks.length} permissions, ${plugin.presets.length} presets, ${plugin.tools.length} tools.`;
}

/** `/plugins/<id>`: what the plugin covers, its permissions, presets, tools and health. */
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
    `- Status: ${statusWord(plugin)}`,
    `- Health: ${healthWords(plugin.health)} — [what this means](/plugins/health)`,
    `- Source: [${plugin.dir}](${githubTree(plugin.dir)}), catalog [risk-catalog.yaml](${githubBlob(`${plugin.dir}/src/risk-catalog.yaml`)})${plugin.catalogVersion !== null ? ` version ${plugin.catalogVersion}` : ''}${plugin.catalogDate ? ` of ${plugin.catalogDate}` : ''}`,
    `- How to connect an account: [Connect ${plugin.name}](/docs/providers/${plugin.id})`,
  ];
  if (plugin.docsUrl) lines.push(`- How it is modelled: [handbook](${plugin.docsUrl})`);
  lines.push('');
  if (plugin.experimental) lines.push(EXPERIMENTAL_NOTE, '');
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
    '## Presets',
    '',
    'A preset pre-fills the permissions of a mission for one account, with a limit per period, a rate and whether each permission runs freely or asks the mission creator first. The person creating the mission adjusts it; the mission stores the explicit list.',
    '',
  );
  for (const preset of plugin.presets) {
    lines.push(
      `### ${text(preset.label)}`,
      '',
      `${code(preset.id)} — ${text(preset.description)}`,
      '',
      markdownTable(
        ['Permission', 'What it allows', 'Limit per period', 'Rate', 'Runs'],
        preset.entries.map((entry) => presetRow(entry, labels)),
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
  if (plugin.tokenHandouts.length > 0) {
    lines.push(
      'Tools that hand the agent a short-lived provider token (the one exception to "the agent never holds a credential"), each a permission of its own:',
      '',
      ...plugin.tokenHandouts.map((h) => `- ${code(h.tool)}: ${h.riskIds.map(code).join(', ')}`),
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
      return "through your company's OAuth client at the service (one click once an administrator declared it)";
    case 'api-key':
      return `with a ${c.label ?? 'key'} pasted by hand`;
    case 'ssh-key':
      return 'with a key pair the instance generates; you install its public key on the host';
  }
}

function credentialMarkdown(c: CredentialInfo): string[] {
  const lines: string[] = [`### The way: ${credentialKindWords(c)}`, ''];
  if (c.steps.length > 0) {
    lines.push(...c.steps.map((step, i) => `${i + 1}. ${text(step)}`), '');
  }
  if (c.createUrl) lines.push(`Where: [${c.createUrl}](${c.createUrl})`, '');
  if (c.permissions.length > 0) {
    lines.push(
      'Permissions to grant at the service, and no more:',
      '',
      ...c.permissions.map((p) => `- ${text(p.name)}: ${p.access}`),
      '',
    );
  }
  if (c.recommendedExpiryDays !== null) {
    lines.push(`Recommended expiry: ${c.recommendedExpiryDays} days.`, '');
  }
  if (c.scopes.length > 0) lines.push(`Scopes asked: ${c.scopes.map(code).join(', ')}.`, '');
  if (c.fields.length > 0) {
    lines.push(
      c.kind === 'oauth2'
        ? 'What the administrator enters for the OAuth client:'
        : 'What the connect page asks:',
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
  if (plugin.experimental) lines.push(EXPERIMENTAL_NOTE, '');
  if (plugin.summary) lines.push(text(plugin.summary), '');
  lines.push(
    `Permissions, presets and tools of this service: [${plugin.name} plugin](/plugins/${plugin.id}).`,
    '',
    '## How to connect',
    '',
    'On the instance: Accounts → Connect an account, then pick the service. A service that signs people in through its own authorization (Gmail) needs its OAuth client declared once by an administrator, on the same page, or set in the configuration (`providers.<id>.*`, see [configuration keys](/docs/configuration/keys)). Every instance declares its own client: this gateway never uses one shared with another instance.',
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
      `From the plugin's [README](${githubBlob(`${plugin.dir}/README.md`)}), written for the people who create the token or declare the OAuth client.`,
      '',
      // The README's own headings start at level 2; under this section they move one level down.
      readmeCredentialSections.replace(/^(#{2,5}) /gm, '#$1 '),
      '',
    );
  }
  return lines.join('\n').trimEnd() + '\n';
}

/** `/plugins`: every plugin, with its version, status and health. */
export function pluginListMarkdown(plugins: readonly PluginWithHealth[]): string {
  return [
    '# Plugins',
    '',
    `A plugin teaches Vaubaan Gateway one service: how to classify a call into permissions, how to execute it, how to connect an account. ${plugins.length} plugins ship with the gateway; this list is generated from the repository's \`plugins/\` folder.`,
    '',
    markdownTable(
      ['Plugin', 'Version', 'Status', 'Permissions', 'Health'],
      plugins.map((p) => [
        `[${p.name}](/plugins/${p.id})`,
        code(p.version),
        statusWord(p),
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
