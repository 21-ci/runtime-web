<!-- Title: a Conventional Commit, e.g. `fix(auth): expired sessions return 401, not 500`. It becomes the squash
     commit subject and the CHANGELOG.md entry (release-please). -->

## What and why

<!-- What changes, and why. Link the issue: Fixes #123. -->

## How it was tested

<!-- Commands you ran, new tests, manual checks in the console. -->

## Checklist

- [ ] Tests added or updated; `make ci` passes
- [ ] `make coverage` passes; thresholds in `web/vitest.config.ts` and `server/vitest.config.ts` not lowered
- [ ] Endpoint changed? `docs/reference/api.md` and the MSW handlers in `web/src/test/` updated
- [ ] Docs updated for user-visible changes (docs site, README)
- [ ] SECURITY.md updated if a trust boundary, limit or default changed
- [ ] Commits follow Conventional Commits and are signed off (`git commit -s`, DCO)
- [ ] Breaking change? Marked with `!` / `BREAKING CHANGE:` and described above
