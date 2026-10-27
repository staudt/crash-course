#!/usr/bin/env bash
# Stop: full typecheck + test suite before the main session ends a turn.
# Exit 2 blocks stopping and feeds the failures back. stop_hook_active guards against loops.
set -u
root="$(cd "$(dirname "$0")/../.." && pwd)"
active="$(jq -r '.stop_hook_active // false')"
[ "$active" = "true" ] && exit 0
[ -d "$root/node_modules" ] || exit 0
cd "$root" || exit 0

out="$(npm run -s check 2>&1)"
if [ $? -ne 0 ]; then
  echo "Typecheck failed:" >&2
  echo "$out" | head -40 >&2
  exit 2
fi
out="$(npm test -s -- --reporter=dot 2>&1)"
if [ $? -ne 0 ]; then
  echo "Tests failed:" >&2
  echo "$out" | tail -40 >&2
  exit 2
fi
exit 0
