#!/usr/bin/env bash
# Budget gate (docs/02-design-v1.md section 7; Global Constraints). Each check is reported and
# asserted separately; the script exits non-zero if any asserted check is over budget.
#
#   bin/rtweb            <= 30 MiB                        (always checked; needs `make build`)
#   idle RSS             <= 40 MiB                        (docker stats --no-stream of a running rtweb container)
#   web first route      <= 250 KB gzip                   (index.html entry + its modulepreload/CSS)
#   editor chunk         <= 900 KB gzip                   (chunks containing CodeMirror; excludes the lazy TS worker)
#   TS worker            <= 1.5 MB gzip                   (lazy *worker* chunks, loaded on the editor page only)
#
# Env overrides: BIN, DIST, RSS_CONTAINER (default runtime-web-rtweb-1), REQUIRE_RSS=1 (fail when no
# container is running instead of skipping), REQUIRE_EDITOR=1 (fail when no editor chunk exists).
#
# Measure RSS 30 s after start: `docker compose up -d --wait` then run this script.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${BIN:-$ROOT/bin/rtweb}"
DIST="${DIST:-$ROOT/web/dist}"
RSS_CONTAINER="${RSS_CONTAINER:-runtime-web-rtweb-1}"

MAX_BIN_BYTES=$((30 * 1024 * 1024))
MAX_RSS_MIB=40
MAX_FIRST_GZ_BYTES=$((250 * 1024))
MAX_EDITOR_GZ_BYTES=$((900 * 1024))
MAX_WORKER_GZ_BYTES=$((1536 * 1024))

failed=0

report() { # report STATUS LABEL DETAIL
  printf '%-5s %-22s %s\n' "$1" "$2" "$3"
}

# --- binary size -----------------------------------------------------------------------------
if [ -f "$BIN" ]; then
  size=$(wc -c <"$BIN" | tr -d ' ')
  if [ "$size" -le "$MAX_BIN_BYTES" ]; then
    report PASS "binary size" "$size bytes <= $MAX_BIN_BYTES ($BIN)"
  else
    report FAIL "binary size" "$size bytes > $MAX_BIN_BYTES ($BIN)"
    failed=1
  fi
else
  report FAIL "binary size" "missing: $BIN (run make build)"
  failed=1
fi

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

# --- idle RSS --------------------------------------------------------------------------------
rss_check() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "no docker CLI"
    return 2
  fi
  if ! docker inspect -f '{{.State.Running}}' "$RSS_CONTAINER" 2>/dev/null | grep -q true; then
    echo "container $RSS_CONTAINER is not running"
    return 2
  fi
  # MemUsage looks like "23.4MiB / 7.7GiB"; normalise to MiB.
  docker stats --no-stream --format '{{.MemUsage}}' "$RSS_CONTAINER" | awk -v max="$MAX_RSS_MIB" '
    function mib(v,   n, u) {
      n = v + 0; u = v; sub(/^[0-9.]+/, "", u)
      if (u == "KiB" || u == "kB") return n / 1024
      if (u == "MiB" || u == "MB") return n
      if (u == "GiB" || u == "GB") return n * 1024
      if (u == "B") return n / 1048576
      return -1
    }
    { used = mib($1) }
    END {
      if (used < 0) { print "unparsable: " $0; exit 1 }
      printf "%.1f MiB\n", used
      exit (used <= max ? 0 : 3)
    }'
}

rss_out=$(rss_check 2>&1) && rss_rc=0 || rss_rc=$?
case "$rss_rc" in
  0) report PASS "idle RSS" "$rss_out <= $MAX_RSS_MIB MiB ($RSS_CONTAINER)" ;;
  2)
    if [ "${REQUIRE_RSS:-0}" = "1" ]; then
      report FAIL "idle RSS" "$rss_out"
      failed=1
    else
      report SKIP "idle RSS" "$rss_out (make compose-up, then rerun; REQUIRE_RSS=1 to fail)"
    fi
    ;;
  *)
    report FAIL "idle RSS" "$rss_out > $MAX_RSS_MIB MiB or unreadable ($RSS_CONTAINER)"
    failed=1
    ;;
esac

if [ "$failed" -ne 0 ]; then
  echo "budget: FAILED" >&2
  exit 1
fi
echo "budget: OK"
