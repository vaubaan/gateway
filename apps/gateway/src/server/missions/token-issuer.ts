/**
 * Minting one mission token for one holder — the step shared by issuance, the
 * creator's rotation and the team service (member tokens, named tokens).
 *
 * The secret exists in the return value only: the store receives the prefix
 * and the SHA-256 digest (`token.ts`), so no row, no audit entry and no log
 * line can give a token back — not to its holder, and not to the creator of
 * the mission either (spec §0: "the creator never sees its secret").
 *
 * This module writes no audit entry: its callers do, each with the act that
 * names what happened (`mission-issued`, `mission-rotated`,
 * `mission-token-issued`).
 */
import type { MissionsRepo } from '../store';
import type { MissionTokenRecord, TokenHolderRecord } from '../store/types';
import type { TokenMinter } from './token';

const MAX_MINT_ATTEMPTS = 5;

export interface TokenIssuerDeps {
  readonly missions: Pick<MissionsRepo, 'findTokenByPrefix' | 'issueToken'>;
  readonly mint: TokenMinter;
}

export interface IssuedSecret {
  /** The Bearer. This is the only time it exists outside the holder's hands. */
  readonly secret: string;
  readonly prefix: string;
  /** The stored row: never the secret. */
  readonly token: MissionTokenRecord;
  /** The holder's previous active token, retired by this one; `null` for a first token. */
  readonly replaced: MissionTokenRecord | null;
}

export async function issueTokenTo(
  deps: TokenIssuerDeps,
  input: {
    readonly missionId: string;
    readonly holder: TokenHolderRecord;
    readonly createdBy: string;
  },
): Promise<IssuedSecret> {
  for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt++) {
    const minted = await deps.mint();
    // The prefix is the lookup key (unique column): a collision is re-drawn, never overwritten.
    if (await deps.missions.findTokenByPrefix(minted.prefix)) continue;
    const issued = await deps.missions.issueToken({
      missionId: input.missionId,
      prefix: minted.prefix,
      hash: minted.hash,
      hashAlg: minted.hashAlg,
      holder: input.holder,
      createdBy: input.createdBy,
    });
    return {
      secret: minted.secret,
      prefix: minted.prefix,
      token: issued.token,
      replaced: issued.replaced,
    };
  }
  throw new Error(`could not draw an unused token prefix in ${MAX_MINT_ATTEMPTS} attempts`);
}
