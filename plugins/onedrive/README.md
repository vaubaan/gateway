# `@vaubaan/plugin-onedrive`

OneDrive for Vaubaan Gateway, personal or for work or school, through **Microsoft Graph v1.0**
(`https://graph.microsoft.com/v1.0/me/drive`), with tools of its own: list a folder, search, read a
text file, upload a text file and create a folder. Nothing is shared, deleted or re-permissioned.
The access token comes from the client that serves Microsoft on the instance: Vaubaan's own client
on an instance on this computer, a broker or a client of the instance's own elsewhere.

- **What it lets an agent do, permission by permission**: its page,
  [vaubaan.com/plugins/onedrive](https://vaubaan.com/plugins/onedrive) — generated from this
  folder; nothing here repeats it.
- **How it is modelled, and why**: handbook
  [`docs/handbook/services/onedrive.md`](../../docs/handbook/services/onedrive.md).
- **Writing or changing a plugin**: the [author's guide](https://vaubaan.com/docs/plugins-guide);
  for the plugins of this repository, [`plugins/README.md`](../README.md).

## Tests

```bash
npx vitest run plugins/onedrive
```

No test calls the service, and none needs a credential.
