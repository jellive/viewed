# viewed

Mark the files of a pushed GitHub branch as "viewed" before you open a PR. A Mac Electron app plus a phone PWA, so you can review your own branch file by file on either device.

Status: in development

## Setup

1. Create a fine-grained personal access token for each GitHub account you review with: **Contents: read** and **Metadata: read** on the repos you want to review. The account that holds the sync gist also needs **Gists: read and write**.
2. Create an empty **secret gist** on that account and copy its id.
3. In the app's settings enter the tokens, the gist id and a shared secret. Use the **same gist id and shared secret on every device**, but a **different device id on each device** (two devices with one device id overwrite each other's checks).

## Run

- Web: `pnpm --filter @viewed/web dev`, or `pnpm --filter @viewed/web build` then `pnpm --filter @viewed/web preview`.
- Desktop: `pnpm --filter @viewed/web build`, then `pnpm --filter @viewed/desktop start` (the window is blank without the web build).

## Known limits

- The desktop app is not packaged or code-signed.
- The gist grows with every reviewed branch; there is no cleanup yet.
- A secret gist is unlisted, not encrypted. File names are HMAC'd, but commit/blob SHAs and timestamps are stored in plain.
- The PWA keeps tokens in localStorage; use short-lived, read-only tokens.
- The desktop E2E runs locally only.

## Tests

CI (GitHub Actions, ubuntu) runs the prepublish scan, the core tests and the web E2E.
The desktop E2E (`apps/desktop`) is not run in CI because Linux runners have no keychain; run it locally on a Mac with `pnpm --filter @viewed/desktop test`.
