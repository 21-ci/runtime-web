# Releasing

How a version of Runtime Web is prepared, tagged and published. Versions follow
[Semantic Versioning](https://semver.org/). The changelog follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Pushing a `vX.Y.Z` tag runs `.github/workflows/release.yml`, which builds, scans, signs and publishes the release.
The details of the workflow, its assets and how to verify them are in
[docs/contributing/ci-cd.md](docs/contributing/ci-cd.md).

## Channels

| Channel | Where | Produced by |
|---|---|---|
| Source tag `vX.Y.Z` | GitHub repository | the maintainer |
| `runtime-web-X.Y.Z.tar.gz`, SBOM, `SHA256SUMS` + Sigstore bundle, provenance | GitHub release | `release.yml` |
| Installer `install.sh` | repository root and each GitHub release | `release.yml` |

## Steps

1. **Check the branch.** `main` is green: CI passes, and `make ci` and `make coverage` pass locally on the commit you
   release. Run `make e2e` against a runtime-hosted console when you can.
2. **Update the changelog.** In `CHANGELOG.md`, move the entries under `## [Unreleased]` into a new
   `## [X.Y.Z] - YYYY-MM-DD` section. Keep the Added, Changed, Deprecated, Removed, Fixed and Security headings. Update
   the link references at the bottom of the file. This section becomes the release notes.
3. **Pick the version.** Breaking API, config or storage change: major (or minor while `0.x`). New feature: minor.
   Fix only: patch. Security fixes can ship as patches.
4. **Bump the packages.** Set `"version": "X.Y.Z"` in `server/package.json` and `web/package.json`. The release
   workflow fails when they do not match the tag.
5. **Commit the release.** `chore: release X.Y.Z`, signed off.
6. **Tag and push.**

   ```bash
   git tag -s vX.Y.Z -m "vX.Y.Z"
   git push origin main vX.Y.Z
   ```

   A `-rc.N` suffix publishes a pre-release.
7. **Watch the workflow.** The `verify` job re-downloads the release and checks the checksums, signature and
   attestation. If any job fails, delete the release and the tag, fix the cause, and tag again.
8. **Announce.** Post in Discussions and update the docs site if the install steps changed.

## Security releases

Coordinate with the reporter as described in [SECURITY.md](SECURITY.md). Prepare the fix on a private branch, write the
advisory, release the patch, and publish the advisory the same day. Mention the fix in the changelog under `Security`,
without exploit detail until the advisory is public.

## Hotfixes

Branch from the latest tag, cherry-pick the fix onto `main` as well, and release a patch version from the branch.
