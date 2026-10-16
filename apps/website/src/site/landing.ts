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
  'Behind your identity provider (OpenID Connect) or GitHub sign-in.',
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
        'No stored credential is ever returned to an agent. One exception is named: a few tools exist to hand the agent a short-lived token, such as a GitHub installation token to clone or push; each is a permission of its own, refused unless the mission holds it.',
    },
    {
      question: 'Which services does it support?',
      answer: `One plugin per service ships with the gateway: ${services}. Each plugin is a catalog of named permissions with presets; a plugin for another service can be written from the kit in the repository.`,
    },
    {
      question: 'Which agents and MCP clients work with it?',
      answer:
        'Any MCP client that can call a server over HTTP with a bearer header, such as Claude Code or Cursor: the mission key goes in the Authorization header. The project’s own test suites drive the gateway with the official MCP client; no person has yet run Claude Code against a running instance.',
    },
    {
      question: 'Is there a hosted version?',
      answer:
        'No. Vaubaan Gateway runs on your own infrastructure only: there is no hosted service and no account to create. A managed offer may come later; nothing is open today.',
    },
    {
      question: 'Is it ready for production?',
      answer:
        'Not yet. It is pre-release: no version is tagged, no image is published, and the software has not been run in production. It has had no third-party security audit. The known limitations are listed in the docs.',
    },
    {
      question: 'Does it send anything to the project?',
      answer:
        'Not by default. Community telemetry is off on a new instance, and today nothing is sent even when it is turned on, because the project’s collector is not published yet. The trust center lists the exact fields an instance would send.',
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
    '**Pre-release.** No version is tagged and no image is published yet.',
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
