import { TERMS, capitalize, count, formatNumber } from './common';

// ─────────────────────────────────────────────────────────────────────────────
// Settings and administration (`/settings/**`, `/admin/**`). Protocol names:
// sign-in provider (identity provider), user, group,
// operator, bootstrap token, telemetry.
// ─────────────────────────────────────────────────────────────────────────────

export const SETTINGS_PAGES = {
  notifications: {
    title: 'Notifications',
    lede: 'The devices, messaging addresses and mail that tell you when something waits for you or stopped without you. A notification names a mission or an account; you answer in the interface.',
  },
  setup: {
    title: 'Setup',
    lede: 'What this gateway needs before your colleagues use it, and what is left to do.',
  },
  signIn: {
    title: 'Sign-in',
    lede: 'The sign-in providers people sign in through. No password is stored here, and one person signing in through two sign-in providers is two people.',
  },
  people: {
    title: 'People',
    lede: 'Everyone who has signed in. Deactivating a person refuses every call of their keys at once.',
  },
  teams: {
    title: 'Teams',
    lede: 'A team can own an account or receive an access; it never creates a mission.',
  },
  ownerless: {
    title: 'Accounts without owner',
    lede: 'An account whose owners all left keeps serving its missions, but nobody can reconnect it or give access until you name an owner.',
  },
  telemetry: {
    title: 'Telemetry',
    lede: 'Anonymous reports that say whether each service’s plugin works; nothing is sent until you turn it on.',
  },
  encryption: {
    title: 'Encryption',
    lede: 'The key every stored secret is sealed with. Without it, a backup of this gateway cannot be opened.',
  },
  plugins: {
    title: 'Plugins',
    lede: 'The plugins this gateway runs, and their updates.',
  },
  pluginsCatalog: {
    title: 'Catalog',
    lede: 'The plugins this gateway can run and does not yet, and your own plugins.',
  },
} as const;

/**
 * Notifications on a device (spec §4.2 bis): the Settings page and the line the home shows
 * the first time something waits. A yes is never given from a notification.
 */
const MAIL_UNAVAILABLE = 'This instance does not deliver mail.';
const NO_MAIL_ADDRESS = 'Your account has no mail address this gateway can write to.';

