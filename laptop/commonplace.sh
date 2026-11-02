#!/usr/bin/env bash
# Commonplace on a laptop. Run ./commonplace.sh help for the commands.
# Works with Docker Desktop, Rancher Desktop, Colima or Podman (anything with `compose`).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"
[ -f .env ] && set -a && . ./.env && set +a
PORT="${COMMONPLACE_PORT:-8070}"
# Folder collections (F22): made here first, so the container engine doesn't create it as root.
COMMONPLACE_FOLDERS="${COMMONPLACE_FOLDERS:-$HOME/Commonplace}"
COMMONPLACE_FOLDERS="${COMMONPLACE_FOLDERS/#\~/$HOME}"
export COMMONPLACE_FOLDERS COMMONPLACE_FOLDERS_LABEL="${COMMONPLACE_FOLDERS/#$HOME/~}"
mkdir -p "$COMMONPLACE_FOLDERS"
URL="http://localhost:$PORT"
IMAGE="${COMMONPLACE_IMAGE:-commonplace:laptop}"
PG_IMAGE="pgvector/pgvector:pg18"

if [ -n "${COMMONPLACE_ENGINE:-}" ]; then ENGINE="$COMMONPLACE_ENGINE"
elif command -v docker >/dev/null 2>&1; then ENGINE=docker
elif command -v podman >/dev/null 2>&1; then ENGINE=podman
else echo "No container engine found. Install Docker Desktop, Rancher Desktop or Podman first." >&2; exit 1
fi
compose() { "$ENGINE" compose -f "$HERE/compose.yaml" "$@"; }
has_image() { "$ENGINE" image inspect "$1" >/dev/null 2>&1; }
has_source() { [ -f "$HERE/../Dockerfile" ]; }

# SECRETS_KEY seals people's AI keys and GitHub tokens. Made once, kept in .env.
ensure_secrets_key() {
  [ -n "${SECRETS_KEY:-}" ] && return 0
  local key
  key="$(openssl rand -base64 32 2>/dev/null || head -c 32 /dev/urandom | base64)"
  printf '\n# Made by ./commonplace.sh on %s. Keep it: changing it means re-entering AI keys and GitHub tokens.\nSECRETS_KEY=%s\n' "$(date +%Y-%m-%d)" "$key" >> "$HERE/.env"
  chmod 600 "$HERE/.env"
  export SECRETS_KEY="$key"
}

wait_healthy() {
  printf "Waiting for DO Notes"
  for _ in $(seq 1 90); do
    if curl -fsS "$URL/health" >/dev/null 2>&1; then echo " ready."; return 0; fi
    printf "."; sleep 1
  done
  echo; echo "DO Notes didn't answer on $URL. See ./commonplace.sh logs" >&2; return 1
}

# The one-time token from the log, only while no account exists yet.
setup_token() {
  curl -fsS "$URL/api/session" 2>/dev/null | grep -q '"needsSetup":true' || return 0
  compose logs app 2>/dev/null | grep -o 'setup token [A-Za-z0-9_-]*' | tail -1 | cut -d' ' -f3
}

open_browser() {
  if command -v open >/dev/null 2>&1; then open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 || true
  elif command -v explorer.exe >/dev/null 2>&1; then explorer.exe "$URL" || true   # WSL, Git Bash
  fi
}

cmd_start() {
  ensure_secrets_key
  if ! has_image "$IMAGE"; then
    if [ -f "$HERE/images/commonplace-images.tar" ]; then cmd_load
    elif has_source; then echo "Building DO Notes (first time takes a few minutes)…"; compose build app
    else echo "No DO Notes image. Put commonplace-images.tar in laptop/images and run ./commonplace.sh load" >&2; exit 1
    fi
  fi
  compose up -d --no-build
  wait_healthy
  local token; token="$(setup_token || true)"
  echo "DO Notes is running at $URL"
  if [ "${COMMONPLACE_LISTEN:-127.0.0.1}" != "127.0.0.1" ]; then
    echo "Other devices on your network can use http://$(hostname -s 2>/dev/null || hostname).local:$PORT"
  fi
  if [ -n "$token" ]; then
    echo
    echo "First run: create your (admin) account with this one-time setup token:"
    echo "  $token"
  fi
  [ "${1:-}" = "--no-open" ] || open_browser
}

cmd_stop() { compose stop; echo "Stopped. Your notes are kept; ./commonplace.sh start brings them back."; }

cmd_status() { compose ps; curl -fsS "$URL/health" >/dev/null 2>&1 && echo "Healthy at $URL" || echo "Not answering on $URL"; }

cmd_backup() {
  mkdir -p "$HERE/backups"
  local file="$HERE/backups/commonplace-$(date +%Y%m%d-%H%M%S).dump"
  compose exec -T db pg_dump -U commonplace -d commonplace -Fc > "$file"
  echo "Backed up to $file ($(du -h "$file" | cut -f1))"
}

cmd_restore() {
  local file="${1:-}"
  [ -f "$file" ] || { echo "Usage: ./commonplace.sh restore backups/commonplace-YYYYMMDD-HHMMSS.dump" >&2; exit 1; }
  read -r -p "Replace everything in this DO Notes with $file? [y/N] " ok
  [ "$ok" = "y" ] || [ "$ok" = "Y" ] || { echo "Nothing changed."; exit 0; }
  compose up -d db
  compose stop app
  compose exec -T db sh -c 'dropdb -U commonplace --if-exists commonplace_restore; createdb -U commonplace commonplace_restore'
  compose exec -T db pg_restore -U commonplace -d commonplace_restore --no-owner < "$file"
  compose exec -T db sh -c 'psql -U commonplace -d postgres -qc "DROP DATABASE commonplace WITH (FORCE)" && psql -U commonplace -d postgres -qc "ALTER DATABASE commonplace_restore RENAME TO commonplace"'
  compose start app
  wait_healthy
  echo "Restored from $file"
}

