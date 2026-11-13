# Releasing

Releases are published from GitHub Actions (`.github/workflows/release.yml`) using
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) — no `NPM_TOKEN` secret is stored.

## One-time npm setup

1. Sign in at npmjs.com and open the package: **pi-seo-guard → Settings**.
2. Under **Trusted publisher**, choose **GitHub Actions** and enter:
   - Organization or user: `RuslanGrigoryev`
   - Repository: `pi-seo-guard`
   - Workflow filename: `release.yml`
   - Environment: leave empty
3. Save. (Optionally set "Require two-factor authentication and disallow tokens" under Publishing access.)

The workflow needs `id-token: write`, Node 22+ and npm ≥ 11.5.1 (it runs `npm install -g npm@latest`).

## Release flow

1. Update `CHANGELOG.md` and bump the version: `npm version <x.y.z> --no-git-tag-version` (or edit `package.json` + lockfile).
2. Commit and merge to `main` (CI must be green).
3. Tag and push the tag:
   ```sh
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
4. The `Release` workflow runs tests and `tsc`, checks the tag equals `package.json`'s version, then runs `npm publish --provenance --access public`.

If the tag and version differ the job fails before publishing; delete the tag (`git push --delete origin vX.Y.Z`), fix, and re-tag.
