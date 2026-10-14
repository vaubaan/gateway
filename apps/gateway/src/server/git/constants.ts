/**
 * The numbers of the git remote, stated once (spec §4.1 ter; ADR
 * gateway-as-git-remote): HTTP statuses the door answers, units, and the
 * bounds every request is held to.
 */

export const HTTP_OK = 200;
export const HTTP_UNAUTHORIZED = 401;
export const HTTP_FORBIDDEN = 403;
export const HTTP_NOT_FOUND = 404;
export const HTTP_METHOD_NOT_ALLOWED = 405;
export const HTTP_TOO_MANY_REQUESTS = 429;
export const HTTP_NOT_IMPLEMENTED = 501;
export const HTTP_BAD_GATEWAY = 502;

export const MS_PER_SECOND = 1000;
/** `git.max_pack_mb` is in mebibytes. */
export const BYTES_PER_MEGABYTE = 1024 * 1024;

/** What the gateway calls itself in the capabilities it sends and advertises. */
export const GIT_AGENT = 'vaubaan-gateway';

/** Every answer of the door: nothing a mission key opened may be kept by an intermediary. */
export const NO_CACHE = { 'Cache-Control': 'no-cache, no-store' } as const;

/** The command list of a push may not exceed this many bytes (refs, not objects). */
export const MAX_COMMAND_LIST_BYTES = 1024 * 1024;
/** Ref updates one push may carry. */
export const MAX_PUSH_COMMANDS = 50;
/** Longest ref name accepted in a command. */
export const MAX_REF_NAME_LENGTH = 1024;
/** A ref listing (advertisement, `ls-refs`) is read whole to hide temporary refs: at most this. */
export const MAX_REF_LISTING_BYTES = 16 * 1024 * 1024;

/** Pushes of one mission in flight at once; one more is refused before its pack is read. */
export const MAX_PUSHES_IN_FLIGHT_PER_MISSION = 2;
/** Temporary refs one mission may hold at the provider, in flight or waiting for an approval. */
export const MAX_TEMPORARY_REFS_PER_MISSION = 100;

/** Deadline of the deletion of temporary refs: it runs even when the client is gone. */
export const CLEANUP_TIMEOUT_MS = 60_000;
/** How long a temporary ref may live past the request's own deadline before the sweeper takes it. */
export const IN_FLIGHT_MARGIN_MS = 5 * 60_000;
