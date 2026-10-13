/**
 * The three people of the demo identity provider (`demo-idp.ts`). Addresses
 * are under the reserved `.example` TLD: none of them exists anywhere.
 *
 * What each one is in the seeded instance is decided by `seed.ts` and by the
 * admin rule of the demo configuration (`demo-instance.ts`), not here; the
 * `tagline` and `sees` texts are what the account picker and the tour say.
 */
export interface DemoPerson {
  /** Key of the account in the picker (`account=`), and `sub` suffix. */
  readonly key: string;
  readonly name: string;
  readonly email: string;
  /** Shown on the account picker, after the name. */
  readonly tagline: string;
  /** One line for the tour: what this account sees once signed in. */
  readonly sees: string;
  /** The `groups` claim the demo IdP hands out at sign-in. */
  readonly idpGroups: readonly string[];
}

export const ALICE: DemoPerson = {
  key: 'alice',
  name: 'Alice',
  email: 'alice@acme-demo.example',
  tagline: 'owner and operator',
  sees: 'everything: her connections, missions in every state, two open requests, a share received from Carol, the audit of the whole instance and the Admin pages',
  idpGroups: ['engineering'],
};

export const BOB: DemoPerson = {
  key: 'bob',
  name: 'Bob',
  email: 'bob@acme-demo.example',
  tagline: 'teammate (share beneficiary)',
  sees: 'no connection of his own, one share received from Alice (Shares received), one mission issued within it, and a mission of Alice shared with him as a member (Missions, "Shared with me")',
  idpGroups: ['engineering'],
};

export const CAROL: DemoPerson = {
  key: 'carol',
  name: 'Carol',
  email: 'carol@acme-demo.example',
  tagline: 'member of the GitHub admins group',
  sees: 'the GitHub connection owned by the "GitHub admins" group, which she co-owns as a member, and her own Stripe connection, shared to Alice',
  idpGroups: ['engineering'],
};

export const DEMO_PEOPLE: readonly DemoPerson[] = [ALICE, BOB, CAROL];

/** The local group that owns one of the seeded connections. */
export const GITHUB_ADMINS_GROUP = 'GitHub admins';
/** A second local group, so Administration → Groups lists more than one. */
export const CONTRACTORS_GROUP = 'Contractors';

export function personByKey(key: string | null): DemoPerson | null {
  return DEMO_PEOPLE.find((person) => person.key === key) ?? null;
}

/** The claims the demo IdP signs for a person. */
export function claimsOf(person: DemoPerson): Record<string, unknown> {
  return {
    sub: `demo|${person.key}`,
    email: person.email,
    name: person.name,
    groups: [...person.idpGroups],
  };
}
