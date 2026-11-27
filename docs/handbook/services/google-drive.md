---
title: Google Drive plugin
tracks:
  - plugins/google-drive/src/
  - plugins/google-drive/package.json
last_reviewed: 2026-11-27
---

# Google Drive plugin — handbook

`@vaubaan/plugin-google-drive`: five tools of its own on Google's Drive REST API v3
(`https://www.googleapis.com/drive/v3`, uploads on `…/upload/drive/v3`), with an access token from
the client serving `google` on the instance: Vaubaan's installed-app client on a local instance
([local-instance-carries-installed-oauth-clients](../../decisions/local-instance-carries-installed-oauth-clients.md)),
a broker or an own client elsewhere ([broker contract](../oauth-broker-contract.md)). One resource
per account, its drive; no environment. Rules common to every plugin: [services README](README.md).

## Start here

- [`src/call.ts`](../../../plugins/google-drive/src/call.ts) — `readDriveCall`, shared by classify
  and execute: the drive, the folder and file ids, the name, the text and its type, the page;
  undeclared arguments refused.
- [`src/execute.ts`](../../../plugins/google-drive/src/execute.ts) — one request per tool (two for
  `read_file`: the metadata, then the export or the bytes), discovery from `GET /about`.
- [`src/risk-catalog.yaml`](../../../plugins/google-drive/src/risk-catalog.yaml) — four risks in two
  macro-actions: `read` (`file-list`, `file-read`) and `write` (`folder-create`, `file-upload`).

## Invariants

- **Reading what files are called and reading what they hold are two risks**: `list_folder` and
  `search_files` are `file-list` (`folder[f].R`, `file[*].R`); `read_file` is `file-read`
  (`file[id].content.R`, the verb leaf `content`).
- **Writes only create**: `upload_file` is `drive[d].file.W`, `create_folder` `drive[d].folder.W`.
  No tool shares, deletes or changes permissions; the three are `excludedTools`, refused by name.
- **Uploading asks first at Careful and Trusting**: `file-upload` is `costly` (row 3): a file in a
  shared folder is seen at once by its members and the agent cannot take it back.
- The drive ref is the account's address with `@` written `~`; an agent may name it either way.
  A mission holding one drive needs no `drive` argument.
- Identifiers: a file or folder id is `[A-Za-z0-9_-]{1,128}` (`root` included), percent-encoded
  into the path after `pathSegment` refused `/ ? # %`; it lands in `q` as a quoted literal
  (`queryLiteral` escapes `\` and `'`). The plugin builds each request field by field.

## Traps

- **Google's documents have no bytes**: Docs, Sheets and Slides are read through `files.export`
  (Markdown, CSV of the first sheet, plain text); other Google types (forms, drawings) and binary
  files (PDF, images, Office) are refused with their type. A text file above 1 MB is refused from
  its `size` before any download, and the read is bounded anyway.
- An upload is one `multipart/related` request (metadata, then the text) with a random boundary
  absent from the text. Drive never replaces a file of the same name: both exist.
- Searches and listings exclude the trash and include shared drives (`supportsAllDrives`,
  `includeItemsFromAllDrives`): the account sees what it can open, not only My Drive.
- A download that Google answers with a redirect fails (`redirect: 'error'`, like every transport
  request): the access token is never sent to another host.

## Outside the repo

- **`drive` is a restricted scope**: until Vaubaan's Google client passes Google's review with a
  CASA assessment, the consent screen warns "Google hasn't verified this app" and at most 100
  people may grant it. The plugin's page says so; the Calendar verification is submitted without
  `drive` so that it is not held up.
- The client's Google Cloud project (on a local instance: `vaubaan-desktop`, brand vaubaan.com)
  must have the **Google Drive API** enabled and `drive` in its data access list.
- The scope is in the provider table (`packages/oauth-providers`), so a broker could serve it too,
  with its own Google review.
- Service facts read in Google's Drive API v3 reference (2026-11-27): `files.list` (`q`,
  `orderBy`, `pageToken`), `files.get` (`alt=media`), `files.export`, `files.create` (multipart
  upload, folders), `about.get`, the search query terms.

## Debug

- "Google did not grant access to your Drive files" at discovery or on a call → the person unticked
  the Drive box on the granular consent; reconnect and tick it.
- 403 `accessNotConfigured` → the Drive API is off in the client's Google Cloud project.
