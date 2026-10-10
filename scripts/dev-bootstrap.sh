#!/bin/sh
# SessionStart hook: make a fresh worktree or cloud checkout ready to type-check and test.
#
# - Installs dependencies with `npm ci` only when node_modules is absent.
# - Never reinstalls over an existing node_modules: a running office executes tsx and the
#   MCP servers from it, and `npm ci` deletes the directory first.
# - Does nothing in a hired agent's session (cwd under workspaces/).
# - Prints one line when package-lock.json is newer than node_modules.
# - Quiet on the normal path. Never fails the session.

root=$(cd "$(dirname "$0")/.." 2>/dev/null && pwd -P) || exit 0
cwd=$(pwd -P 2>/dev/null) || exit 0

case "$cwd/" in
  "$root"/workspaces/*) exit 0 ;;
esac

if [ ! -d "$root/node_modules" ]; then
  echo "dev-bootstrap: node_modules missing, running npm ci" >&2
  (cd "$root" && npm ci --no-audit --no-fund >&2) || echo "dev-bootstrap: npm ci failed; run it by hand" >&2
  exit 0
fi

if [ "$root/package-lock.json" -nt "$root/node_modules" ]; then
  echo "dev-bootstrap: package-lock.json is newer than node_modules; run npm ci when no office is running from this checkout"
fi
exit 0
