// ─────────────────────────────────────────────────────────────────────────────
// Connecting with a token pasted by hand (ADR
// one-place-to-authorize-services-token-first, amended 2026-10-31: granted wide
// once, narrowed by each mission; amended 2026-11-14: where the key has
// alternatives, the narrowest that fits the missions first). The steps and permissions themselves come
// from the plugin; only the frame is written here.
// ─────────────────────────────────────────────────────────────────────────────

export const TOKEN_CONNECT = {
  stepsTitle: (service: string) => `Create the token at ${service}`,
  openTokenPage: (service: string) => `Open the token page at ${service}`,
  permissionsTitle: 'Permissions to tick',
  permissionsNote:
    'Tick all of them: each mission narrows what an agent may do, and a permission left out means a new token.',
  readAccess: 'read',
  writeAccess: 'read and write',
  usedBy: (titles: string) => `for ${titles}`,
  reachTitle: (what: string, grant: string) => `${what}: ${grant}`,
  openStepPage: 'open the page',
  stepCommand: 'Command to copy',
  docsLink: (service: string) => `${service}’s documentation of this token`,
  expiryReported: (service: string) =>
    `Choose the expiry you want at ${service}: it tells this gateway the date, and the account page warns you ${TOKEN_EXPIRY_NOTICE_DAYS} days before.`,
  expiryTyped: (service: string, days: number) =>
    `Choose an expiry of about ${days} days at ${service}. ${service} does not tell this gateway the date: note it, the account page cannot warn you.`,
  sharedAccount:
    'A shared service account is fine: agents act through missions, and Activity records which person and which mission made each call.',
  whatWeDo: (service: string) =>
    `Checked against ${service} when you paste it, then stored encrypted. It is never shown again, and no agent ever sees it.`,
  submit: 'Check and connect',
  submitHint: (service: string) => `Checked against ${service} before saving, encrypted at rest.`,
  tokenFacts: 'Token',
  actsAs: (account: string) => `acts as ${account}`,
  tokenExpires: (date: string) => `expires ${date}`,
  tokenExpired: (date: string) => `expired ${date}`,
  tokenNoExpiry: 'no expiry known',
  expiresSoonTitle: (date: string) => `The token expires ${date}`,
  expiresSoonBody:
    'Create a new token at the service and reconnect before then; missions keep running on the same account.',
  lacksTitle: (count: number) =>
    count === 1 ? 'The token lacks a permission' : `The token lacks ${count} permissions`,
  lacksBody: (service: string) =>
    `${service} said, when the token was checked, that it does not hold these. The tools that need them fail until you create a token with them and reconnect; the account keeps its missions.`,
  pasteTitle: 'Paste it here',
  alternativesLegend: 'What the token covers',
  /** The accessible name of a step's path chips: the menus to follow at the service. */
  pathLabel: (service: string) => `Where to click at ${service}`,
  /** Between two menu labels of a path. */
  pathSeparator: '›',
} as const;

/** A token that expires within this many days is announced on its account page. */
export const TOKEN_EXPIRY_NOTICE_DAYS = 14;
