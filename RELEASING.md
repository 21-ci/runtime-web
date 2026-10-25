# Releasing

How a version of Runtime Web is prepared, tagged and published, and the one-time repository setup that makes it work.
Versions follow [Semantic Versioning](https://semver.org/).

One tag does everything: pushing `vX.Y.Z` runs [`release.yml`](.github/workflows/release.yml), which builds, scans,
signs, publishes and then verifies what it published. [release-please](.github/workflows/release-please.yml) prepares
the version bump and the changelog and creates that tag. The details of the release workflow, its assets and how to
verify them are in [docs/contributing/ci-cd.md](docs/contributing/ci-cd.md).

## Channels

| Channel | Where | Produced by |
|---|---|---|
| Source tag `vX.Y.Z` | GitHub repository | release-please (or a maintainer, by hand) |
| `runtime-web-X.Y.Z.tar.gz`, SBOM, `SHA256SUMS` + Sigstore bundle, provenance | GitHub release | `release.yml` |
| Installer `install.sh` | repository root and each GitHub release | `release.yml` |

## Publish a version (the normal path)

1. Merge work into `main` through PRs with [Conventional Commit](https://www.conventionalcommits.org) titles
   (`feat:`, `fix:`, `feat!:` for a breaking change). The `pr title` check enforces this; the squash commit subject is
   the PR title.
2. release-please keeps a PR titled **`chore: release X.Y.Z`** open. It bumps `"version"` in `server/package.json`,
   `web/package.json` and `.release-please-manifest.json`, and writes the `## [X.Y.Z]` section of `CHANGELOG.md` from
   the commit subjects (`feat` → Added, `fix` → Fixed, `perf`/`revert` → Changed, plus Documentation, Build and
   packaging, Dependencies; `refactor`, `test`, `ci`, `chore` are hidden). While `0.x`, a breaking change bumps the
   minor version.
3. Before merging, run `make ci && make coverage` on the release PR branch (and `make e2e` against a runtime-hosted
   console when you can). Edit the changelog section in the PR if a line needs rewording.
4. Merge the PR. The release App tags the merge commit `vX.Y.Z` and creates the GitHub Release; the tag starts
   `release.yml`, which uploads the signed assets to that Release and replaces its notes with the CHANGELOG section
   (`scripts/release-notes.sh`).
5. Watch it:

   ```bash
   gh run watch --repo 21-ci/runtime-web
   ```

   The `verify` job re-downloads the release and checks the checksums, signature and attestation. If any job fails,
   fix the cause on `main` and re-run the workflow, or delete the release and the tag and tag again.

   The tag also starts `docker.yml`: it pushes `ghcr.io/21-ci/runtime-web:X.Y.Z`, `X.Y` and the `-slim` variants
   only after Trivy passes on both platforms, then signs and attests them. Check the run, then
   `docker pull ghcr.io/21-ci/runtime-web:X.Y.Z` and follow the quickstart in `docs/getting-started/docker.md`.
6. **Announce.** Post in Discussions and update the docs site if the install steps changed.

## Other kinds of release

**Release by hand** (no release-please PR, e.g. the very first release `v0.1.0`): set the version in
`server/package.json` and `web/package.json` (the build job fails when they do not match the tag), date the
`CHANGELOG.md` section, merge, then tag the merge commit:

```bash
git tag -s v0.1.0 -m "v0.1.0"
```

```bash
git push origin v0.1.0
```

Keep `.release-please-manifest.json` at the version you tagged. After `v0.1.0`, remove the `## [Unreleased]` heading
from `CHANGELOG.md`: release-please owns the file from then on and adds each new section above the previous one.

Only repository admins and the release App may create `v*` tags (`.github/rulesets/tags.json`).

**Pre-release** (`v1.2.0-rc.1`): set the versions to `1.2.0-rc.1`, merge, tag `v1.2.0-rc.1` by hand. It gets a GitHub
pre-release. For release-please, add `"prerelease": true` and `"prerelease-type": "rc"` to the package in
`release-please-config.json` for the duration of the RC cycle.

**Force a version**: put `Release-As: X.Y.Z` in the body of a commit on `main`; the next release PR uses it.

## Security releases

Coordinate with the reporter as described in [SECURITY.md](SECURITY.md). Prepare the fix in a private fork of a GitHub
security advisory, merge it with a `fix:` title, let the release PR pick it up, and publish the advisory the same day.
Describe the fix in the changelog without exploit detail until the advisory is public.

## Hotfixes

Branch from the latest tag, fix through a PR to `main` first, then release a patch: either merge the release PR on
`main`, or, when `main` already carries unreleased features, cherry-pick the fix onto a branch from the tag, set the
patch version and tag it by hand as above.

## One-time setup

Done once per repository by an admin. Nothing here is done by a workflow.

### 1. Release App (release-please token)

release-please must not use `GITHUB_TOKEN`: tags and PRs created with it start no workflows, so neither CI on the
release PR nor `release.yml` on the tag would run.

1. Create an org-owned GitHub App (github.com/organizations/21-ci/settings/apps → **New GitHub App**): no webhook;
   repository permissions **Contents: Read and write**, **Pull requests: Read and write**, **Metadata: Read**.
   Install it on `21-ci/runtime-web` only. (The App used by `21-ci/runtime` can be reused: install it here too.)
2. Repository → Settings → Secrets and variables → Actions: add `RELEASE_APP_ID` (the App ID) and
   `RELEASE_APP_PRIVATE_KEY` (a generated private key, PEM).

### 2. Repository settings

Settings → General:

- Pull Requests: allow **squash merging** (default message: *Pull request title*) and **rebase merging**; disable merge
  commits (the main ruleset requires linear history). Enable **Allow auto-merge** and **Automatically delete head
  branches**.
- Features: enable **Discussions** (the issue template links to it).

Settings → Code security: enable **Private vulnerability reporting**, Dependabot alerts and security updates.

Create the teams `@21-ci/maintainers` and `@21-ci/security` in the org and give them write access, or edit
`.github/CODEOWNERS`.

### 3. Branch and tag rules

```bash
scripts/apply-rulesets.sh --dry-run
scripts/apply-rulesets.sh
```

It creates or updates the rulesets from `.github/rulesets/` with `gh api` (needs admin; rerun after changing a file).
`main.json` protects the default branch: PRs only, signed commits, linear history (squash or rebase), no force-push or
deletion, resolved review threads, and these required checks, up to date with `main`: `web`, `server`, `shell`,
`docs`, `pr title`, `zizmor + actionlint`, `npm audit (web)`, `npm audit (server)`, `trivy fs`, `codeql`, `gitleaks`, `semgrep`, `osv-scanner`. A renamed CI
job must be renamed in `main.json` too, or every PR waits for a check that never reports.

`tags.json` lets nobody create, move or delete `v*` tags. Add who may create them: Settings → Rules → Rulesets →
**release tags** → **Bypass list → Add bypass**: **Repository admin** (for a tag pushed by hand) and, under **Apps**,
the release App → **Save**. The file ships with an empty bypass list because actor IDs differ between accounts; the
script keeps the bypass list when it updates a ruleset.
