---
title: OneDrive plugin
tracks:
  - plugins/onedrive/src/
  - plugins/onedrive/package.json
last_reviewed: 2026-11-27
---

# OneDrive plugin — handbook

`@vaubaan/plugin-onedrive`: five tools of its own on Microsoft Graph v1.0 (`/me/drive`), personal
OneDrive and OneDrive for work or school alike, with an access token from the client serving
`microsoft` on the instance: Vaubaan's installed-app client on a local instance
([local-instance-carries-installed-oauth-clients](../../decisions/local-instance-carries-installed-oauth-clients.md)),
a broker or an own client elsewhere ([broker contract](../oauth-broker-contract.md)). One resource
per account, its drive; no environment. Rules common to every plugin: [services README](README.md).

## Start here

- [`src/call.ts`](../../../plugins/onedrive/src/call.ts) — `readDriveCall`, shared by classify and
  execute; undeclared arguments refused.
- [`src/execute.ts`](../../../plugins/onedrive/src/execute.ts) — one Graph request per tool (two for
  `read_file`: the item, then its download address), discovery from `GET /me`.
- [`src/risk-catalog.yaml`](../../../plugins/onedrive/src/risk-catalog.yaml) — the same four risks
  and two macro-actions as [Google Drive](google-drive.md).

## Invariants

- Same model as Google Drive: listing and searching (`file-list`) apart from reading a file's text
  (`file-read`); writes only create (`folder-create`, `file-upload`, the latter `costly`, so it asks
  first at Careful and Trusting); sharing, deleting and permissions are `excludedTools`.
- Identifiers: an item id is `[A-Za-z0-9!_-]{1,256}` (`root` included); personal ids hold a `!`,
  which the slice grammar cannot carry: such an id is classified `[*]`. A file name is checked
  against OneDrive's forbidden characters plus `%` and `#`, then becomes a path segment of the
  upload (`…/items/{parent}:/{name}:/content`). The plugin builds each request field by field.
- **A file's text is read from its pre-authenticated download address**, never with the access
  token: `@microsoft.graph.downloadUrl` must be https on a OneDrive or SharePoint host
  (`DOWNLOAD_HOST_SUFFIXES`), else the read fails as a protocol error.
- A next page is Graph's own `@odata.nextLink`, handed to the agent as `nextPageToken` and followed
  only when it is the same path on Graph: an agent cannot point the token anywhere else.

## Traps

- Graph cannot export Word, Excel or PowerPoint as text: only text files are read (by the item's
  `file.mimeType`), up to 1 MB, refused from `size` before the download.
- An upload is a simple `PUT` (Graph's limit is 4 MB; the plugin's 1 MB);
  `@microsoft.graph.conflictBehavior=rename` keeps an existing file of the same name.
- The search is `search(q='…')` in the path, an OData literal with each quote doubled, then
  percent-encoded.

## Outside the repo

- The Entra app (on a local instance: Vaubaan's public client `0f3f084a-…`) carries the delegated
  permission `Files.ReadWrite` (the person's own files, never `Files.ReadWrite.All`), with
  `User.Read` and the OpenID scopes; no administrator's consent is needed unless the tenant's policy
  asks for it.
- Microsoft has no endpoint that revokes one refresh token: the gateway erases its copy; the person
  removes the app from their Microsoft account.
- Service facts read in Microsoft Graph v1.0's reference (2026-11-27): `driveItem` (list children,
  get, search, the download URL property), upload of small files, create folder, `/me`.

## Debug

- "Microsoft did not grant access to your files" → a permission was refused at consent, or the
  tenant needs an administrator's consent.
- A read failing with "no download address on a OneDrive host" → Microsoft answered a host outside
  `DOWNLOAD_HOST_SUFFIXES`; check the address and extend the list from Microsoft's documentation.