export const NOTIFICATION_WORDS = {
  subscribe: 'Receive notifications on this device',
  notNow: 'Not now',
  thisDevice: 'This device',
  yourDevices: 'Your devices',
  rename: 'Rename',
  remove: 'Remove',
  label: 'Name of the device',
  noDevice: 'No device receives your notifications.',
  noDeviceHint:
    'Subscribe this device above, then any other phone or computer you use: the home and the inbox stay the reference either way.',
  subscribed: 'This device receives your notifications.',
  unsupported: 'This browser cannot receive notifications.',
  installFirst:
    'On an iPhone or iPad, add this page to the Home Screen first (Share, then Add to Home Screen), open it from there, and come back here.',
  denied:
    'This browser refuses notifications from this gateway. Allow them in its site settings, then come back here.',
  offerTitle: 'Be told when something waits for you',
  offer:
    'This device can show a notification as soon as a mission asks you something. It names the mission and the tool, never the arguments.',
  added: 'This device will receive your notifications.',
  removeTitle: (label: string) => `Remove ${label}?`,
  removeConsequence:
    'It receives no notification any more. Nothing else changes; you can subscribe it again from that device.',
  dropped: { gone: 'dropped: its browser no longer accepts them' },
  addedOn: 'Added',
  lastDelivered: 'Last delivered',
  never: 'never',
  /** On Administration → People: how many channels a person has, never which. */
  receivesOn: (channels: number) =>
    `notified on ${count(channels, { one: 'channel', many: 'channels' })}`,
  renamed: 'Device renamed.',
  removed: 'Device removed: it receives no notification any more.',
  listHint:
    'A notification names the mission or the account and, for a request, the tool; never an argument. Opening it leads to the page where you answer.',
  problems: {
    'invalid-subscription': 'The browser gave a subscription this gateway cannot read.',
    'unsupported-push-service': 'This browser’s push service is not one this gateway posts to.',
    'invalid-label': 'Name the device in one line of 60 characters or fewer.',
    'too-many-devices': 'You have 20 devices already: remove one you no longer use first.',
    'not-found': 'You have no such device.',
  },
  /** The problems of the addresses and the mail switch, one sentence each, never the URL. */
  channelProblems: {
    'invalid-kind': 'Choose the service the address belongs to.',
    'invalid-label': 'Name the address in one line of 60 characters or fewer.',
    'invalid-address':
      'The address must be an https URL without a user name or password (for ntfy, a topic URL).',
    'wrong-host': 'This is not an incoming webhook address of the service you chose.',
    'private-destination':
      'This address leads inside a private network: the gateway posts only to the public internet.',
    'already-added': 'You have added this address already.',
    'too-many-addresses': 'You have 10 addresses already: remove one you no longer use first.',
    'test-failed': 'The test message was not received.',
    'address-not-found': 'You have no such address.',
    'mail-unavailable': MAIL_UNAVAILABLE,
    'no-mail-address': NO_MAIL_ADDRESS,
  },
  /** After `test-failed`: what the service answered, never the address. */
  testFailedWith: (status: number | null) =>
    status === null
      ? 'The test message was not received: the service did not answer. The address was not kept.'
      : `The test message was not received: the service answered ${status}. The address was not kept.`,
  failed: 'This device could not be subscribed. Try again.',
  device: 'Device',
  /** The first name of a device, from its browser and system ("Chrome on Android"). */
  deviceLabel: (browser: string | null, system: string | null) =>
    system ? `${browser ?? 'Browser'} on ${system}` : (browser ?? 'Browser'),
  /** The description of the installed interface (the web app manifest). */
  installed: 'Missions, accounts and what waits for you on this Vaubaan Gateway.',
  addresses: {
    title: 'Messaging addresses',
    lede: 'The incoming address of a channel of your company’s messaging service. The gateway posts a test message before keeping it, and never shows it again.',
    empty: 'No messaging address receives your notifications.',
    emptyHint:
      'In Slack, Teams, Discord or ntfy, make an incoming webhook for a channel only you or your team read, then paste its address here.',
    address: 'Address',
    kind: 'Service',
    label: 'Name',
    url: 'Incoming webhook address',
    urlHint:
      'Treat it as a password: whoever holds it can post to that channel. It is kept sealed and never shown again.',
    add: 'Add the address',
    kinds: {
      slack: 'Slack',
      teams: 'Microsoft Teams (Workflows)',
      discord: 'Discord',
      ntfy: 'ntfy',
      generic: 'Other (JSON)',
    },
    lastFailure: 'Last failure',
    failedWith: (status: number | null) => (status === null ? 'no answer' : `answered ${status}`),
    removeTitle: (label: string) => `Remove ${label}?`,
    removeConsequence:
      'It receives no notification any more, and its address is forgotten: paste it again to add it back.',
    added: 'Address added: the test message was received.',
    removed: 'Address removed: it receives no notification any more.',
    listHint:
      'A message names the mission or the account and, for a request, the tool; never an argument. The messaging service reads what it carries.',
    genericHint:
      'Other: any https address that accepts a JSON body { title, body, url, kind, instance }.',
  },
  mail: {
    title: 'Mail',
    unavailable: MAIL_UNAVAILABLE,
    noAddress: NO_MAIL_ADDRESS,
    to: (address: string) => `Mail to ${address}`,
    on: 'On: each notification is also a mail.',
    off: 'Off.',
    turnOn: 'Turn mail on',
    turnOff: 'Turn mail off',
    switchedOn: 'Mail notifications are on.',
    switchedOff: 'Mail notifications are off.',
  },
} as const;

export const SETTINGS_ACTIONS = {
  save: 'Save',
  declare: 'Declare',
  edit: 'Edit',
  remove: 'Remove',
  deactivate: 'Deactivate',
  reactivate: 'Reactivate',
  endSessions: 'Sign out everywhere',
  nameOwner: 'Name an owner',
  approve: 'Approve',
  disable: 'Disable',
  revokeApp: 'Disconnect',
  connectApp: 'Connect an app',
  turnOn: 'Turn telemetry on',
  turnOff: 'Turn telemetry off',
  regenerateInstanceId: 'Regenerate identifier',
  testSignIn: 'Test the sign-in',
  addTeam: 'Add a local team',
  addMember: 'Add',
  addSignInProvider: 'Add a sign-in provider',
  addTheSignInProvider: 'Add the sign-in provider',
  invite: 'Invite',
} as const;

