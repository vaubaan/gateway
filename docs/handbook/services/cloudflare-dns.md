---
title: Cloudflare DNS plugin
tracks:
  - plugins/cloudflare-dns/src/
  - plugins/cloudflare-dns/README.md
last_reviewed: 2026-11-20
---

# Cloudflare DNS plugin — handbook

`@vaubaan/plugin-cloudflare-dns`: zones, records, settings, DNSSEC, cache purge. One resource per
zone the token reaches; no environment. Rules common to every plugin: [services README](README.md).

## Start here

- [`src/resources.ts`](../../../plugins/cloudflare-dns/src/resources.ts) — every grammar, zone
  resolution, the critical-record verdict (`isCriticalRecord`, `recordSensitivity`).
- [`src/classify.ts`](../../../plugins/cloudflare-dns/src/classify.ts) — pure classifier.
- [`src/execute.ts`](../../../plugins/cloudflare-dns/src/execute.ts) — `ROUTES`, guards,
  discovery.

## Invariants

- **Critical fails closed**: MX or NS whatever the name, the apex (`@` or the zone name), an apex
  wildcard, and also a type or name outside the grammars, an unknown zone name, or a write lacking
  `type` or `name`. Case and trailing dots are ignored (`Example.COM..` is the apex); whitespace is
  not trimmed and makes the name critical.
- **A deletion is a record write**: `delete_record` goes through `recordSensitivity`; without
  `type` + `name` it is priced critical, not refused (requiring them would break existing calls).
- **A declared-ordinary update or delete is checked**: the executor `GET`s the record first and
  refuses when it is critical today or the answer has no type and name to compare.
- Layering is deliberate: `record[**].W` (`record-write`) also matches `.critical.W` and
  `.delete.W`; `zone[**].R` matches every read under a zone (reading records needs both read
  risks); `zone[*].W` (`zone-delete`) matches the zone write only.
- The executor always puts the resolved zone ref in the URL, never the raw argument.
- **`zone_id` is an id or a name**, through `resolveZoneResource` in both `classify` and `execute`:
  the ref matched as given first, else the zone's DNS name (`zone_name` metadata, which discovery
  sets to Cloudflare's name; the display name only as fallback, since the owner may relabel it),
  compared after `dnsName` on both sides (DNS is case-insensitive: `Example.COM.` is
  `example.com`; no prefix or subdomain match). A name two mission zones share (same domain in two
  accounts) is refused, asking for the id. Refusals name up to ten mission zones as `name (id)`.
- **`list_zones` sends no request**: it answers the mission's zones from `ctx.resources` (id, name,
  account). Filtering one page of `GET /zones` (20 by default) to the mission dropped mission zones
  as soon as the account held more; walking every page would read the other zones only to drop
  them. Live status and nameservers come from `get_zone`. It takes no `page`/`per_page` any more.

## Traps

- `zone_id`, `record_id` must pass `pathIdent` (`[A-Za-z0-9_-]{1,64}`): `encodeURIComponent('..')`
  is `..`, so `record_id: '..'` would be priced a record deletion while the request deletes
  `/zones/<zone>/`.
- `_dmarc`, `_sip._tcp` and `xn--…` are DNS names (ordinary); `@`, bare `*`, an inner wildcard or
  an empty label are not, and make the write critical.
- `list_zones` returning fewer zones than the dashboard is expected (mission zones only); a zone
  added to Cloudflare after the account's discovery is not a resource until rediscovered.
- `a.b` as `zone_id` is a DNS name, so it is refused as "not a zone of this mission", not as
  malformed; a name never reaches the URL or the slice, only the matched resource's ref does.

## Outside the repo

- A custom **API token** over Include, All zones, with Zone · Zone, DNS, Zone Settings: Edit and
  Cache Purge: Purge (`src/credential.ts`); a Global API Key is refused by the field pattern (it
  rejects `|`). Checked at paste with `GET /user/tokens/verify` (status, `expires_on`) and the first
  page of zones (account names); an account-owned token (Manage Account → API Tokens) is not
  verifiable there and is refused.

## Debug

- `zone_id: argument missing and the mission touches 2 … zones` → pass `zone_id` (id or name).
- `zone_id: 'z9' is not a Cloudflare DNS zone of this mission` → add the zone to the mission.
- `zone_id: 2 … zones of this mission are named '…'` → pass the id the refusal lists.
- Update or delete refused on `critical-record-write` → `type`/`name` missing, or apex / wildcard /
  MX / NS: name an ordinary record fully, or hold the risk.
- `the record is a critical record (…) but the call declared an ordinary one` → repeat with the real
  type and name; empty values mean the read-back failed.
- Discovery `UpstreamAuthError 401` → invalid or revoked token.
