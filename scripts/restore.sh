#!/usr/bin/env bash
# Restores a dump written by backup.sh.
#
#   scripts/restore.sh backups/aiw-20260913T120000Z.dump [DATABASE_URL]
#
# This REPLACES the contents of the target database. It refuses to run without
# an explicit confirmation, because there is no undo.
set -euo pipefail

DUMP="${1:?usage: restore.sh <dump file> [DATABASE_URL]}"
TARGET="${2:-${DATABASE_URL:-}}"

if [ -z "$TARGET" ]; then
  echo "Pass the target DATABASE_URL as the second argument or set it in the environment." >&2
  exit 1
fi
[ -f "$DUMP" ] || { echo "No such dump: $DUMP" >&2; exit 1; }

SAFE_TARGET="$(printf '%s' "$TARGET" | sed -E 's#//[^@]*@#//#')"
echo "About to REPLACE the contents of: $SAFE_TARGET"
echo "From: $DUMP"
read -r -p "Type 'restore' to continue: " CONFIRM
[ "$CONFIRM" = "restore" ] || { echo "Cancelled."; exit 1; }

# Stop the app first: restoring under a running server leaves it holding rows
# that no longer exist.
if command -v pg_restore > /dev/null 2>&1; then
  pg_restore --clean --if-exists --no-owner --no-privileges --dbname="$TARGET" "$DUMP"
else
  docker run --rm --network host -i postgres:17-alpine \
    pg_restore --clean --if-exists --no-owner --no-privileges --dbname="$TARGET" < "$DUMP"
fi

echo "Restored. Run 'pnpm db:migrate' if the dump predates the current schema."