/** Where a value comes from, when a page shows it and cannot change it. */
export const CONFIG_WORDS = {
  file: 'set in the mounted configuration',
  fileReadOnly: 'Set in the mounted configuration: change it there and restart.',
} as const;

/**
 * Plugins and the versions feed (ADR plugins-bundled-or-pinned-by-the-operator):
 * Administration › Plugins and the tag the Reference shows on a pinned plugin. A
 * version and a path are printed with `Mono` by the page, never inside these words.
 */
export const PLUGIN_WORDS = {
  listTitle: 'Installed',
  browseCatalog: 'Browse the catalog',
  update: (version: string) => `Update to ${version}`,
  updateTitle: (name: string) => `Update ${name}?`,
  updateConsequence: (name: string, from: string, to: string) =>
    `${name} goes from ${from} to ${to}, the version the Vaubaan catalog built and signed. It starts on trial: if it does not load, ${from} keeps serving.`,
  updateConfirm: 'Update',
  updateAll: (n: number) => `Update all (${formatNumber(n)})`,
  updateAllTitle: (n: number) => `Update ${formatNumber(n)} plugins?`,
  updateAllConsequence:
    'Each one gets the version the Vaubaan catalog built and signed, and starts on trial: one that does not load keeps its current version.',
  stop: 'Stop',
  stopTitle: (name: string) => `Stop ${name}?`,
  stopConsequence: (name: string, accounts: number) =>
    accounts > 0
      ? `From the next start, the version installed here no longer runs: the image’s version of ${name} serves its ${formatNumber(accounts)} ${accounts === 1 ? 'account' : 'accounts'} if it has one. Accounts with no plugin to serve them must be disconnected first.`
      : `From the next start, the version installed here no longer runs; ${name} stays in the catalog, to install again.`,
  stopConfirm: 'Stop',
  recorded: 'Recorded in the activity, like every change.',
  leftOut: (n: number) =>
    `${formatNumber(n)} more ${n === 1 ? 'plugin is' : 'plugins are'} left out by plugins.enabled:`,
  catalogTitle: 'In the catalog',
  catalogEmpty: 'This gateway already runs every plugin of the catalog it read.',
  install: 'Install',
  waitingTitle: 'Waiting for you',
  rollback: (version: string) => `Roll back to ${version}`,
  rollbackTitle: (name: string, version: string) => `Roll back ${name} to ${version}?`,
  rollbackConsequence: (name: string, from: string, to: string, unknown: number) =>
    `${name} goes back from ${from} to ${to}, the version it ran before. It starts on trial: if it does not load, ${from} keeps serving.${unknown > 0 ? ` ${to} does not know ${unknown === 1 ? 'this permission' : `these ${formatNumber(unknown)} permissions`} of ${from}, kept in missions and inert until a version knows ${unknown === 1 ? 'it' : 'them'} again:` : ''}`,
  rollbackConfirm: 'Roll back',
  bundled: 'bundled with the image',
  pinnedFrom: 'pinned from',
  replacesBundled: 'replaces bundled',
  /** The tag of a pinned plugin in the Reference. */
  pinned: 'pinned',
  replaces: 'replaces',
  pinnedTitle: 'Pinned by the operator in the plugins directory, not bundled with the image',
  disabled: 'disabled by plugins.enabled',
  serves: (accounts: number) => count(accounts, { one: 'account', many: 'accounts' }),
  servesNone: 'no account',
  reference: 'Reference',
  feedSection: 'What the versions feed reports',
  gatewayBehind: 'This gateway is behind the released version',
  preRelease: 'pre-release',
  pluginBehind: 'behind the released version',
  olderPin: 'pinned at an older version than the image bundles',
  advisoriesTitle: (n: number) =>
    `${n === 1 ? 'An advisory names' : `${formatNumber(n)} advisories name`} a version this gateway runs`,
  fixedIn: 'fixed in',
  checkNow: 'Check now',
  checkOff: 'The versions check is off (updates.check): this gateway reads no feed.',
  notReadYet:
    'The versions feed has not been read yet: it is read a minute after the start, then every day, from',
  readAt: 'Versions feed read',
  from: 'from',
  lastFailure: 'The last read failed',
  keptReport: 'what is shown is from the last read that succeeded.',
  failures: {
    unreachable: 'the feed could not be reached',
    timeout: 'the feed did not answer in time',
    'http-status': 'the feed answered with an error status',
    'too-large': 'the answer was too large',
    'not-json': 'the answer was not JSON',
    'not-a-feed': 'the answer was not a versions feed this gateway reads',
  },
  changes:
    'A plugin installed here runs as soon as it is activated, on trial: if it does not load, the previous version keeps serving. A plugin pinned in the plugins directory changes when the operator changes the directory, then restarts.',
  howToPin: 'How to pin a plugin',
  installed: 'installed here',
  replacesImage: 'replaces the image’s',
} as const;

