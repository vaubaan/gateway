/**
 * The words of the landing page (website spec §2.1) and its questions and
 * answers (§2.6), written once: the page renders them, the FAQPage JSON-LD
 * carries them, the generator writes them as `/index.md`, and the README's
 * first lines repeat the promise and the defining sentence (a test holds it).
 * Every claim is true today, with a link to what proves it.
 */
import {
  CONSULTANT_CAVEAT,
  DEV_CAVEAT,
  sectionMarkdown,
  STATUS_WORDS,
  type Section,
} from './product-pages';

export interface Faq {
  readonly question: string;
  /** Plain text: quoted as is by the JSON-LD and the Markdown twin. */
  readonly answer: string;
}

/** The promise: the headline of the site and of the README. */
export const PROMISE = 'Let your agent work alone. It stops where you said.';

/** The defining sentence: the line under the promise, the page's description. */
export const LANDING_LEDE =
  'Vaubaan is an open-source MCP gateway you run yourself: your agent gets a mission instead of your credentials — named permissions, limits, and “ask me first” on what is hard to undo.';

export const PRE_RELEASE =
  'Pre-release: 2.0.0-alpha versions are published, breaking changes are expected until 2.0.0, and there has been no third-party security audit.';

/** One line of the hero's call log, per project. */
export interface LogLine {
  readonly outcome: 'runs' | 'refused' | 'waits';
  readonly call: string;
  readonly note: string;
}

export const HERO_LOG: Readonly<Record<'dev' | 'consultant', readonly LogLine[]>> = {
  dev: [
    { outcome: 'runs', call: 'github · read src/server.ts', note: 'runs' },
    { outcome: 'runs', call: 'git push origin feature/rate-limit', note: 'runs' },
    { outcome: 'runs', call: 'supabase · migrate staging', note: 'runs' },
    { outcome: 'refused', call: 'supabase · migrate production', note: 'resource-not-in-mission' },
    { outcome: 'waits', call: 'github · merge #142 into main', note: 'waiting for you' },
  ],
  consultant: [
    { outcome: 'runs', call: 'gmail · search from:acme.com', note: 'runs' },
    { outcome: 'runs', call: 'calendar · this week’s events', note: 'runs' },
    { outcome: 'runs', call: 'notion · append to “Acme / Weekly notes”', note: 'runs' },
    { outcome: 'refused', call: 'gmail · read “Invoice Q3” (Finance)', note: 'risk-not-accepted' },
    { outcome: 'waits', call: 'gmail · send the recap to jane@acme.com', note: 'waiting for you' },
  ],
};

export const LOG_TITLE: Readonly<Record<'dev' | 'consultant', string>> = {
  dev: 'Mission “Rate limiter for the API”',
  consultant: 'Mission “Weekly client recap”',
};

/** The steps of "Today, for you", each built or planned (spec §2.1, item 5). */
export const TODAY_STEPS: readonly {
  readonly text: string;
  readonly status: 'built' | 'planned';
}[] = [
  {
    text: 'See it work in [the demo](/docs/quick-look) on a laptop: simulated services, nothing to register.',
    status: 'built',
  },
  {
    text: 'Run [your own instance](/docs/install) on a small server, with Docker Compose or Railway, behind your sign-in.',
    status: 'built',
  },
  {
    text: 'Connect an account once: your key or your sign-in, encrypted on your instance.',
    status: 'built',
  },
  {
    text: 'Create a mission and give its key to your agent: the client configuration and the instructions to paste.',
    status: 'built',
  },
  {
    text: 'Run it on your computer with one docker run, without a server or a DNS name.',
    status: 'built',
  },
  {
    text: 'A desktop app for macOS and Windows, without Docker.',
    status: 'planned',
  },
  { text: 'Add a mission to your agent in one step.', status: 'planned' },
];

const NOT_A_TOKEN: Section = {
  id: 'not-a-token',
  heading: 'A mission, not a token',
  drawing: 'token-or-mission',
  body: {
    dev: 'The usual way is a token in the agent’s configuration: it can do everything the token allows, for as long as it lives, and nobody can say afterwards what it did. Your client’s approval prompt asks per tool, and only while you watch. Vaubaan decides on what the call does (a push to a feature branch is not a merge into main), counts every call, and keeps deciding while you are away.',
    consultant:
      'The usual way is an app password or a sign-in handed to the assistant: it can read and send every mail, for as long as it lives, and nobody can say afterwards what it did. Your assistant’s approval prompt asks per tool, and only while you watch. Vaubaan decides on what the call does (a draft is not a mail to a client), counts every call, and keeps deciding while you are away.',
  },
  link: { label: 'How Vaubaan compares', href: '/docs/compare' },
};

