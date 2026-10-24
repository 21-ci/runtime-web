#!/usr/bin/env bash
# Budget gate (budget constraints). Each check is reported and
# asserted separately; the script exits non-zero if any asserted check is over budget.
#
#   web first route      <= 250 KB gzip                   (index.html entry + its modulepreload/CSS)
#   editor chunk         <= 900 KB gzip                   (chunks containing CodeMirror; excludes the lazy TS worker)
#   TS worker            <= 1.5 MB gzip                   (lazy *worker* chunks, loaded on the editor page only)
#
# The backend runs as a 21 Cloud Runtime service (server/), so there is no binary or process RSS
# to measure here: the runtime enforces the service limits (deploy/rt.rtweb.toml plan rtweb).
# With RTWEB_URL set, the script also checks that the hosted console answers /healthz.
#
# Env overrides: DIST, RTWEB_URL, REQUIRE_EDITOR=1 (fail when no editor chunk exists).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="${DIST:-$ROOT/web/dist}"

MAX_FIRST_GZ_BYTES=$((250 * 1024))
MAX_EDITOR_GZ_BYTES=$((900 * 1024))
MAX_WORKER_GZ_BYTES=$((1536 * 1024))

failed=0

report() { # report STATUS LABEL DETAIL
  printf '%-5s %-22s %s\n' "$1" "$2" "$3"
}

# --- web gzip budgets ------------------------------------------------------------------------
if [ ! -f "$DIST/index.html" ]; then
  report FAIL "web dist" "missing: $DIST/index.html (run make web)"
  failed=1
else
  # Prints: first_route_bytes editor_bytes editor_files worker_bytes worker_files
  measured=$(node "$ROOT/scripts/budget-measure.js" "$DIST")
  read -r first_gz editor_gz editor_files worker_gz worker_files <<<"$measured"

  if [ "$first_gz" -le "$MAX_FIRST_GZ_BYTES" ]; then
    report PASS "first-route JS gz" "$first_gz bytes <= $MAX_FIRST_GZ_BYTES (entry + modulepreload + css)"
  else
    report FAIL "first-route JS gz" "$first_gz bytes > $MAX_FIRST_GZ_BYTES"
    failed=1
  fi

  if [ "$editor_files" -eq 0 ]; then
    if [ "${REQUIRE_EDITOR:-0}" = "1" ]; then
      report FAIL "editor chunk gz" "no CodeMirror chunk in $DIST"
      failed=1
    else
      report SKIP "editor chunk gz" "no CodeMirror chunk in $DIST yet (set REQUIRE_EDITOR=1 to fail)"
    fi
  elif [ "$editor_gz" -le "$MAX_EDITOR_GZ_BYTES" ]; then
    report PASS "editor chunk gz" "$editor_gz bytes <= $MAX_EDITOR_GZ_BYTES ($editor_files chunk(s))"
  else
    report FAIL "editor chunk gz" "$editor_gz bytes > $MAX_EDITOR_GZ_BYTES ($editor_files chunk(s))"
    failed=1
  fi

  if [ "$worker_files" -eq 0 ]; then
    report SKIP "TS worker gz" "no worker chunk in $DIST"
  elif [ "$worker_gz" -le "$MAX_WORKER_GZ_BYTES" ]; then
    report PASS "TS worker gz" "$worker_gz bytes <= $MAX_WORKER_GZ_BYTES ($worker_files chunk(s), lazy)"
  else
    report FAIL "TS worker gz" "$worker_gz bytes > $MAX_WORKER_GZ_BYTES ($worker_files chunk(s))"
    failed=1
  fi
fi

# --- hosted service (optional) ------------------------------------------------------------------
if [ -n "${RTWEB_URL:-}" ]; then
  if curl -fsS --max-time 10 "${RTWEB_URL%/}/healthz" >/dev/null; then
    report PASS "service health" "${RTWEB_URL%/}/healthz"
  else
    report FAIL "service health" "no 2xx from ${RTWEB_URL%/}/healthz"
    failed=1
  fi
else
  report SKIP "service health" "RTWEB_URL not set"
fi

if [ "$failed" -ne 0 ]; then
  echo "budget: FAILED" >&2
  exit 1
fi
echo "budget: OK"