/**
 * Installing plugins on Administration › Plugins (ADR
 * plugins-activated-by-an-administrator-on-trial; spec §4.2). A plugin id, a version and
 * a digest are printed with `Mono` by the page, never inside these words.
 */
export const INSTALL_WORDS = {
  uploadTitle: 'Install a plugin',
  uploadLede:
    'Upload the archive of a plugin (the .tgz that vaubaan-plugin build writes). Nothing of it runs until an administrator activates it.',
  archiveLabel: 'Plugin archive',
  upload: 'Upload',
  noDataDirectory:
    'This instance keeps its store in memory: a plugin can be pinned in the plugins directory, not installed here.',
  versionsTitle: 'Installed versions',
  states: {
    pending: 'waiting for activation',
    trial: 'starts on trial at the next start',
    active: 'active',
    previous: 'kept to go back to',
    failed: 'did not load',
    refused: 'refused',
    removed: 'removed',
  },
  trust: {
    unsigned: 'not signed',
    vaubaan: 'signed by Vaubaan',
    signer: 'signed by',
  },
  notVaubaan:
    'This plugin is not published by Vaubaan. Once active, its code runs inside the gateway, with access to every account of this instance.',
  uploadedBy: 'uploaded',
  viaMission: 'by an agent',
  running: 'Running now:',
  notRunning: 'Not running on this instance yet.',
  added: 'New permissions',
  deprecated: 'Deprecated permissions',
  unknownToIt: 'Permissions this version does not know (kept, inert)',
  none: 'none',
  accounts: (n: number) => `${formatNumber(n)} connected ${n === 1 ? 'account' : 'accounts'}`,
  missionsUsing: (n: number) =>
    n === 0
      ? 'No active mission uses this service'
      : `${formatNumber(n)} active ${n === 1 ? 'mission uses' : 'missions use'} this service`,
  typeToConfirm: (id: string) => `Type ${id} to confirm`,
  activate: 'Activate',
  goBack: 'Go back to this version',
  refuse: 'Refuse',
  followImage: 'Stop using the installed version',
  cannotRun: 'This gateway cannot run it',
  safeModeTitle: 'Safe mode: installed plugins are not running',
  safeModeLede:
    'plugins.safe_mode is on: this start runs the image’s plugins and the operator’s pins only. Every installed version is kept as it was; turn safe mode off and restart to run them again.',
  restartTitle: 'A restart applies the change',
  restartLede:
    'A version of a plugin the image or the plugins directory provides starts on trial at the next start. If it does not load, the previous version stays and this page says why.',
  restart: 'Restart now',
  done: {
    uploaded: 'Uploaded. It runs nothing until it is activated.',
    'catalog-installed':
      'Downloaded from the catalog, signature verified. It runs nothing until it is activated.',
    activated: 'Marked to start on trial at the next start.',
    'activated-live': 'Active: the next call of this service runs this version.',
    updated: 'Done: the new versions start on trial at the next start.',
    'updated-live': 'Done: the next call of each service runs its new version.',
    refused: 'Refused and deleted.',
    'followed-image': 'The installed version is no longer used from the next start.',
    restarting: 'Restarting: this page answers again once the instance is back.',
    'signer-added': 'The signer is trusted. Every administrator was told.',
    'signer-removed':
      'The signer is no longer trusted: what it signed is refused from the next start.',
  },
  problems: {
    'no-archive': 'Choose an archive to upload.',
    'archive-too-large': 'The archive is larger than 16 MB.',
    'archive-invalid': 'This is not a plugin archive this gateway reads',
    'sdk-out-of-range': 'The plugin was built for another version of the SDK',
    'catalog-invalid': 'The plugin’s risk catalog is invalid',
    'id-mismatch': 'The archive does not agree with itself',
    'no-data-directory': 'Nothing can be installed on a store in memory',
    'unsigned-not-allowed': 'The plugin is not signed',
    'reserved-id': 'Only Vaubaan may publish a plugin of this id',
    'not-found': 'No such version',
    'wrong-state': 'This version cannot change that way now',
    'confirmation-mismatch': 'The id typed does not match',
    'accounts-depend': 'Accounts still use this plugin',
    'signature-invalid':
      'The signature does not verify, or names a signer this instance does not trust',
    'not-a-key': 'This is not an ed25519 public key in PEM',
    'name-invalid': 'Give the signer a name of 1 to 80 characters',
    'already-trusted': 'This key or this name is already trusted',
    'not-in-catalog': 'The catalog has not published this version yet',
    'catalog-unreachable': 'The catalog did not answer; nothing was installed',
    'not-the-catalog-version': 'The catalog served another plugin or version; nothing was kept',
    'not-enabled': 'This instance runs only the plugins its configuration names',
    'did-not-load': 'The version did not pass its trial; what ran before keeps running',
    'update-failed': 'Not everything was updated',
  },
  installFromCatalog: (version: string) => `Install ${version}`,
  activateTitle: (id: string) => `Activate ${id}?`,
  activateConsequence:
    'This version, signed by Vaubaan, starts on trial: if it does not load, what runs now keeps serving.',
  goBackTitle: (id: string) => `Go back to this version of ${id}?`,
  firstInstallTitle: (service: string) => `Connect ${service}`,
  firstInstallLede:
    'This instance has no plugin for this service yet. Installing it adds the plugin the Vaubaan catalog built from reviewed source and signed: its signature is checked before anything runs. It is installed for everyone on this instance, then you connect your account.',
  firstInstall: 'Install and connect',
  fromCatalog: 'from the Vaubaan catalog, installed when you connect it',
  firstInstallFailed: 'The plugin was not installed',
  availableTitle: 'In the catalog, not installed',
  signersTitle: 'Trusted signers',
  signersLede:
    'A company key that signs your private plugins (vaubaan-plugin keygen writes it). A plugin it signed shows its name, never Vaubaan. The plugins Vaubaan publishes need no signer here.',
  signerName: 'Name',
  signerKey: 'Public key (PEM)',
  signerKeyId: 'key',
  signerVersions: (n: number) =>
    `${formatNumber(n)} installed ${n === 1 ? 'version' : 'versions'} signed`,
  addSigner: 'Trust this signer',
  removeSigner: 'Remove',
  noSigner:
    'No signer is trusted: only plugins signed by Vaubaan, and the unsigned ids the configuration allows, can be installed.',
} as const;

/**
 * The ceilings of the instance in the settings (spec §4.3 bis), keyed by the ceiling's
 * name in the code (`server/limits`): each count against its ceiling.
 */
export const CEILING_WORDS = {
  labels: {
    users: capitalize(TERMS.user.many),
    accounts: capitalize(TERMS.account.many),
    'active-missions': `Active ${TERMS.mission.many}`,
  },
  /** "3 of 10", "10 of 10 · full: nothing new is added", "3 (unlimited)". */
  usage(count: number, limit: number | null): string {
    if (limit === null) return `${formatNumber(count)} (unlimited)`;
    const usage = `${formatNumber(count)} of ${formatNumber(limit)}`;
    return count >= limit ? `${usage} · full: nothing new is added` : usage;
  },
} as const;

/** "3 of 5 done" — the setup checklist counts itself. */
export function stepsDone(done: number, total: number): string {
  return `${formatNumber(done)} of ${formatNumber(total)} done`;
}
