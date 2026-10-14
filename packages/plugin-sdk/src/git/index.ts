/**
 * Git transport primitives shared by the host's git door and the plugins
 * that declare a `gitRemote` (spec §4.1 bis ; ADR gateway-as-git-remote).
 */
export * from './pkt-line.ts';
export * from './receive-pack.ts';
export * from './advertisement.ts';
export * from './remote.ts';
