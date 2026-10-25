#!/bin/sh
# Print the CHANGELOG.md section of one version (the release notes body).
#
#   scripts/release-notes.sh 1.2.3 [CHANGELOG.md]
#
# Matches headings "## [1.2.3]", "## 1.2.3" and "## v1.2.3" (release-please and Keep a Changelog styles) and prints
# everything up to the next "## " heading. With no CHANGELOG or no matching section, prints a short fallback so the
# release still gets a body.
set -eu

version=${1:?usage: release-notes.sh VERSION [CHANGELOG]}
version=${version#v}
file=${2:-CHANGELOG.md}

if [ -f "$file" ]; then
  notes=$(awk -v v="$version" '
    /^## / {
      if (found) exit
      h = $0
      sub(/^## +\[?v?/, "", h)
      if (index(h, v) == 1) {
        rest = substr(h, length(v) + 1, 1)
        if (rest == "" || rest == "]" || rest == " " || rest == "(") { found = 1; next }
      }
    }
    found { print }
  ' "$file")
  if [ -n "$(printf '%s' "$notes" | tr -d '[:space:]')" ]; then
    printf '%s\n' "$notes"
    exit 0
  fi
fi

printf 'Runtime Web %s.\n\nNo CHANGELOG section was found for this version; see the commits since the previous tag.\n' "$version"
