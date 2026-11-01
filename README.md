# viewed

Mark the files of a branch as "viewed" before you open a PR. A Mac Electron app plus a phone PWA, so you can review your own branch file by file on either device.

Two sources:

- **GitHub** (desktop and PWA): a pushed branch, read through the GitHub API with a read-only token.
- **Local folder** (desktop only): a local clone, read with `git` on your Mac. Unpushed commits show up, and no GitHub token is needed. Use it for repositories you can't get a token for. **Recent** reopens one of the last ten local reviews (folder, branch, base) in one click. On a local review you can also ask about a diff line (needs Claude Code 2.1.248 or later; it reads Claude session logs read-only, and the question goes to whichever account is logged in to Claude Code at that moment).
  In a local review, files touched only by other people's commits (judged by your `git config user.name`/`user.email`, with `.mailmap` applied) are marked viewed automatically and collapsed, and lines other people added get a different background. If you commit under other names or emails too, list them (one per line) in the settings field "Names that are also you" — a file any of them touched is never treated as someone else's.
  A diff over 2,000 lines starts collapsed while unread and says how long it is, so a generated file doesn't slow the whole review. Open it from its head, or check it as it is.
  Next to the progress, **N automatic** counts the viewed files you didn't click yourself: other people's files and checks carried over from another branch or target. Click it to list only those. To make one yours, uncheck it and check it again in the full list. Other people's files stay locked. Checks made before this count existed read as yours.
  A changed file can be shown whole with **Show whole file**, so the lines around a change are visible without opening an editor. Only that file is read again, and what counts as viewed doesn't change. Very large files (a diff of about 20,000 lines with the whole file) stay as a diff.
  If you switch the PR target of a local review to a branch that is behind (for example from an integration branch to `main`), what you already checked carries over. Files that are identical to the previous (newer) target are counted as viewed even if you never checked them. Going back to the previous target keeps everything you had checked there.
  Moving to any other target, a file also stays viewed when its content is byte-identical to what you viewed and every change in the new diff was in the diff you viewed, at the same place in the file. A line the new target makes you add or remove for the first time, or a mode change you didn't see, still shows the file as changed; those new lines stand out, and the changes you already reviewed around them are dimmed. A rename or mode change is written on the file, since no diff line shows it.
  What counts as reviewed is always the diff you checked, however many targets you move through: a check the app carried to another target proves nothing about a third one, so moving sideways from there compares with the diff you actually saw.

Status: in development

## Setup

Check marks are kept either **on this device only** (no token, nothing leaves the device, the desktop default) or in a **secret gist** synced between devices. For the gist:

1. Create a fine-grained personal access token for each GitHub account you review with: **Contents: read** and **Metadata: read** on the repos you want to review. The account that holds the sync gist also needs **Gists: read and write**.
2. Create an empty **secret gist** on that account and copy its id.
3. In the app's settings enter the tokens, the gist id and a shared secret. Use the **same gist id and shared secret on every device**, but a **different device id on each device** (two devices with one device id overwrite each other's checks).

## Run

- Web: `pnpm --filter @viewed/web dev`, or `pnpm --filter @viewed/web build` then `pnpm --filter @viewed/web preview`.
- Desktop: `pnpm --filter @viewed/web build`, then `pnpm --filter @viewed/desktop start` (the window is blank without the web build).
- Desktop app bundle (macOS, Apple silicon): `pnpm --filter @viewed/desktop package` writes `apps/desktop/out/viewed-darwin-arm64/viewed.app`. `pnpm install-app` packages it, quits the running app, replaces `/Applications/viewed.app` and opens it; if a step fails, the installed app stays as it was. It is ad-hoc signed and not notarized, so it runs on the Mac that built it; a copy downloaded elsewhere is blocked by Gatekeeper.

## Known limits

- The desktop app is not code-signed with a Developer ID or notarized.
- The gist grows with every reviewed branch; there is no cleanup yet.
- A secret gist is unlisted, not encrypted. File names are HMAC'd, but commit/blob SHAs and timestamps are stored in plain.
- The PWA keeps tokens in localStorage; use short-lived, read-only tokens.
- The desktop E2E runs locally only.
- Local folder mode compares against your last `git fetch`; it never fetches. Submodules are listed without a diff.
- Check marks from the two sources are kept apart, so one repository opened both ways is reviewed twice.
- In a local review, a file whose content did not change is checked line by line against the diff you viewed before the first screen. If that doesn't finish in time, or for a new commit while the review is open, or in a GitHub review, only changed blocks are compared, so the same block with the same neighboring lines elsewhere in the file still counts as seen.
- A file in a non-UTF-8 encoding can look unchanged in the diff. On the same merge base a changed file is still flagged, with a note; across different merge bases the app can't tell.
- A check you undid doesn't follow a rename: the mark is stored by path.
- After a rebase or merge, changes since you viewed are shown by changed block (whole block), not line by line. Files the branch adds are still shown line by line, and so are files the rebase or merge did not touch in a local review. Records made before this version keep the old behavior until you check the file again.
- Check marks are kept per branch name. In a local review, a branch with no mark for a file looks at the other local branches and the branches you opened recently in that folder (up to 30): a file whose diff is exactly one you viewed there is marked viewed, and a file sharing some changed blocks shows only the blocks you have not seen, without being saved. A file that is new on both branches is compared line by line with the version you viewed there, because all of it is one block. A file whose blocks were all seen elsewhere but whose diff differs is not marked viewed; it shows the whole diff dimmed, since the same block can sit at another place in the file. Among marks on the same diff, or among marks on overlapping ones, the latest decides, so a later uncheck wins; a check of the exact diff still stands against an uncheck of a different one, because you saw that diff. A file without a text diff matches only on the same merge base. A seen block repeated elsewhere in the file with the same neighboring lines is still treated as seen. A file with no mark on this branch whose content is byte-identical to one you viewed on another branch follows the same rule as moving the target: nothing new in the diff marks it viewed, and new lines stand out. Of the marks on that content, the latest decides, so a later uncheck wins. A file that first appears on a new commit while the review is open is looked up then, except for this content rule; a file already on screen stays as it is until you reopen the review. Branches deleted and no longer in the recent list, other clones, and GitHub reviews are not searched.

## Tests

CI (GitHub Actions, ubuntu) runs the prepublish scan, the core tests and the web E2E.
The desktop E2E (`apps/desktop`) is not run in CI because Linux runners have no keychain; run it locally on a Mac with `pnpm --filter @viewed/desktop test`.