const THE_MISSION: Section = {
  id: 'the-mission',
  heading: 'You tick verbs. Vaubaan writes the lines.',
  drawing: 'two-ticks',
  body: 'A mission names the accounts and resources the agent may touch, the permissions it holds, each from the service’s reviewed catalog, a limit per day for each, and what asks you first. You do not write rules: you tick a few verbs and pick a trust level, Careful, Trusting or Autonomous, and every line is written out for you to read and edit.',
  link: {
    label: { dev: 'Read every GitHub permission', consultant: 'See what Gmail allows' },
    href: { dev: '/plugins/github', consultant: '/plugins/gmail' },
  },
};

const ASK_ME_FIRST: Section = {
  id: 'ask-me-first',
  heading: 'What is hard to undo waits for you',
  drawing: 'ask-me-first',
  body: {
    dev: 'A merge into main stops with `approval-required` and the address of the request. You read the exact call — the repository, the pull request, the method — and say yes or no; when you tell the agent, it replays the call and it runs. Everything outside the mission is refused with a reason the agent can read, and every call is recorded.',
    consultant:
      'A mail to a client stops with `approval-required` and the address of the request. You read the exact mail — the recipient, the subject, the text — and say yes or no; when you tell the assistant, it replays the call and the mail leaves. Everything outside the mission is refused with a reason the assistant can read, and every call is recorded.',
  },
  link: { label: 'How it works', href: '/how-it-works' },
};

const THEN_YOUR_TEAM: Section = {
  id: 'then-your-team',
  heading: 'Then your team',
  drawing: 'alone-then-team',
  body: {
    dev: 'The same instance, behind your identity provider or GitHub sign-in: accounts shared permission by permission, a key per person, the yes given from a phone, and Activity saying who did what.',
    consultant:
      'The same instance for your firm, behind your Google or Microsoft sign-in: accounts shared permission by permission, a key per person, the yes given from a phone, and Activity saying who did what.',
  },
  link: { label: 'Vaubaan for teams', href: '/teams' },
};

/** The sections drawn with a picture, in page order (spec §2.1, items 2, 3, 4 and 6). */
export const LANDING_SECTIONS = { NOT_A_TOKEN, THE_MISSION, ASK_ME_FIRST, THEN_YOUR_TEAM } as const;

/** "For the person who says yes": four lines each (spec §2.1, item 8), all on the trust center. */
export const PROTECTS: readonly string[] = [
  'The agent never holds a stored credential, git included: it holds a mission key.',
  'Credentials are encrypted at rest; one is decrypted in memory for the one call that needs it.',
  'Every call is decided against the mission and fails closed; limits and approvals are counted once.',
  'Every call is recorded, allowed or refused, with whose key made it.',
];

export const DOES_NOT: readonly string[] = [
  'Whoever runs the instance holds the master key: it does not defend against its own operator.',
  'Plugins run inside the gateway’s process; their signature is the boundary.',
  'One process, no high availability.',
  'No third-party audit yet.',
];

