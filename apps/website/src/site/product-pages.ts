/**
 * The words of the product pages (website spec §2.1 bis): how it works, teams,
 * try it, write a plugin. Written once: the page renders them, the generator
 * writes them as the page's Markdown twin. A text that differs by project is
 * `{ dev, consultant }`; the page shows the one the switch picks, the twin
 * both. Every claim is true today; a planned thing says so where it is named.
 */
import { githubBlob } from './constants';
import { drawingMarkdown, type DrawingName, type Project } from './drawings';

/** Markdown, the same for both projects or one per project. */
export type Text = string | { readonly dev: string; readonly consultant: string };

export interface Link {
  readonly label: Text;
  readonly href: Text;
}

export interface Section {
  readonly id: string;
  readonly heading: string;
  readonly body: Text;
  readonly drawing?: DrawingName;
  /** Built or planned, said beside the heading (the honesty rule of the site). */
  readonly status?: 'built' | 'planned';
  readonly link?: Link;
}

export interface ProductPage {
  readonly path: string;
  readonly title: string;
  readonly description: string;
  readonly heading: string;
  /** The defining sentence: the first paragraph of the page and of its twin. */
  readonly lede: string;
  readonly primary: Link;
  readonly secondary?: Link;
  readonly sections: readonly Section[];
}

export const STATUS_WORDS = { built: 'Built', planned: 'Planned' } as const;

export function textFor(text: Text, project: Project): string {
  return typeof text === 'string' ? text : text[project];
}

export function isShared(text: Text): text is string {
  return typeof text === 'string';
}

const PROJECT_LABELS: Readonly<Record<Project, string>> = {
  dev: 'For a developer (GitHub, Supabase)',
  consultant: 'For a consultant (Gmail, Notion, Google Calendar)',
};

/** What the developer's services have run live (known limitations), said beside their examples. */
export const DEV_CAVEAT =
  'GitHub and Supabase: GitHub has run real tools on a live instance, Supabase its discovery only ([known limitations](/docs/known-limitations)).';

/** The line the consultant's examples carry until their services run live (spec §2.1). */
export const CONSULTANT_CAVEAT =
  'Gmail, Notion and Google Calendar: modelled from their public documentation and tested against doubles; none of them has run against the real service yet ([known limitations](/docs/known-limitations)).';

function textMarkdown(text: Text): string[] {
  if (isShared(text)) return [text];
  return [
    `**${PROJECT_LABELS.dev}.** ${text.dev}`,
    `**${PROJECT_LABELS.consultant}.** ${text.consultant}`,
  ];
}

function linkMarkdown(link: Link): string {
  if (isShared(link.label) && isShared(link.href)) return `[${link.label}](${link.href})`;
  return (['dev', 'consultant'] as const)
    .map((p) => `[${textFor(link.label, p)}](${textFor(link.href, p)})`)
    .join(' · ');
}

export function sectionMarkdown(section: Section): string[] {
  const heading = section.status
    ? `## ${section.heading} (${STATUS_WORDS[section.status].toLowerCase()})`
    : `## ${section.heading}`;
  return [
    heading,
    ...(section.drawing ? [drawingMarkdown(section.drawing, 'dev')] : []),
    ...textMarkdown(section.body),
    ...(section.link ? [linkMarkdown(section.link)] : []),
  ];
}

