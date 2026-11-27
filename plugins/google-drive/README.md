# `@vaubaan/plugin-google-drive`

Google Drive for Vaubaan Gateway, through **Google's Drive REST API v3**
(`https://www.googleapis.com/drive/v3`), with tools of its own: list a folder, search, read a file
as text (Docs as Markdown, Sheets as CSV, Slides as plain text), upload a text file and create a
folder. Nothing is shared, deleted or re-permissioned. The access token comes from the client that
serves Google on the instance: Vaubaan's own client on an instance on this computer, a broker or a
client of the instance's own elsewhere. `drive` is a restricted scope at Google: until Vaubaan's
client passes Google's review, Google's consent screen warns that the app is unverified.

- **What it lets an agent do, permission by permission**: its page,
  [vaubaan.com/plugins/google-drive](https://vaubaan.com/plugins/google-drive) — generated from
  this folder; nothing here repeats it.
- **How it is modelled, and why**: handbook
  [`docs/handbook/services/google-drive.md`](../../docs/handbook/services/google-drive.md).
- **Writing or changing a plugin**: the [author's guide](https://vaubaan.com/docs/plugins-guide);
  for the plugins of this repository, [`plugins/README.md`](../README.md).

## Tests

```bash
npx vitest run plugins/google-drive
```

No test calls the service, and none needs a credential.
