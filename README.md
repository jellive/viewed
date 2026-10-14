# viewed

Mark the files of a pushed GitHub branch as "viewed" before you open a PR. A Mac Electron app plus a phone PWA, so you can review your own branch file by file on either device.

Status: in development

## Tests

CI (GitHub Actions, ubuntu) runs the prepublish scan, the core tests and the web E2E.
The desktop E2E (`apps/desktop`) is not run in CI because Linux runners have no keychain; run it locally on a Mac with `pnpm --filter @viewed/desktop test`.