cmd_update() {
  has_source || { echo "Update needs the DO Notes source (git pull in the repo), or a newer commonplace-images.tar with ./commonplace.sh load" >&2; exit 1; }
  [ -d "$HERE/../.git" ] && git -C "$HERE/.." pull --ff-only || true
  cmd_backup
  compose build app
  compose up -d --no-build
  wait_healthy
  echo "Updated. DO Notes updates its database on start; the backup above is your way back."
}

# One file with both images, to carry Commonplace to a laptop with no source and no registry access.
# With a platform (linux/amd64, linux/arm64) it builds for that kind of machine instead of this one.
cmd_package() {
  local platform="${1:-}" image="$IMAGE" arch save_opts=()
  if [ -n "$platform" ]; then
    has_source || { echo "Packaging for another platform needs the DO Notes source" >&2; exit 1; }
    image="commonplace:laptop-${platform//\//-}"
    echo "Building ${image} for ${platform} (under emulation this can take 10+ minutes)…"
    "$ENGINE" build --platform "$platform" -t "$image" "$HERE/.."
    "$ENGINE" pull --platform "$platform" "$PG_IMAGE"
    save_opts=(--platform "$platform")
    arch="${platform#*/}"
  else
    has_image "$image" || { has_source && compose build app; }
    has_image "$PG_IMAGE" || "$ENGINE" pull "$PG_IMAGE"
    arch="$(uname -m)"
  fi
  local stage; stage="$(mktemp -d)"
  mkdir -p "$stage/laptop/images"
  cp "$HERE/compose.yaml" "$HERE/commonplace.sh" "$HERE/README.md" "$HERE/.env.example" "$stage/laptop/"
  # The kit gets its image name, never this laptop's SECRETS_KEY: the new laptop makes its own.
  printf '# Written by ./commonplace.sh package\nCOMMONPLACE_IMAGE=%s\n' "$image" > "$stage/laptop/.env"
  "$ENGINE" save ${save_opts[@]+"${save_opts[@]}"} -o "$stage/laptop/images/commonplace-images.tar" "$image" "$PG_IMAGE"
  local kit="$HERE/commonplace-laptop-$arch.tar.gz"
  tar -czf "$kit" -C "$stage" laptop
  rm -rf "$stage"
  # Pulling for another platform repoints the tag; put this machine's own Postgres back.
  [ -n "$platform" ] && "$ENGINE" pull -q "$PG_IMAGE" >/dev/null
  echo "Packaged $kit ($(du -h "$kit" | cut -f1))."
  echo "On the other laptop: tar -xzf $(basename "$kit") && cd laptop && ./commonplace.sh start"
}

cmd_load() {
  local tar="$HERE/images/commonplace-images.tar"
  [ -f "$tar" ] || { echo "No $tar" >&2; exit 1; }
  echo "Loading images from ${tar}…"
  "$ENGINE" load -i "$tar"
}

cmd_remove() {
  read -r -p "Delete DO Notes and ALL its notes from this laptop? Type 'delete' to confirm: " ok
  [ "$ok" = "delete" ] || { echo "Nothing changed."; exit 0; }
  compose down -v
  echo "Removed. Backups in laptop/backups (and .env, with SECRETS_KEY) were kept."
}

case "${1:-help}" in
  start) shift; cmd_start "$@" ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  logs) compose logs -f --tail=100 app ;;
  token) t="$(setup_token || true)"; [ -n "$t" ] && echo "$t" || echo "No setup token needed: the first account already exists." ;;
  backup) cmd_backup ;;
  restore) shift; cmd_restore "$@" ;;
  update) cmd_update ;;
  package) shift; cmd_package "$@" ;;
  load) cmd_load ;;
  reset-password)
    shift
    [ -n "${1:-}" ] || { echo "Usage: ./commonplace.sh reset-password someone@example.com" >&2; exit 1; }
    compose exec -T app bun scripts/reset-password.ts "$1" ;;
  remove) cmd_remove ;;
  *)
    cat <<HELP
DO Notes on this laptop ($ENGINE, $URL)

  ./commonplace.sh start      Start DO Notes (builds or loads the image the first time) and open it
  ./commonplace.sh stop       Stop it; notes are kept
  ./commonplace.sh status     Is it running?
  ./commonplace.sh logs       Follow the app log
  ./commonplace.sh token      Show the first-run setup token again
  ./commonplace.sh backup     Save the database to laptop/backups
  ./commonplace.sh restore F  Replace the database with backup F
  ./commonplace.sh update     Back up, rebuild from the latest source, restart
  ./commonplace.sh package [P] Make one .tar.gz to copy DO Notes to another laptop (no source or
                              internet needed there); P = linux/amd64 for Intel/AMD machines when
                              packaging on Apple Silicon
  ./commonplace.sh load       Load images from laptop/images/commonplace-images.tar
  ./commonplace.sh reset-password E  Give the account with email E a new password
  ./commonplace.sh remove     Delete DO Notes and its notes (backups are kept)
HELP
  ;;
esac
