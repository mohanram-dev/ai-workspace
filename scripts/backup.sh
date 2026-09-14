#!/usr/bin/env bash
# Backs up the database and the agent workspaces.
#
#   scripts/backup.sh [destination]      (default: ./backups)
#
# The dump is pg_dump's custom format, which restore.sh feeds to pg_restore.
# Keeps the newest BACKUP_KEEP files (default 14) and deletes older ones.
set -euo pipefail

DEST="${1:-./backups}"
KEEP="${BACKUP_KEEP:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

if [ -z "${DATABASE_URL:-}" ]; then
  if [ -f .env ]; then
    DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2-)"
  fi
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set and .env does not define it." >&2
  exit 1
fi

mkdir -p "$DEST"
DB_FILE="$DEST/aiw-$STAMP.dump"

echo "Dumping the database to $DB_FILE"
if command -v pg_dump > /dev/null 2>&1; then
  pg_dump --format=custom --no-owner --no-privileges --file="$DB_FILE" "$DATABASE_URL"
else
  # No local client: use the postgres image, which always matches the server.
  docker run --rm --network host -e PGCONNECT_TIMEOUT=10 postgres:17-alpine \
    pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" > "$DB_FILE"
fi

# The workspaces hold real user files (project files, uploads), so they are part
# of a backup; screenshots and events live in the database.
WORKSPACES="${WORKSPACE_ROOT:-./data/workspaces}"
if [ -d "$WORKSPACES" ]; then
  FILES_FILE="$DEST/workspaces-$STAMP.tar.gz"
  echo "Archiving $WORKSPACES to $FILES_FILE"
  # GNU tar reads a path like C:... as a remote host, which breaks when this is
  # run from Git Bash on Windows. BSD tar has no such notion and no such flag.
  TAR_LOCAL=""
  if tar --help 2>&1 | grep -q -- --force-local; then TAR_LOCAL="--force-local"; fi
  tar $TAR_LOCAL -czf "$FILES_FILE" -C "$(dirname "$WORKSPACES")" "$(basename "$WORKSPACES")"
fi

# Retention, newest kept.
for PREFIX in aiw workspaces; do
  ls -1t "$DEST/$PREFIX-"* 2> /dev/null | tail -n "+$((KEEP + 1))" | while read -r OLD; do
    echo "Removing old backup $OLD"
    rm -f "$OLD"
  done
done

echo "Done. $(ls -1 "$DEST" | wc -l) file(s) in $DEST"
