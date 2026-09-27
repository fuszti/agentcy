#!/bin/sh
# Claude Code hook → agent status file. Usage: hook-status.sh <status.json> <state> [detail]
# Must be fast and never fail the hook.
f="$1"; s="$2"; d="${3:-}"
cat >/dev/null 2>&1 || true   # drain hook JSON on stdin
t=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
printf '{"state":"%s","at":"%s","detail":"%s"}\n' "$s" "$t" "$d" > "$f.tmp" 2>/dev/null && mv -f "$f.tmp" "$f" 2>/dev/null
exit 0
