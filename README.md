# viewed

Mark the files of a branch as "viewed" before you open a PR. A Mac Electron app plus a phone PWA, so you can review your own branch file by file on either device.

Two sources:

- **GitHub** (desktop and PWA): a pushed branch, read through the GitHub API with a read-only token.
- **Local folder** (desktop only): a local clone, read with `git` on your Mac. Unpushed commits show up, and no GitHub token is needed. Use it for repositories you can't get a token for. **Recent** reopens one of the last ten local reviews (folder, branch, base) in one click. On a local review you can also ask about a diff line (needs Claude Code 2.1.248 or later; it reads Claude session logs read-only, and the question goes to whichever account is logged in to Claude Code at that moment).
  In a local review, files touched only by other people's commits (judged by your `git config user.name`/`user.email`, with `.mailmap` applied) are marked viewed automatically and collapsed, and lines other people added get a different background. If you commit under other names or emails too, list them (one per line) in the settings field "Names that are also you" — a file any of them touched is never treated as someone else's.
  If you switch the PR target of a local review to a branch that is behind (for example from an integration branch to `main`), what you already checked carries over. Files that are identical to the previous (newer) target are counted as viewed even if you never checked them. Going back to the previous target keeps everything you had checked there.

Status: in development

## Setup

Check marks are kept either **on this device only** (no token, nothing leaves the device, the desktop default) or in a **secret gist** synced between devices. For the gist:

1. Create a fine-grained personal access token for each GitHub account you review with: **Contents: read** and **Metadata: read** on the repos you want to review. The account that holds the sync gist also needs **Gists: read and write**.
2. Create an empty **secret gist** on that account and copy its id.
3. In the app's settings enter the tokens, the gist id and a shared secret. Use the **same gist id and shared secret on every device**, but a **different device id on each device** (two devices with one device id overwrite each other's checks).

## Run

- Web: `pnpm --filter @viewed/web dev`, or `pnpm --filter @viewed/web build` then `pnpm --filter @viewed/web preview`.
- Desktop: `pnpm --filter @viewed/web build`, then `pnpm --filter @viewed/desktop start` (the window is blank without the web build).
- Desktop app bundle (macOS, Apple silicon): `pnpm --filter @viewed/desktop package` writes `apps/desktop/out/viewed-darwin-arm64/viewed.app`. Copy it to `/Applications`. It is ad-hoc signed and not notarized, so it runs on the Mac that built it; a copy downloaded elsewhere is blocked by Gatekeeper.

## Known limits

- The desktop app is not code-signed with a Developer ID or notarized.
- The gist grows with every reviewed branch; there is no cleanup yet.
- A secret gist is unlisted, not encrypted. File names are HMAC'd, but commit/blob SHAs and timestamps are stored in plain.
- The PWA keeps tokens in localStorage; use short-lived, read-only tokens.
- The desktop E2E runs locally only.
- Local folder mode compares against your last `git fetch`; it never fetches. Submodules are listed without a diff.
- Check marks from the two sources are kept apart, so one repository opened both ways is reviewed twice.
- After a rebase or merge, changes since you viewed are shown by changed block (whole block), not line by line. Files the branch adds are still shown line by line. Records made before this version keep the old behavior until you check the file again.

## Tests

CI (GitHub Actions, ubuntu) runs the prepublish scan, the core tests and the web E2E.
The desktop E2E (`apps/desktop`) is not run in CI because Linux runners have no keychain; run it locally on a Mac with `pnpm --filter @viewed/desktop test`.
