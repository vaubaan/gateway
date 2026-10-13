/**
 * The kinds of object the interface names, and the one colour each carries
 * wherever it appears — as a card, a row, or a mere reference to it (its id,
 * its name, a tag). The hue says WHAT KIND of thing something is; it never
 * says anything about its state: severity, gate, status and callouts keep the
 * four status accents (style guide §2.2).
 *
 * The colours themselves are tokens (`--type-<kind>-rail|bg|fg` in
 * `styles/tokens.css`); this file is the list, in the order the legend shows.
 * Pure and browser-safe.
 */
export const ITEM_KINDS = [
  'risk',
  'preset',
  'tool',
  'plane',
  'resource',
  'connection',
  'mission',
  'token',
] as const;

export type ItemKind = (typeof ITEM_KINDS)[number];

/** Keyed by kind: a new kind fails to compile until it has its words. */
export const ITEM_KIND_WORDS: Readonly<Record<ItemKind, { label: string; meaning: string }>> = {
  risk: { label: 'Risk', meaning: 'One thing a mission may accept, by its id in a catalog.' },
  preset: { label: 'Preset', meaning: 'A starting selection of risks with budgets.' },
  tool: { label: 'Tool', meaning: 'What an agent calls through a mission.' },
  plane: {
    label: 'Data model',
    meaning: 'A plane of a provider’s data model, or one of its entities.',
  },
  resource: { label: 'Resource', meaning: 'One thing of a connection: a repository, a project.' },
  connection: { label: 'Connection', meaning: 'A credential of the company at a provider.' },
  mission: { label: 'Mission', meaning: 'What an agent was given: risks, budgets, resources.' },
  token: { label: 'Token', meaning: 'A mission token, or whoever holds one.' },
};