export function landingFaq(serviceNames: readonly string[]): Faq[] {
  const services = serviceNames.join(', ');
  return [
    {
      question: 'How do I let a coding agent use my accounts without giving it my credentials?',
      answer:
        'Run Vaubaan, connect your accounts to it once, and create a mission for the agent: the resources it may touch, the permissions it holds, the limits of each, and which actions ask you first. The agent receives a key for that mission and calls the services through Vaubaan over MCP; the credentials stay on your instance.',
    },
    {
      question: 'My agent already asks before a tool call. Why this?',
      answer:
        'A client’s prompt asks per tool, and only while you watch. Vaubaan decides on the call’s arguments (a push to a feature branch is not a merge into main), limits each permission per day, records every call, and keeps deciding while you are away; it asks you only for what is hard to undo.',
    },
    {
      question: 'What is an MCP gateway?',
      answer:
        'A server that sits between AI agents and the tools they call through the Model Context Protocol. Vaubaan exposes the tools of your services over MCP, decides every call against the agent’s mission, executes it with a credential the agent never sees, and records it.',
    },
    {
      question: 'Does the agent ever see a credential?',
      answer:
        'No stored credential is ever returned to an agent. Git goes through Vaubaan’s own remote, so no token leaves for a clone or a push. No tool hands the agent a service token, short-lived or not: a plugin that declares one is refused.',
    },
    {
      question: 'Can I run it on my laptop?',
      answer:
        'Yes: one docker run starts a real instance on your computer, for you alone, with no server and no DNS name. The demo also runs on a laptop, with simulated services. For a team, an instance runs on a server you reach over HTTPS. A desktop app for macOS and Windows, without Docker, is planned, not built.',
    },
    {
      question: 'Which services does it support?',
      answer: `One plugin per service: ${services}. The first person who connects a service installs its plugin, signed by Vaubaan. Each plugin is a catalog of named permissions grouped into verbs; a plugin for another service can be written with the plugin kit.`,
    },
    {
      question: 'Which agents and MCP clients work with it?',
      answer:
        'Any MCP client that can call a server over HTTP with a bearer header, such as Claude Code or Cursor: the mission key goes in the Authorization header. The project’s own development runs through Claude Code on a running instance, and its test suites drive Vaubaan with the official MCP client; the other clients follow their own documentation.',
    },
    {
      question: 'Is there a hosted version?',
      answer:
        'No. Vaubaan runs on your own infrastructure only: there is no hosted service and no account to create.',
    },
    {
      question: 'Is it ready for production?',
      answer:
        'Not yet. It is pre-release: 2.0.0-alpha versions are tagged and published as images, a handful of early instances run it, and breaking changes are expected until 2.0.0. It has had no third-party security audit. The known limitations are listed in the docs.',
    },
    {
      question: 'Does it send anything to the project?',
      answer:
        'Not by default. Community telemetry is off on a new instance. If an administrator turns it on, after seeing the exact body of a report, anonymous reports go to the project’s collector at telemetry.vaubaan.com. The trust center lists every field an instance sends.',
    },
    {
      question: 'What does it cost?',
      answer: 'Nothing. Vaubaan is open source under the Apache-2.0 licence; you run it yourself.',
    },
  ];
}

const LOG_WORDS = { runs: 'runs', refused: 'refused', waits: 'waits for you' } as const;

function logMarkdown(project: 'dev' | 'consultant'): string[] {
  return [
    `${LOG_TITLE[project]}:`,
    HERO_LOG[project]
      .map(
        (l) =>
          `- \`${l.call}\`: ${l.outcome === 'runs' ? 'runs' : `${LOG_WORDS[l.outcome]} (${l.note})`}`,
      )
      .join('\n'),
  ];
}

export function landingMarkdown(
  services: readonly { id: string; name: string }[],
  title = 'Vaubaan Gateway',
): string {
  return (
    [
      `# ${title}`,
      `${LANDING_LEDE}`,
      `**${PROMISE}**`,
      `${PRE_RELEASE} [What is not done](/docs/known-limitations).`,
      '[Try it](/try) · [How it works](/how-it-works) · [For consultants](/consultants)',
      ...logMarkdown('dev'),
      ...logMarkdown('consultant'),
      DEV_CAVEAT,
      CONSULTANT_CAVEAT,
      ...sectionMarkdown(NOT_A_TOKEN),
      ...sectionMarkdown(THE_MISSION),
      ...sectionMarkdown(ASK_ME_FIRST),
      '## Today, for you',
      TODAY_STEPS.map((s) => `- ${s.text} (${STATUS_WORDS[s.status].toLowerCase()})`).join('\n'),
      '[Try it](/try)',
      ...sectionMarkdown(THEN_YOUR_TEAM),
      '## Services',
      `${services.length} services, each modelled the same way: ${services.map((s) => `[${s.name}](/plugins/${s.id})`).join(', ')}. Your service is missing? [Write its plugin](/write-a-plugin).`,
      '## For the person who says yes',
      'It protects:',
      PROTECTS.map((p) => `- ${p}`).join('\n'),
      'It does not:',
      DOES_NOT.map((p) => `- ${p}`).join('\n'),
      '[The trust center](/trust)',
      '## Questions and answers',
      ...landingFaq(services.map((s) => s.name)).flatMap((f) => [`### ${f.question}`, f.answer]),
      'Source: [github.com/vaubaan/gateway](https://github.com/vaubaan/gateway), Apache-2.0.',
    ].join('\n\n') + '\n'
  );
}
