#!/usr/bin/env bash
# Create or update the repository rulesets from .github/rulesets/*.json with `gh api` (needs repo admin).
# A ruleset is matched by its "name": an existing one is updated in place (PUT), a new one is created (POST).
#
#   scripts/apply-rulesets.sh                       apply to 21-ci/runtime-web
#   scripts/apply-rulesets.sh --repo owner/name     apply to another repository
#   scripts/apply-rulesets.sh --dry-run             print what would be done
#
# bypass_actors is empty in the files because actor IDs differ between accounts; an update keeps the bypass list the
# ruleset already has. After the first apply, add the repository admin role and the release App to the bypass list of
# "release tags" (RELEASING.md), or no v* tag can be created.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO=21-ci/runtime-web
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO=${2:?--repo needs owner/name}; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h | --help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

command -v gh >/dev/null || { echo "gh is required (brew install gh)" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required (brew install jq)" >&2; exit 1; }

existing=$(gh api "repos/$REPO/rulesets?per_page=100" --paginate --jq '.[] | [.name, (.id | tostring)] | @tsv')

for file in "$ROOT"/.github/rulesets/*.json; do
  name=$(jq -r .name "$file")
  id=$(printf '%s\n' "$existing" | awk -F'\t' -v n="$name" '$1 == n { print $2; exit }')
  if [ -n "$id" ]; then
    echo "update  $name (id $id) from ${file#"$ROOT"/}"
    # Keep the bypass list set by hand: the files ship it empty.
    bypass=$(gh api "repos/$REPO/rulesets/$id" --jq '.bypass_actors // []')
    [ $DRY -eq 1 ] || jq --argjson b "$bypass" '.bypass_actors = $b' "$file" |
      gh api -X PUT "repos/$REPO/rulesets/$id" --input - --silent
  else
    echo "create  $name from ${file#"$ROOT"/}"
    [ $DRY -eq 1 ] || gh api -X POST "repos/$REPO/rulesets" --input "$file" --silent
  fi
done
