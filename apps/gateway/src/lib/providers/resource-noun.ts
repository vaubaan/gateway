/**
 * What one resource of a provider is called on a page: the plugin's
 * `resourceNoun` ("board" / "boards"), or the gateway's own word when the
 * plugin declares none. Every view model that carries it is filled from here,
 * so a page never meets a provider without a noun.
 *
 * Pure and browser-safe: the plugin is read through its type only.
 */
import type { ProviderPlugin, ResourceNoun } from '@vaubaan/plugin-sdk';

/** The noun of a provider whose plugin declares none. */
export const RESOURCE_NOUN_FALLBACK: ResourceNoun = Object.freeze({
  one: 'resource',
  other: 'resources',
});

/** The plugin's noun, else `RESOURCE_NOUN_FALLBACK`; `null` (a plugin that is gone) gives the fallback. */
export function resourceNounOf(plugin: Pick<ProviderPlugin, 'resourceNoun'> | null): ResourceNoun {
  const noun = plugin?.resourceNoun;
  return noun ? { one: noun.one, other: noun.other } : RESOURCE_NOUN_FALLBACK;
}
