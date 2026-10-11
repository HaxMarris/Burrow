#!/bin/sh
# Burrow's updater: lets whoever runs Burrow install updates from the admin page, without SSH.
# It runs in its own small container (see docker-compose.yml), with this folder at /repo, Burrow's
# data folder at /data and Docker's control socket. Every few seconds it writes what it knows to
# /data/updater/status.json; when the admin page asks (by creating /data/updater/request) it does
# what you'd do by hand: git pull, then rebuild and restart Burrow.
set -u
DIR=/data/updater
mkdir -p "$DIR"
# Burrow runs as the image's "node" user (1000), and leaves its request in here.
chown 1000:1000 "$DIR"
cd /repo || exit 1
apk add --no-cache git >/dev/null 2>&1
git config --global --add safe.directory /repo
# The name Docker Compose knows this install by, so the rebuild replaces the running Burrow.
PROJECT=$(docker inspect "$(hostname)" --format '{{ index .Config.Labels "com.docker.compose.project" }}' 2>/dev/null)
[ -n "$PROJECT" ] || PROJECT=burrow
OWNER=$(stat -c %u:%g /repo)

json() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\n\r\t'; }
result=""
result_at=0
updating=false
last_fetch=0

write_status() {
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
  commit=$(git rev-parse --short HEAD 2>/dev/null)
  date=$(git log -1 --format=%ct 2>/dev/null)
  latest=$(git rev-parse --short "origin/$branch" 2>/dev/null)
  behind=$(git rev-list --count "HEAD..origin/$branch" 2>/dev/null || echo 0)
  changes=$(git log --format=%s "HEAD..origin/$branch" 2>/dev/null | head -20 | while read -r line; do printf '"%s",' "$(json "$line")"; done)
  cat > "$DIR/status.json.tmp" <<JSON
{"seenAt":$(date +%s),"branch":"$(json "$branch")","commit":"$commit","commitDate":${date:-0},"latest":"$latest","behind":${behind:-0},"changes":[${changes%,}],"checkedAt":$last_fetch,"updating":$updating,"result":"$result","resultAt":$result_at}
JSON
  mv "$DIR/status.json.tmp" "$DIR/status.json"
}

while true; do
  now=$(date +%s)
  if [ $((now - last_fetch)) -ge 3600 ] || [ -f "$DIR/request" ]; then
    git fetch --quiet origin 2>"$DIR/fetch-error.txt" && last_fetch=$now
  fi
  if [ -f "$DIR/request" ]; then
    rm -f "$DIR/request"
    updating=true
    write_status
    echo "Updating at $(date)" > "$DIR/log.txt"
    if git pull --ff-only >> "$DIR/log.txt" 2>&1 \
      && chown -R "$OWNER" /repo \
      && docker compose -p "$PROJECT" up -d --build burrow >> "$DIR/log.txt" 2>&1; then
      result=ok
    else
      result=failed
    fi
    chown -R "$OWNER" /repo 2>/dev/null
    result_at=$(date +%s)
    updating=false
  fi
  write_status
  sleep 10
done
