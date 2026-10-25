---
name: release
description: Use when preparing or cutting a Runtime Web release (release-please release PR, CHANGELOG, verification with make ci and make coverage, tag, and the release workflow that signs and publishes), or when asked how to release.
---

# Release Runtime Web

The full, human-facing process is in `RELEASING.md`. This skill is the checklist to run it. Releases are driven by
release-please: it keeps a PR titled `chore: release X.Y.Z` open on `main`, and merging that PR creates the `vX.Y.Z`
tag and the GitHub Release. The tag starts `.github/workflows/release.yml`, which builds, signs, publishes and verifies.
Confirm with the user before any step that merges, tags, pushes or publishes.

Do not hand-edit versions or the changelog on `main` for a normal release. release-please owns `"version"` in
`server/package.json`, `web/package.json` and `.release-please-manifest.json`, and the `## [X.Y.Z]` section of
`CHANGELOG.md`. Hand releases (first release, RC) are the exception and are in `RELEASING.md`, "Other kinds of release".

## 0. Confirm the inputs

- Is there an open release PR (`gh pr list --search "chore: release" --state open`)? If yes, release it. If not, the
  release is whatever `main` holds after the next `feat:` / `fix:` merge.
- Is the version right? Versions come from commit titles: `feat` is a minor bump, `fix` a patch, `feat!` or a
  `BREAKING CHANGE` footer bumps major (while `0.x`, a breaking change bumps minor). To force one, put
  `Release-As: X.Y.Z` in a commit body on `main`. Do not guess when breaking changes exist; ask.
- Is this a security release? See `SECURITY.md`. The changelog must not describe exploit detail before the advisory is
  public.

## 1. Check the PR and the tree

```bash
gh pr list --search "chore: release" --state open --json number,title,headRefName
git status --short          # must be clean on the local checkout
git log --oneline -n 20 origin/main
```

Stop if the release PR is missing, the checkout is dirty or `main` has unexpected commits.

## 2. Review the release PR

The PR body and `CHANGELOG.md` section are generated from the commit subjects: `feat` goes to Added, `fix` to Fixed,
`perf` and `revert` to Changed, and Documentation, Build and packaging, Dependencies get their own headings;
`refactor`, `test`, `ci` and `chore` are hidden. Check that:

- every user-visible change has a line, and the wording is for a user (present tense, no hashes),
- changes to the HTTP API or configuration keys say so, and `docs/reference/api.md` and `docs/configuration.md` were
  updated in their own PRs,
- the version in the PR title and the `.release-please-manifest.json` bump match the step 0 decision.

Edit the changelog section in the PR branch if a line needs rewording. Do not edit released sections.

## 3. Verify on the release PR branch

```bash
make ci           # web build/lint/tests/budgets, server typecheck/lint/tests
make coverage     # both suites with coverage thresholds
shellcheck -s sh install.sh && sh install.sh --dry-run --version X.Y.Z --domain console.example.com --email ops@example.com
mkdocs build --strict   # docs site, in a venv with docs/requirements.txt installed
make e2e          # Playwright smoke against a runtime-hosted console (needs RTWEB_URL and a node)
```

Every command must pass on the release commit. If `make e2e` cannot run here, say so in the report instead of skipping
it silently.

## 4. Merge the release PR

Merge only after the user confirms. The release App tags the merge commit `vX.Y.Z` and creates the GitHub Release.
Merging with squash keeps the `chore: release X.Y.Z` title as the commit subject.

## 5. Watch the release workflow

`release.yml` checks the tag against both package versions, runs the tests, assembles
`runtime-web-X.Y.Z.tar.gz` (`server/`, `web/dist/`, `deploy/`, `install.sh`, `VERSION`), writes an SPDX SBOM, scans
both with Trivy, publishes `SHA256SUMS` with a cosign keyless bundle and SLSA provenance, replaces the release notes
with the CHANGELOG section (`scripts/release-notes.sh`), and a `verify` job re-downloads and checks everything.

```bash
gh run watch --repo 21-ci/runtime-web $(gh run list --repo 21-ci/runtime-web --workflow release.yml -L1 --json databaseId -q '.[0].databaseId')
```

If a job fails, fix the cause on `main` and re-run the workflow, or delete the release and the tag and tag again
(RELEASING.md, "Publish a version", step 5).

## 6. Check the published release

`docs/contributing/ci-cd.md` lists the `cosign verify-blob`, `sha256sum --check` and `gh attestation verify`
commands. Run them against the published assets.

## 7. Report

Return to the user:

- the release PR, the tag and the commit,
- the CHANGELOG section,
- the verification results (pass, fail or not run, with reasons),
- the release URL and the workflow run,
- anything left for a human (announcement in Discussions, docs site if install steps changed).

## Hotfix

Fix through a PR to `main` first with a `fix:` title, then release a patch from the release PR. When `main` already
carries unreleased features, cherry-pick the fix onto a branch from the last tag, set the patch version, and tag it by
hand as in `RELEASING.md`.
