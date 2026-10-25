---
title: Releases
description: How a Runtime Web version is prepared, tagged and published as a signed release.
---

# Releases

A release is a signed tarball on GitHub, built from a `vX.Y.Z` tag. The installer and the upgrade steps in
[Install](../getting-started/install.md#upgrade) use these tarballs. The full procedure is in
[RELEASING.md](https://github.com/21-ci/runtime-web/blob/main/RELEASING.md). This page gives the outline and the
checks that matter most.

## Outline

1. Check that `main` is green, and that `make ci` and `make coverage` pass on the commit you release.
2. Move the entries under `## [Unreleased]` in `CHANGELOG.md` into a new `## [X.Y.Z] - YYYY-MM-DD` section. This text
   becomes the release notes.
3. Pick the version by [Semantic Versioning](https://semver.org/). Breaking changes to the API, the configuration or the
   storage bump the major version, or the minor version while the project is `0.x`.
4. Set the same `version` in `server/package.json` and `web/package.json`. The release workflow fails when they differ
   from the tag.
5. Commit the release as `chore: release X.Y.Z`, and tag it with a signed tag:

    ```bash
    git tag -s vX.Y.Z -m "vX.Y.Z"
    git push origin main vX.Y.Z
    ```

6. Watch the release workflow. Its `verify` job downloads the release and checks the checksums, the signature and the
   attestation. If a job fails, delete the release and the tag, fix the cause, and tag again.

A `-rc.N` suffix publishes a pre-release. The workflow is described in [CI and releases](ci-cd.md).

## What a release contains

| Asset | Use |
|---|---|
| `runtime-web-X.Y.Z.tar.gz` | The console and the server bundle that the installer unpacks |
| `SHA256SUMS` and its Sigstore bundle | Checksums, signed by the release workflow |
| SBOM (SPDX JSON) and provenance | The third-party components and the build record |
| `install.sh` | The installer, also at the repository root |

## Security fixes

Coordinate with the reporter as described in [SECURITY.md](https://github.com/21-ci/runtime-web/blob/main/SECURITY.md).
Prepare the fix on a private branch, publish the advisory on the day the patch ships, and mention the fix under
`Security` in the changelog without exploit detail until the advisory is public.

## Hotfixes

Branch from the latest tag, cherry-pick the fix onto `main` as well, and release a patch version from the branch.
