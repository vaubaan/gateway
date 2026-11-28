import { ACCOUNT_PAGES } from './accounts';
import { PAGES } from './common';
import { SETTINGS_PAGES } from './settings';

// ─────────────────────────────────────────────────────────────────────────────
// Doc hints: the (i) of a page header, and a few inside a form, show the
// context of where one is in a small popover — the target's label in bold, its
// `hint` — and a last line leading to the page of the user docs that explains
// it (`docs.url`, default vaubaan.com/docs). One table; `lib/docs-links.ts`
// builds the address, and `tests/unit/app/doc-links.test.ts` fails when a path
// or an anchor has no page in `apps/website/content/docs`, or a hint is empty
// or longer than `DOC_HINT_MAX`. A path is relative to the docs root and may
// end with `#<heading slug>`; a service's page is the sibling `../plugins/<id>`.
// ─────────────────────────────────────────────────────────────────────────────

/** The longest a hint's text may be: 1 to 3 short sentences. */
export const DOC_HINT_MAX = 240;

export interface DocTarget {
  /** What the hint is about, in the interface's words: its bold title. */
  readonly label: string;
  /** The context of where one is: 1 to 3 short sentences, present tense, at most `DOC_HINT_MAX`. */
  readonly hint: string;
  /** Relative to the docs root: `missions#create-a-mission`, `../plugins/github`. */
  readonly path: string;
}