export function productPageMarkdown(page: ProductPage): string {
  return `${[
    `# ${page.title}`,
    page.lede,
    linkMarkdown(page.primary) + (page.secondary ? ` · ${linkMarkdown(page.secondary)}` : ''),
    ...page.sections.flatMap(sectionMarkdown),
  ].join('\n\n')}\n`;
}

const INSTALL_WITH_AGENT = '/docs/install/with-your-coding-agent';
const TRY: Link = { label: 'Try it', href: '/try' };

export const HOW_IT_WORKS: ProductPage = {
  path: '/how-it-works',
  title: 'How it works',
  description:
    'What happens to an agent’s call in Vaubaan: the mission it is checked against, the question every permission answers, how a service is modelled, the yes you give, and what the agent sees.',
  heading: 'How a call goes through Vaubaan',
  lede: 'Your agent calls a tool with a mission key; Vaubaan names the permission the call needs, checks it against the mission and its limits, then runs it with a credential the agent never sees, asks you first, or refuses it with a reason the agent can read.',
  primary: TRY,
  secondary: {
    label: { dev: 'Read GitHub’s permissions', consultant: 'Read Gmail’s permissions' },
    href: { dev: '/plugins/github', consultant: '/plugins/gmail' },
  },
  sections: [
    {
      id: 'the-path-of-a-call',
      heading: 'The path of a call',
      drawing: 'path-of-a-call',
      body: {
        dev: 'The same path for every tool and every git push. The service’s plugin turns the call into the permissions it touches, from the call’s own arguments: a push to `feature/rate-limit` and a merge into `main` are two permissions. Vaubaan decides at once — the call runs, waits for your yes, or is refused — and records it with the permissions it needed and whose key made it.',
        consultant:
          'The same path for every mail, page and event. The service’s plugin turns the call into the permissions it touches, from the call’s own arguments: a mail to yourself and a mail to a client are two permissions. Vaubaan decides at once — the call runs, waits for your yes, or is refused — and records it with the permissions it needed and whose key made it.',
      },
    },
    {
      id: 'one-question',
      heading: 'One question for every permission',
      drawing: 'repair-scale',
      body: 'If your agent gets it wrong, how hard is it to repair? Each permission of a service’s catalog answers it with five facts — can it be undone, how far does it reach, what data does it touch, what can it cost, who sees it — and lands on one of four rows: Harmless, Worth a look, Repairable at a price, Cannot be repaired. The plugin’s author writes the facts; reviewers read them like code.',
      link: { label: 'The words of Vaubaan', href: '/docs/concepts' },
    },
    {
      id: 'modelled-then-verbs',
      heading: 'Each service modelled, then folded into verbs',
      drawing: 'modelled-then-verbs',
      body: {
        dev: 'Supabase, for instance: a project carries the environment, so applying a migration is one permission per environment, and writing rows in bulk has no production form at all. The permissions then fold into a few verbs a person ticks.',
        consultant:
          'Gmail, for instance: Vaubaan adds what Gmail does not know — who wrote a mail and who receives it, read from your domains and your client list — so sending is four permissions, one per kind of recipient, each on its own row. The permissions then fold into a few verbs a person ticks.',
      },
    },
    {
      id: 'trust-levels',
      heading: 'You tick verbs; the trust level writes each line',
      drawing: 'two-ticks',
      body: 'Careful, Trusting or Autonomous: the trust level of a verb sets each permission’s gate from its row — runs freely, asks you first, or left out — and multiplies its daily limit by one, three or ten. The mission holds every line explicitly, and each stays editable.',
    },
    {
      id: 'the-map',
      heading: 'Every permission of a service, on one page',
      drawing: 'the-map',
      body: 'Each service has a page on this site, generated from its catalog: how it is modelled, its verbs, the map of its permissions by row, a few real calls and how to connect an account.',
      link: {
        label: { dev: 'Open GitHub’s page', consultant: 'Open Gmail’s page' },
        href: { dev: '/plugins/github', consultant: '/plugins/gmail' },
      },
    },
    {
      id: 'ask-me-first',
      heading: 'Ask me first',
      drawing: 'ask-me-first',
      body: 'Nothing waits inside Vaubaan. A call that needs your yes is refused with `approval-required` and the address of the request; you read the exact call and approve it, and the approval is bound to that mission, permission, tool and arguments, used once. When you tell the agent, it replays the call and it runs. An agent learning your answer on its own is planned.',
      link: { label: 'When a call is refused', href: '/docs/missions#when-a-call-is-refused' },
    },
    {
      id: 'what-your-agent-sees',
      heading: 'What your agent sees',
      drawing: 'agent-terminal',
      body: 'Tool calls that run, and refusals with a code it can act on — `resource-not-in-mission`, `risk-not-accepted`, `budget-exhausted`, `approval-required` — with the address of the request when your yes is needed. Any MCP client that sends a bearer header works, such as Claude Code or Cursor.',
      link: { label: 'Connect your agent', href: '/docs/missions/mcp-clients' },
    },
    {
      id: 'does-it-slow-my-agent',
      heading: 'Does it slow my agent?',
      body: 'One more hop, to an instance you run: each call is decided and run, or refused, at once, and no call is held open waiting for a person. A measured figure per release is planned.',
    },
  ],
};

export const TEAMS: ProductPage = {
  path: '/teams',
  title: 'Vaubaan for teams',
  description:
    'Run Vaubaan on a server for your team: the same missions behind your sign-in, accounts shared permission by permission, one key per person, every call recorded.',
  heading: 'Then your team',
  lede: 'A team runs the same Vaubaan on a server: people sign in through your identity provider, GitHub or the instance’s own accounts, accounts are shared permission by permission, each person holds their own keys, and every call says whose key made it.',
  primary: { label: 'Install with your coding agent', href: INSTALL_WITH_AGENT },
  secondary: { label: 'Every step', href: '/docs/install' },
  sections: [
    {
      id: 'same-missions-more-people',
      heading: 'The same missions, more people',
      drawing: 'alone-then-team',
      body: [
        '- **Sign-in**: OpenID Connect (Google and Entra ID run live), GitHub, or accounts kept by the instance with a second factor.',
        '- **Shared accounts, not shared credentials**: an account’s owner gives a person or a team the permissions they may use in a mission; the credential stays encrypted on the instance.',
        '- **One key per person**: a teammate working on your mission holds a key of their own; replace or stop it alone.',
        '- **The yes from a phone**: install the instance as a web app and answer what waits for you; the mission’s creator answers.',
        '- **Who did what**: Activity lists every call and every change, by mission, account, decision and key holder.',
      ].join('\n'),
      link: { label: 'Accounts and teams', href: '/docs/accounts' },
    },
    {
      id: 'what-one-instance-is',
      heading: 'What one instance is',
      body: 'One image, one process, one embedded database, behind your TLS proxy. There is no high availability: a restart is an outage, and what changed since the last scheduled backup is lost with the host. People removed at your identity provider stay active until an administrator deactivates them.',
      link: { label: 'Every known limitation', href: '/docs/known-limitations' },
    },
    {
      id: 'for-your-security-reviewer',
      heading: 'For your security reviewer',
      body: 'Send them the trust center: what Vaubaan protects and what it does not, what leaves an instance, the supply chain, the accepted risks and how to report a vulnerability. Vaubaan is pre-release and has had no third-party audit; the page says so too.',
      link: { label: 'The trust center', href: '/trust' },
    },
    {
      id: 'install-it',
      heading: 'Install it',
      status: 'built',
      body: 'Two ways: [Docker Compose](/docs/install/docker-compose) on a host with a DNS name and ports 80 and 443, or [Railway](/docs/install/railway). Or paste [one block into your coding agent](/docs/install/with-your-coding-agent): it installs with Compose, asks you what only you know, and checks the result. The first sign-in and every yes stay with you.',
    },
  ],
};

export const TRY_PAGE: ProductPage = {
  path: '/try',
  title: 'Try it',
  description:
    'How to start with Vaubaan today: the demo on a laptop, your own instance on a server, or an install by your coding agent; what each needs and what you will see. A desktop app is planned.',
  heading: 'Try Vaubaan',
  lede: 'Three ways to start today, from a demo on your laptop to your own instance behind your sign-in; a desktop app for macOS and Windows is planned, and this page will offer it first the day it ships.',
  primary: { label: 'Run the demo', href: '/docs/quick-look' },
  secondary: { label: 'Install for a team', href: '/teams' },
  sections: [
    {
      id: 'the-demo',
      heading: 'See it work: the demo',
      status: 'built',
      body: 'The whole interface on your laptop with seeded people, accounts and missions, a simulated sign-in and simulated services: nothing to register, nothing leaves your machine. Needs Node.js 26, npm 11 and a clone of the repository; the first start builds the application. You will see missions in every state, a merge waiting for a yes, a limit reached, and every call in Activity.',
      link: { label: 'Run the demo', href: '/docs/quick-look' },
    },
    {
      id: 'your-own-instance',
      heading: 'Your own instance',
      status: 'built',
      body: 'One image on a host you run, with a DNS name and ports 80 and 443 (Docker Compose), or a Railway service. People sign in through your identity provider, GitHub, or the instance’s own accounts. Then connect an account, create a mission and give its key to your agent. Count an evening the first time.',
      link: { label: 'Install an instance', href: '/docs/install' },
    },
    {
      id: 'with-your-coding-agent',
      heading: 'Let your coding agent install it',
      status: 'built',
      body: 'Paste one block into Claude Code, Cursor or any agent with a shell on the host: it installs with Docker Compose, asks you the domain and the administrators, and checks the result.',
      link: { label: 'The block to paste', href: INSTALL_WITH_AGENT },
    },
    {
      id: 'on-your-computer',
      heading: 'On your computer, without a server',
      status: 'planned',
      drawing: 'alone-then-team',
      body: `A desktop app for macOS and Windows: Vaubaan on your own machine, without a DNS name or an identity provider. It is not built; there is nothing to download yet. What it will do is written down as [proposed intents](${githubBlob('docs/intents/run-vaubaan-on-my-computer.md')}).`,
    },
  ],
};

export const WRITE_A_PLUGIN: ProductPage = {
  path: '/write-a-plugin',
  title: 'Write a plugin',
  description:
    'Add a service to Vaubaan: model it, answer five questions for each permission, start from the plugin kit and deploy to your own instance. What is built and what is planned.',
  heading: 'Write a plugin for your service',
  lede: 'A plugin teaches Vaubaan one service — its tools, how each call is cut into permissions, and five plain facts per permission that place it on a row — and you write it with the published kit, without reading the gateway’s code.',
  primary: {
    label: 'Start a plugin project',
    href: 'https://www.npmjs.com/package/@vaubaan/plugin-cli',
  },
  secondary: { label: 'The author guide', href: '/docs/plugins-guide' },
  sections: [
    {
      id: 'five-questions',
      heading: 'Five questions per permission',
      drawing: 'for-plugin-authors',
      body: 'Can it be undone? How far does it reach? What data does it touch? What can it cost? Who sees it? You answer in plain facts; Vaubaan places the permission on its row, the same way for every service, and a reviewer reads your answers like code.',
    },
    {
      id: 'model-the-service',
      heading: 'Model the service first',
      drawing: 'modelled-then-verbs',
      body: 'Name its planes and entities, and where the environment lives. Cut each act into permissions on the facts that change the harm — a branch, a recipient, an environment — and fold them into a few verbs a person ticks.',
    },
    {
      id: 'the-kit',
      heading: 'The kit',
      body: [
        '- **Start a plugin project** (built): `npx @vaubaan/plugin-cli init`, a complete plugin for an imaginary service, its tests passing, with the instructions a coding agent follows to replace it by yours.',
        '- **Deploy it to your instance** (built): the archive goes to your gateway, pending until an administrator activates it.',
        `- **Try a call without a gateway, run a local gateway, sign a private plugin, submit to the catalog** (planned): [the intents](${githubBlob('docs/intents/ship-a-plugin.md')}).`,
      ].join('\n'),
    },
    {
      id: 'read-a-real-one',
      heading: 'Read a real one',
      body: `How to write, test and deploy a plugin, step by step: the [author guide](/docs/plugins-guide). GitHub’s [risk catalog](${githubBlob('plugins/github/src/risk-catalog.yaml')}) and [its page on this site](/plugins/github), generated from it. The repository’s own plugins and how they are reviewed: [plugins/README.md](${githubBlob('plugins/README.md')}).`,
    },
  ],
};

export const PRODUCT_PAGES: readonly ProductPage[] = [
  HOW_IT_WORKS,
  TEAMS,
  TRY_PAGE,
  WRITE_A_PLUGIN,
];
