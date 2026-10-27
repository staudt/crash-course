#!/usr/bin/env bash
# PostToolUse (Edit|Write): typecheck + run related tests for an edited src/**/*.ts file.
# Exit 2 sends the errors back to the agent that made the edit.
# Only tsc errors in the edited file are reported, so parallel agents editing
# other files don't block each other on half-finished work.
set -u
root="$(cd "$(dirname "$0")/../.." && pwd)"
f="$(jq -r '.tool_input.file_path // .tool_response.filePath // empty')"
case "$f" in
  "$root"/src/*.ts) ;;
  *) exit 0 ;;
esac
[ -d "$root/node_modules" ] || exit 0
cd "$root" || exit 0
rel="${f#"$root"/}"

errs="$(npx tsc --noEmit -p . 2>&1 | grep -E "^${rel//./\\.}\(" )"
if [ -n "$errs" ]; then
  echo "tsc errors in $rel:" >&2
  echo "$errs" >&2
  exit 2
fi

out="$(npx vitest related "$rel" --run --passWithNoTests --reporter=dot 2>&1)"
if [ $? -ne 0 ]; then
  echo "Tests related to $rel failed:" >&2
  echo "$out" | tail -40 >&2
  exit 2
fi
exit 0