export const DOC_PAGES = {
  now: {
    label: PAGES.now.title,
    path: 'interface#now',
    hint: 'The home: what waits for your answer comes first, then the missions running, one line each. A yes is never given from here: an approval opens its request, where the exact call is shown.',
  },
  waiting: {
    label: PAGES.waiting.title,
    path: 'interface#waiting-for-you',
    hint: 'What your missions ask of you, oldest first: a call to approve, a limit reached, a permission an agent asks for. Only the mission’s creator answers; the agent replays its call once you have.',
  },
  missions: {
    label: PAGES.missions.title,
    path: 'missions',
    hint: 'A mission is the key an agent works with: the accounts and resources it reaches, what it may do on each, and limits per period. Every call goes through this gateway and is checked against it.',
  },
  newMission: {
    label: PAGES.newMission.title,
    path: 'missions#create-a-mission',
    hint: 'Name the task, include the accounts it needs and select only the resources it uses, then tick what the agent may do at a trust level. The key is shown once, with the kit to hand to the agent.',
  },
  mission: {
    label: 'A mission',
    path: 'missions#the-mission-page',
    hint: 'Its state, what waits for your answer on it, what it holds card by card with how much of each limit the period has used, and who holds a key. Edit, stop or replace your key from the header.',
  },
  editMission: {
    label: 'Edit mission',
    path: 'missions#edit-a-mission',
    hint: 'Only the creator edits a mission, and everything can change but the period. Every key gets the change at once; keys, history and what the period used stay.',
  },
  missionActivity: {
    label: 'The activity of a mission',
    path: 'missions#the-activity-of-a-mission',
    hint: 'What waits for an answer, who called in the current period, per key holder and per agent label, the timeline of its calls and changes, and what each permission used, this period and before.',
  },
  accounts: {
    label: PAGES.accounts.title,
    path: 'accounts',
    hint: 'The accounts at a service plugged into this gateway: yours, alone or with a team, and the parts of colleagues’ accounts shared with you. Agents reach an account only through a mission.',
  },
  connect: {
    label: ACCOUNT_PAGES.connect.title,
    path: 'services',
    hint: 'Choose a service, then plug in one of your accounts there, once: a key you create and paste, or a sign-in at the service. The secret is stored encrypted and no agent ever sees it.',
  },
  account: {
    label: 'An account',
    path: 'accounts#an-account',
    hint: 'Its state, its resources, who has access and the missions that use it. Reconnect replaces the key without touching the missions; Disconnect stops them all and deletes nothing at the service.',
  },
  giveAccess: {
    label: 'Give access',
    path: 'accounts#give-access',
    hint: 'Let a person or a team create missions on this account, within the permissions you tick and never beyond. What is kept is that explicit list, never “everything”.',
  },
  activity: {
    label: PAGES.activity.title,
    path: 'interface#activity',
    hint: 'The record of every call, allowed or refused, and of every change a person made, newest first. Filter it, and open a line for its key, the permissions it touched and what is left.',
  },
  activityOverview: {
    label: 'The overview',
    path: 'interface#the-overview',
    hint: 'Each mission at a glance over today, 7 or 30 days: calls allowed, refused and waiting, bytes sent and received, use per action, who holds the keys, and what stops working soon. Every number opens the Record or the Timeline.',
  },
  activityTimeline: {
    label: 'The timeline',
    path: 'interface#the-timeline',
    hint: 'What happened in each mission, newest first, in the words of its own page: calls, requests and their answers, resets, limits and keys. Filter by mission, key holder or agent label.',
  },
  reference: {
    label: PAGES.reference.title,
    path: '../plugins',
    hint: 'What an agent can do on each service, permission by permission, as this gateway’s plugins declare it. Read-only: nothing here changes anything.',
  },
  settings: {
    label: PAGES.settings.title,
    path: 'interface#settings',
    hint: 'Your own settings: the theme, your security, notifications, signing out everywhere. Administrators also set up this gateway from here.',
  },
  notifications: {
    label: SETTINGS_PAGES.notifications.title,
    path: 'missions/notifications',
    hint: 'Be told on this device, in a messaging channel or by mail when a mission asks you something or an account of yours needs reconnecting. No app to download: the interface installs from the browser.',
  },
  security: {
    label: 'Security',
    path: 'interface#security',
    hint: 'Your password, when this gateway keeps your sign-in, and your second factor. A new second factor gives recovery codes once, on this page: keep them apart.',
  },
  setup: {
    label: SETTINGS_PAGES.setup.title,
    path: 'administration#setup',
    hint: 'What this gateway needs before colleagues use it, as a checklist of what is done and what is left: a sign-in, administrators, accounts without owner, telemetry, the instance’s name.',
  },
  firstAdministrator: {
    label: 'The first administrator',
    path: 'install#first-sign-in',
    hint: 'The address and password the first administrator signs in with. That person administers this gateway from now on, and sets up a second factor at the first sign-in.',
  },
  signIn: {
    label: SETTINGS_PAGES.signIn.title,
    path: 'administration#sign-in',
    hint: 'How people sign in: your company’s OpenID Connect directory, GitHub, Google, Microsoft, or sign-ins kept by this gateway. Add one, test it in another window, then switch it on.',
  },
  people: {
    label: SETTINGS_PAGES.people.title,
    path: 'administration#people',
    hint: 'Everyone who has signed in, and how they came in; this gateway keeps no directory. Name the administrators here, or deactivate a person who leaves.',
  },
  teams: {
    label: SETTINGS_PAGES.teams.title,
    path: 'administration#teams',
    hint: 'A team owns accounts or receives access to them; it never creates a mission. Teams your sign-in directory sends are read-only here; local teams are kept by an administrator.',
  },
  telemetry: {
    label: SETTINGS_PAGES.telemetry.title,
    path: 'operations/telemetry',
    hint: 'Off until an administrator turns it on. It tells the project which plugins work, and this page shows the exact body of a report first. Never your arguments, resources, accounts or people.',
  },
  encryption: {
    label: SETTINGS_PAGES.encryption.title,
    path: 'administration#encryption',
    hint: 'The master key every stored secret is sealed with, and where it comes from. A backup cannot be opened without it: download it and keep it apart from the backups.',
  },
  plugins: {
    label: SETTINGS_PAGES.plugins.title,
    path: 'administration#plugins',
    hint: 'Every plugin this gateway runs, how many accounts each serves, and the updates the Vaubaan catalog published: each one applied in a click, started on trial. The catalog page installs the others.',
  },
  // Concepts that trip people, explained from inside a form (a few, no more).
  trustLevels: {
    label: 'Trust levels',
    path: 'concepts#trust-level',
    hint: 'Careful, Trusting or Autonomous. From how hard each permission is to undo, the level decides whether it runs freely, asks you first or is left out, and it raises the limits. Every line stays editable.',
  },
  futureResources: {
    label: 'Resources found later',
    path: 'missions#resources-found-later',
    hint: 'A card can also take the resources that appear on the account later with its environment label, discovered or relabelled. Without it, the mission reaches the resources it lists and no other.',
  },
  environmentLabels: {
    label: 'Environment labels',
    path: 'accounts#environment-labels',
    hint: 'The owner labels each resource with its environment, such as staging or prod. Some permissions exist for one environment only, and a mission’s card holds resources of one environment.',
  },
} as const satisfies Record<string, DocTarget>;

