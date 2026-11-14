/**
 * The three people of the demo identity provider (`demo-idp.ts`). Addresses
 * are under the reserved `.example` TLD: none of them exists anywhere.
 *
 * What each one is in the seeded instance is decided by `seed.ts` and by the
 * admin rule of the demo configuration (`demo-instance.ts`), not here; the
 * `tagline` and `sees` texts are what the account picker and the tour say, in the
 * words of the interface (administrator, account, access, teammate, team).
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
  tagline: 'account owner and administrator',
  sees: 'everything: her accounts, missions in every state, two requests waiting for her, an account Carol gave her access to, the Activity of the whole gateway and the administration under Settings',
  idpGroups: ['engineering'],
};

export const BOB: DemoPerson = {
  key: 'bob',
  name: 'Bob',
  email: 'bob@acme-demo.example',
  tagline: 'teammate (was given access)',
  sees: 'no account of his own, one account Alice gave him access to (Accounts, "Shared with you"), one mission he created within it, and a mission of Alice he works on as a teammate (Missions, "Shared with you")',
  idpGroups: ['engineering'],
};

export const CAROL: DemoPerson = {
  key: 'carol',
  name: 'Carol',
  email: 'carol@acme-demo.example',
  tagline: 'in the team GitHub admins',
  sees: 'the GitHub account owned by the team "GitHub admins", which she co-owns as one of its people, and her own Stripe account, on which she gave Alice access',
  idpGroups: ['engineering'],
};

export const DEMO_PEOPLE: readonly DemoPerson[] = [ALICE, BOB, CAROL];

/** The local group (a team, in the interface) that owns one of the seeded accounts. */
export const GITHUB_ADMINS_GROUP = 'GitHub admins';
/** A second local group, so Administration → Teams lists more than one. */
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
