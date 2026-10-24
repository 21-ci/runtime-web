---
name: release
description: Use when preparing or cutting a Runtime Web release (version bump, CHANGELOG update, package versions, verification with make ci and make coverage, tag, and the release workflow that signs and publishes), or when asked how to release.
---

# Release Runtime Web

The full, human-facing process is in `RELEASING.md`. This skill is the checklist to run it. Pushing a `vX.Y.Z` tag runs
`.github/workflows/release.yml`, which builds, signs and publishes; the steps before the tag are manual. Confirm with the user before any step that pushes, tags or publishes.

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

## 3. Update CHANGELOG.md and the package versions

Set `"version": "X.Y.Z"` in `server/package.json` and `web/package.json` (run `npm install` in each to refresh the
lockfile). The release workflow fails when either does not match the tag.


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
make ci           # web build/lint/tests/budgets, server typecheck/lint/tests
make coverage     # both suites with coverage thresholds
shellcheck -s sh install.sh && sh install.sh --dry-run --version X.Y.Z --domain console.example.com --email ops@example.com
mkdocs build --strict   # docs site, in a venv with docs/requirements.txt installed
make e2e          # Playwright smoke against a runtime-hosted console (needs RTWEB_URL and a node)
```

Every command must pass on the release commit. If `make e2e` cannot run in this environment, say so in the report
instead of skipping it silently.

## 5. Commit the release

```bash
git add CHANGELOG.md server/package.json server/package-lock.json web/package.json web/package-lock.json
git -c commit.gpgsign=false commit -s -m "chore: release vX.Y.Z"
```

Sign the tag (step 6) with the maintainer key. Do not commit build output.

## 6. Tag

```bash
git tag -s vX.Y.Z -m "vX.Y.Z"
```

Push only after the user confirms:

```bash
git push origin main vX.Y.Z
```

## 7. Watch the release workflow

`release.yml` checks the tag against both package versions, runs the tests, assembles
`runtime-web-X.Y.Z.tar.gz` (`server/`, `web/dist/`, `deploy/`, `install.sh`, `VERSION`), writes an SPDX SBOM, scans
both with Trivy, publishes `SHA256SUMS` with a cosign keyless bundle and SLSA provenance, creates the GitHub release
with the CHANGELOG section as notes, and a `verify` job re-downloads and checks everything.

```bash
gh run watch -R 21-ci/runtime-web $(gh run list -R 21-ci/runtime-web --workflow release.yml -L1 --json databaseId -q '.[0].databaseId')
```

If it fails, fix the cause, delete the tag (and the release, if one was created) and tag again.

## 8. Check the published release

`docs/contributing/ci-cd.md` lists the `cosign verify-blob`, `sha256sum --check` and `gh attestation verify`
commands. Run them against the published assets.

## 9. Report

Return to the user:

- the tag and the commit,
- the CHANGELOG section,
- the verification results (pass, fail or not run, with reasons),
- the release URL and the workflow run,
- anything left for a human (tag signing key, announcement).

## Hotfix

Branch from the last tag, cherry-pick the fix, run the same checklist, and tag a patch version. Merge the fix back into
`main`.
