/**
 * What each tool of the `cloudflare-dns` provider does, in a few words a person reads at
 * a glance (`ProviderPlugin.toolTitles`) : the head of an approval request in
 * the web interface, before the resource the call resolves to. A verb and its
 * object, sentence case, no final period. For people only : never part of
 * `tools/list`, and the host decides nothing from it.
 *
 * A structural test of the gateway checks that every tool of a shipped plugin
 * has its title : a new tool is added here with its declaration.
 */

export const cloudflareDnsToolTitles: Readonly<Record<string, string>> = {
  cloudflare_dns__list_zones: 'List DNS zones',
  cloudflare_dns__get_zone: 'Read a DNS zone',
  cloudflare_dns__list_records: 'List DNS records',
  cloudflare_dns__get_record: 'Read a DNS record',
  cloudflare_dns__export_records: 'Export the DNS records of a zone',
  cloudflare_dns__get_zone_settings: 'Read the settings of a zone',
  cloudflare_dns__get_dnssec: 'Read the DNSSEC status',
  cloudflare_dns__create_record: 'Create a DNS record',
  cloudflare_dns__update_record: 'Change a DNS record',
  cloudflare_dns__delete_record: 'Delete a DNS record',
  cloudflare_dns__import_records: 'Import DNS records in bulk',
  cloudflare_dns__edit_zone_settings: 'Change the settings of a zone',
  cloudflare_dns__purge_cache: 'Purge the cache of a zone',
  cloudflare_dns__edit_dnssec: 'Turn DNSSEC on or off',
  cloudflare_dns__delete_zone: 'Delete a DNS zone',
};
