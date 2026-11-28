/**
 * The words of the interface — one module, so that a person meets one word per
 * thing on every page (ADR interface-redesign-vocabulary-and-design-system).
 * One file per domain in this folder; this index re-exports every word by name,
 * and a page imports them from `@/lib/vocabulary`.
 *
 * This is the vocabulary of what a person READS. Account, service and plugin are
 * the same words in the code and the protocol (ADR
 * one-word-per-thing-account-service-plugin). For the other words, protocol and
 * storage names are never taken from here: MCP tool names, refusal codes, risk
 * ids, catalog YAML, database columns, API fields and configuration keys keep
 * the names the spec gives them (`share`, `risk`, `gate`, `quota`, `request`,
 * `operator`…). A page prints an id as the protocol spells it (in mono) and
 * everything around it with these words. The retired word never appears here
 * (`tests/unit/structural/one-word-per-thing.test.ts`).
 *
 * Pure and browser-safe, usable in server and client components. Its imports
 * are `lib/dates`, the one place a date becomes text, and the risk model's
 * words (the rows and reasons, the five facts, the gate, Can / Asks first / Cannot, the trust
 * levels), which `@vaubaan/policy-engine` holds so the public site prints the
 * same words: re-exported here, a page imports them from this module as before.
 */

export {
  ALLOW_WORDS,
  GATE_WORDS,
  gateWordOf,
  REASON_WORDS,
  ROW_GATE_SENTENCES,
  ROW_LABEL,
  ROW_WORDS,
  TREE_LEGEND,
  TRUST_LEVEL_HINTS,
  TRUST_LEVEL_LABELS,
  WHY_LABELS,
  WHY_ORDER,
  WHY_VALUES,
  whyValue,
} from '@vaubaan/policy-engine';
export type { GateWord, Reason, Row, WhyAxis } from '@vaubaan/policy-engine';

export {
  PRODUCT,
  ROUTES,
  NAV,
  NAV_SHORT,
  NAV_MORE,
  NAV_ORDER,
  TERMS,
  count,
  formatNumber,
  capitalize,
  PAGES,
  ACTIONS,
  SECTIONS,
  asksFirst,
  LIMIT_WORDS,
  usage,
  roomLeft,
  perPeriod,
  limitsReset,
  KEY_WORDS,
  keyOf,
  possessive,
  ROLE_WORDS,
  qualifiers,
  ownership,
  accessGiven,
  mayAllow,
  MISSION_STATES,
  ACCOUNT_STATES,
  REQUEST_STATES,
  DECISION_WORDS,
  WAITING,
  waitingFor,
  ASKED_FIRST,
  reachedLimit,
  running,
  ago,
  THEME_WORDS,
} from './common';
export type { NavKey, Term, TermKey, Tone, StateWord } from './common';
export {
  ACCOUNT_PAGES,
  ACCOUNT_ACTIONS,
  ACCOUNT_WORDS,
  holderWords,
  ownedBy,
  besidesOwners,
  giveAccessLabel,
  ORPHAN_WORDS,
  PART_LOSS_WORDS,
  LOST_ACCOUNT_WORDS,
} from './accounts';
export { REFERENCE_WORDS, TRUST_LEVEL_CUSTOM } from './reference';
export {
  ACTIVITY_TABS,
  OVERVIEW_PERIODS,
  OVERVIEW_LEDE,
  OVERVIEW_SCOPE,
  OVERVIEW_WORDS,
  formatBytes,
  percentOf,
  EXPIRY_WORDS,
  timelineLede,
  ACTIVITY_WORDS,
  activityLede,
  ACTIVITY_SCOPE,
  TIMELINE_SCOPE,
  ACTIVITY_PERIODS,
  REFUSAL_WORDS,
  ACT_WORDS,
} from './activity';
export {
  SETTINGS_PAGES,
  NOTIFICATION_WORDS,
  SETTINGS_ACTIONS,
  CONFIG_WORDS,
  PLUGIN_WORDS,
  INSTALL_WORDS,
  CEILING_WORDS,
  stepsDone,
} from './settings';
export {
  everyOf,
  periodNow,
  limitOf,
  missionReachedLimit,
  limitReachedOn,
  usedOf,
  until,
  delay,
  asker,
  NOW,
  issuerName,
  FIRST_RUN,
  ANSWERS,
  REQUEST_WORDS,
} from './requests';
export type { Every } from './requests';
export {
  MISSION_ACTIONS,
  TRUST_RAISE_WORDS,
  RESOURCE_SET_WORDS,
  MISSION_LIST_FILTERS,
  MISSION_HISTORY,
  MISSION_WORDS,
  CARD_WORDS,
  limitsResetEvery,
  limitColumn,
  usedColumn,
  periodWord,
  shortDate,
  expiresOn,
  listed,
  reachedOnAccount,
  agoSentence,
} from './missions';
export { TOKEN_CONNECT, TOKEN_EXPIRY_NOTICE_DAYS } from './connect';
export {
  DOC_HINT_MAX,
  DOC_PAGES,
  articleFor,
  connectHint,
  clampHint,
  serviceDoc,
  docHintLabel,
  docLinkLabel,
} from './doc-hints';
export type { DocTarget, DocPageId, ConnectWay } from './doc-hints';
