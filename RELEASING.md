# Releasing

How a version of Runtime Web is prepared, tagged and published. Versions follow
[Semantic Versioning](https://semver.org/). The changelog follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Release automation (tagged CI builds, image publishing and the installer) is not in this repository yet. Until it is,
the steps below are manual. The build metadata they rely on is already wired: `make build` stamps `main.version`,
`main.commit` and `main.date` into the binary.

## Channels

| Channel | Where | Produced by |
|---|---|---|
| Source tag `vX.Y.Z` | GitHub repository | the maintainer, by hand |
| Container images `rtweb`, `rtrouter` | the registry the maintainers publish to | `make docker` plus a push |
| Installer | `install.sh` at the repository root, once it exists | the release |

## Steps

1. **Check the branch.** `main` is green: `make ci` and `make e2e` pass on the commit you release.
2. **Update the changelog.** In `CHANGELOG.md`, move the entries under `## [Unreleased]` into a new
   `## [X.Y.Z] - YYYY-MM-DD` section. Keep the Added, Changed, Deprecated, Removed, Fixed and Security headings. Update
   the link references at the bottom of the file.
3. **Pick the version.** Breaking API, config or storage change: major (or minor while `0.x`). New feature: minor.
   Fix only: patch. Security fixes can ship as patches.
4. **Commit the release.** `chore: release X.Y.Z`, signed off.
5. **Tag and build.**

   ```bash
   git tag -s vX.Y.Z -m "vX.Y.Z"
   git push origin main vX.Y.Z
   make docker     # builds rtweb:dev and rtrouter:dev; tag both as X.Y.Z and push them
   ```

   The `make build` metadata comes from `git describe`, so build from the tagged commit.
6. **Run the smoke test on the built images.** `make e2e` against the release commit.
7. **Publish.** Create the GitHub release from the tag, paste the changelog section into it, and attach checksums of
   the built binaries (`shasum -a 256 bin/rtweb`).
8. **Announce.** Post in Discussions and update the docs site if the install steps changed.

## Security releases

Coordinate with the reporter as described in [SECURITY.md](SECURITY.md). Prepare the fix on a private branch, write the
advisory, release the patch, and publish the advisory the same day. Mention the fix in the changelog under `Security`,
without exploit detail until the advisory is public.

## Hotfixes

Branch from the latest tag, cherry-pick the fix onto `main` as well, and release a patch version from the branch.