export type DocPageId = keyof typeof DOC_PAGES;

/** How an account of a service is plugged in (the plugin's `CredentialKind`). */
export type ConnectWay = 'oauth2' | 'api-key' | 'ssh-key' | 'host';

/**
 * "a" or "an" before `noun`, by its first sound: a vowel letter, except the
 * words that start with a "you" or "w" sound ("a user token", "a one-time
 * key") or a silent h ("an hourly key"). Never "a(n)".
 */
export function articleFor(noun: string): 'a' | 'an' {
  const word = noun.trim().toLowerCase();
  if (/^(uni|use|usu|uti|eu|one\b|once\b)/.test(word)) return 'a';
  if (/^(hour|honest|honou?r|heir)/.test(word)) return 'an';
  return /^[aeiou]/.test(word) ? 'an' : 'a';
}

/** What connecting an account of `service` involves, in the hint of its connect page. */
export function connectHint(service: string, way: ConnectWay, keyName?: string | null): string {
  switch (way) {
    case 'api-key': {
      const key = keyName ?? 'key';
      return `You create ${articleFor(key)} ${key} at ${service} and paste it once. It is checked, stored encrypted and never shown to an agent; each mission narrows what it reaches.`;
    }
    case 'oauth2':
      return `You sign in at ${service} and allow this gateway: nothing to create or paste. Each mission narrows what the account reaches.`;
    case 'ssh-key':
      return 'This gateway makes a key pair and keeps the private key; you install the public key on the host. Each mission narrows what it reaches.';
    case 'host':
      return 'Your own place on this gateway, in one click. A mission on it lets an agent prepare missions in your name, within what you hold.';
  }
}

/** A text cut to `DOC_HINT_MAX` at a word: for a sentence this table does not write (a plugin's). */
export function clampHint(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= DOC_HINT_MAX) return flat;
  const cut = flat.slice(0, DOC_HINT_MAX - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 1)).replace(/[\s,;:.—-]+$/, '')}…`;
}

/**
 * A service's page on the site, or its connect guide (`#connect`, spec website
 * §2.3 item 9). Its hint is `about`: the plugin's one-line description for the
 * page, what connecting involves (`connectHint`) for the guide.
 */
export function serviceDoc(
  id: string,
  name: string,
  part: 'page' | 'connect' = 'page',
  about?: string | null,
): DocTarget {
  return {
    label: name,
    hint: clampHint(about || `What an agent can do on ${name}, permission by permission.`),
    path: `../plugins/${encodeURIComponent(id)}${part === 'connect' ? '#connect' : ''}`,
  };
}

/** The accessible name of a hint's (i): "About <label>". */
export function docHintLabel(target: DocTarget): string {
  return `About ${target.label}`;
}

/** The accessible name of a hint's last line, which opens the docs in a new tab. */
export function docLinkLabel(target: DocTarget): string {
  return `Documentation: ${target.label} (opens in a new tab)`;
}
