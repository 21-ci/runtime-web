# Governance

Runtime Web is maintained by the 21 Cloud team with contributions from the community.

## Roles

| Role | Who | Can |
|---|---|---|
| Contributor | anyone who opens an issue, a discussion or a PR | propose changes |
| Maintainer | named by the lead maintainer, in writing, in the project's maintainer list | review and merge PRs, triage issues, cut releases |
| Lead maintainer | Alex Sayfi ([@aliakseych](https://github.com/aliakseych)), project owner | final say when maintainers cannot agree; security response; adds or removes maintainers |

## Decisions

- Day-to-day changes: a PR with green CI and one maintainer approval. Until the project has a second maintainer, the
  lead maintainer merges their own PRs after CI passes.
- Larger changes (a new route family, a breaking API or config change, a new trust boundary, a change to the storage
  format): an issue labeled `proposal` first, open for comment for at least 7 days. Maintainers then accept or decline
  it, and write the reasons in the issue.
- Lazy consensus: silence after the comment period counts as agreement. Any maintainer may ask for more time.

## Becoming a maintainer

Sustained, high-quality contributions and reviews over several months. An existing maintainer nominates, and the lead
maintainer decides after asking the other maintainers.

## Releases

Maintainers cut releases as described in [RELEASING.md](RELEASING.md). Security fixes follow [SECURITY.md](SECURITY.md).

## Code of conduct

Everyone follows the [Code of Conduct](CODE_OF_CONDUCT.md).
