---
name: release
description: Use when preparing or cutting a Runtime Web release (version bump, CHANGELOG update, verification with make ci and make e2e, signed tag, images and GitHub release), or when asked how to release.
---

# Release Runtime Web

The full, human-facing process is in `RELEASING.md`. This skill is the checklist to run it. Release automation is not in
the repository yet, so every step is manual. Confirm with the user before any step that pushes, tags or publishes.

## 0. Confirm the inputs

Ask for, or infer from the request and the log:

- the version (`X.Y.Z`, semver),
- the commit to release (default: the tip of `main`),
- whether this is a security release (see `SECURITY.md`; it must not be discussed publicly before the advisory).

Do not guess the version when breaking changes exist. Breaking API, config or storage change means a major version,
or a minor version while the project is `0.x`.

## 1. Check the tree

```bash
git status --short          # must be clean
git log --oneline -n 20     # what is going out
git describe --tags --abbrev=0 2>/dev/null   # the last tag
```

Stop if the tree is dirty or the commit is not on `main`.

## 2. Gather the changes

Review every commit since the last tag:

```bash
git log --no-merges --format='%s' <last-tag>..HEAD
```

Group the subjects into Keep a Changelog headings: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`.
Write each entry for a user, in the present tense, without commit hashes. Entries that change the HTTP API or the
configuration keys must say so. Those also need the reference docs updated (`docs/reference/api.md`,
`docs/configuration.md`).

## 3. Update CHANGELOG.md

1. Move the entries under `## [Unreleased]` into `## [X.Y.Z] - YYYY-MM-DD` (today's date, ISO format).
2. Leave an empty `## [Unreleased]` section at the top.
3. Update the link references at the bottom:

   ```text
   [Unreleased]: https://github.com/21-ci/runtime-web/compare/vX.Y.Z...HEAD
   [X.Y.Z]: https://github.com/21-ci/runtime-web/releases/tag/vX.Y.Z
   ```

4. Do not edit released sections. If the `0.1.0` date is still `TBD`, set it to the release date when cutting 0.1.0.

## 4. Verify

```bash
make ci           # format, vet, tests, vulnerability scan, web lint and tests, build, budgets
make e2e          # compose stack and the Playwright smoke suite (needs Docker)
mkdocs build --strict   # docs site, in a venv with docs/requirements.txt installed
```

Every command must pass on the release commit. If `make e2e` cannot run in this environment, say so in the report
instead of skipping it silently.

## 5. Commit the release

```bash
git add CHANGELOG.md
git -c commit.gpgsign=false commit -s -m "chore: release vX.Y.Z"
```

Sign the tag (step 6) with the maintainer key. Do not commit the built binaries.

## 6. Tag

```bash
git tag -s vX.Y.Z -m "vX.Y.Z"
```

Push only after the user confirms:

```bash
git push origin main vX.Y.Z
```

## 7. Build the images

`make docker` builds `rtweb:dev` and `rtrouter:dev`. Retag them as `X.Y.Z` and push them to the registry the maintainers
use. Record the image digests for the release notes.

```bash
make build                      # bin/rtweb with version, commit and date stamped from git
shasum -a 256 bin/rtweb         # checksum for the release page
```

## 8. Publish the GitHub release

Create the release from the tag, with the `## [X.Y.Z]` section of CHANGELOG.md as the body. Attach the checksums. Link
the docs site.

## 9. Report

Return to the user:

- the tag and the commit,
- the CHANGELOG section,
- the verification results (pass, fail or not run, with reasons),
- the image digests and the release URL,
- anything left for a human (signing key, registry credentials, announcement).

## Hotfix

Branch from the last tag, cherry-pick the fix, run the same checklist, and tag a patch version. Merge the fix back into
`main`.
