/**
 * The words of the landing page (website spec §2.1) and its questions and
 * answers (§2.6), written once: the page renders them, the FAQPage JSON-LD
 * carries them, and the generator writes them as `/index.md`.
 */

export interface Faq {
  readonly question: string;
  /** Plain text: quoted as is by the JSON-LD and the Markdown twin. */
  readonly answer: string;
}

export const LANDING_LEDE =
  'Vaubaan Gateway is a server you install on your own network so that coding agents can use your cloud services through MCP without being handed your credentials.';

export const LANDING_PROBLEM =
  'An agent that deploys, migrates a database or opens a pull request needs credentials, and the usual way is to paste a token into its configuration: the agent can then do anything the token allows, for as long as it lives, and nobody can say afterwards what it did.';

export const MISSION_POINTS: readonly { readonly term: string; readonly text: string }[] = [
  {
    term: 'Resources',
    text: 'the accounts and the resources the agent may touch: these two repositories, the staging project, this DNS zone.',
  },
  {
    term: 'Permissions',
    text: 'named, one by one, from each service’s catalog: write on feature branches, never merge; apply migrations on staging. Never “all”.',
  },
  {
    term: 'Limits',
    text: 'how many times per period and how fast, for each permission.',
  },
  {
    term: 'Ask me first',
    text: 'the actions that wait for the mission’s creator to say yes, where they see it.',
  },
  {
    term: 'A key per mission',
    text: 'the agent gets a key for that mission and nothing else; replace it or stop the mission at any time.',
  },
  {
    term: 'Credentials stay on the instance',
    text: 'the gateway runs each call with a credential it decrypts for that call only.',
  },
  {
    term: 'Everything recorded',
    text: 'every call, allowed or refused, with the permissions it needed and whose key made it.',
  },
];

export const SHAPE_POINTS: readonly string[] = [
  'On your network: one Docker image, one process, one embedded database, behind your TLS proxy.',
  'Behind your identity provider (OpenID Connect), GitHub sign-in, or the instance’s own sign-in accounts.',
  'With your company’s own apps at each service: no app shared with anyone else, no hosted tenant.',
];

export function landingFaq(serviceNames: readonly string[]): Faq[] {
  const services = serviceNames.join(', ');
  return [
    {
      question:
        'How do I let a coding agent use my cloud services without giving it my credentials?',
      answer:
        'Install Vaubaan Gateway on your network, connect your accounts to it once, and create a mission for the agent: the resources it may touch, the permissions it holds, the limits of each, and which actions ask you first. The agent receives a key for that mission and calls the services through the gateway over MCP; the credentials stay on the instance.',
    },
    {
      question: 'What is an MCP gateway?',
      answer:
        'A server that sits between AI agents and the tools they call through the Model Context Protocol. Vaubaan Gateway exposes the tools of your cloud services over MCP, decides every call against the agent’s mission, executes it with a credential the agent never sees, and records it.',
    },
    {
      question: 'Does the agent ever see a credential?',
      answer:
        'No stored credential is ever returned to an agent. Git goes through the gateway’s own remote, so no token leaves for a clone or a push. No tool hands the agent a service token, short-lived or not: a plugin that declares one is refused.',
    },
    {
      question: 'Which services does it support?',
      answer: `One plugin per service, from the catalog: ${services}. The first person who connects a service installs its plugin, signed by Vaubaan. Each plugin is a catalog of named permissions grouped into macro-actions; a plugin for another service can be written with the plugin kit.`,
    },
    {
      question: 'Which agents and MCP clients work with it?',
      answer:
        'Any MCP client that can call a server over HTTP with a bearer header, such as Claude Code or Cursor: the mission key goes in the Authorization header. The project’s own development runs through Claude Code on a running instance, and its test suites drive the gateway with the official MCP client; the other clients follow their own documentation.',
    },
    {
      question: 'Is there a hosted version?',
      answer:
        'No. Vaubaan Gateway runs on your own infrastructure only: there is no hosted service and no account to create.',
    },
    {
      question: 'Is it ready for production?',
      answer:
        'Not yet. It is pre-release: 2.0.0-alpha versions are tagged and published as images, a handful of early instances run it, and breaking changes are expected until v2.0.0. It has had no third-party security audit. The known limitations are listed in the docs.',
    },
    {
      question: 'Does it send anything to the project?',
      answer:
        'Not by default. Community telemetry is off on a new instance. If an administrator turns it on, after seeing the exact body of a report, anonymous reports go to the project’s collector at telemetry.vaubaan.com. The trust center lists every field an instance sends.',
    },
    {
      question: 'What does it cost?',
      answer:
        'Nothing. Vaubaan Gateway is open source under the Apache-2.0 licence; you run it on your own infrastructure.',
    },
  ];
}

export function landingMarkdown(serviceNames: readonly string[]): string {
  return [
    '# Vaubaan Gateway',
    '',
    LANDING_LEDE,
    '',
    '**Pre-release.** 2.0.0-alpha versions are tagged and published; expect breaking changes until v2.0.0.',
    '',
    '## The problem',
    '',
    LANDING_PROBLEM,
    '',
    '## The answer: missions',
    '',
    'A person creates a mission, and the gateway holds the agent to it:',
    '',
    ...MISSION_POINTS.map((p) => `- **${p.term}**: ${p.text}`),
    '',
    '## The shape',
    '',
    ...SHAPE_POINTS.map((p) => `- ${p}`),
    '',
    '## Supported services',
    '',
    serviceNames.join(', ') + '. Every plugin: [/plugins](/plugins).',
    '',
    '## Try it',
    '',
    '- [Try the demo](/docs/quick-look): the whole interface on a laptop, nothing to register.',
    '- [Install an instance](/docs/install): Docker Compose or Railway.',
    '- [Trust center](/trust): what protects your credentials, and what does not.',
    '- [Source code](https://github.com/vaubaan/gateway), Apache-2.0.',
    '',
    '## Questions and answers',
    '',
    ...landingFaq(serviceNames).flatMap((f) => [`### ${f.question}`, '', f.answer, '']),
  ].join('\n');
}
