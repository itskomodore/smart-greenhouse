#!/usr/bin/env bash
# install.sh - provision the greenhouse edge on Raspberry Pi OS (Debian-based, systemd).
#
#   sudo ./deploy/install.sh [--http-host <lan-ipv4>] [--actuator-host <ipv4>] [--with-mock-actuator]
#
# What it does (idempotent: re-run after `git pull` to upgrade):
#   1. apt: ca-certificates, curl, gnupg, openssl, iproute2, postgresql (NodeSource Node LTS)
#   2. pnpm via corepack
#   3. system user `greenhouse`, /etc/greenhouse/edge.env (0600, root) with generated API_TOKEN
#   4. postgres role + database `greenhouse` with a generated password (never printed)
#   5. builds edge + dashboard from this checkout as the invoking user
#   6. stages a runtime tree under /opt/greenhouse (edge/dist, migrations, prod deps, dashboard/dist)
#   7. runs migrations, installs systemd units + journald drop-in, enables and starts the service
#
# Secrets are written only to /etc/greenhouse/edge.env (root, 0600). They are never echoed.
# Does NOT touch firewall rules (examples are printed) and does NOT change the timezone.
set -euo pipefail
umask 022

readonly APP_USER=greenhouse
readonly APP_ROOT=/opt/greenhouse
readonly CONF_DIR=/etc/greenhouse
readonly ENV_FILE=/etc/greenhouse/edge.env
readonly SERVICE=greenhouse-edge
readonly MOCK_SERVICE=greenhouse-mock-actuator
readonly NODE_MAJOR="${NODE_MAJOR:-24}"
readonly LOCK_FILE=/run/greenhouse-install.lock

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
readonly SCRIPT_DIR REPO_ROOT

HTTP_HOST_ARG=""
ACTUATOR_HOST_ARG=""
WITH_MOCK=0
BUILD_USER="${SUDO_USER:-root}"

log() { printf '[install] %s\n' "$*"; }
warn() { printf '[install] WARNING: %s\n' "$*" >&2; }
die() { printf '[install] ERROR: %s\n' "$*" >&2; exit 1; }
on_error() { printf '[install] ERROR: failed at line %s (see output above). Re-running is safe.\n' "$1" >&2; }
trap 'on_error $LINENO' ERR

usage() {
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
}

# ───────────── argument handling ─────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --http-host) HTTP_HOST_ARG="${2:-}"; shift 2 ;;
    --http-host=*) HTTP_HOST_ARG="${1#*=}"; shift ;;
    --actuator-host) ACTUATOR_HOST_ARG="${2:-}"; shift 2 ;;
    --actuator-host=*) ACTUATOR_HOST_ARG="${1#*=}"; shift ;;
    --with-mock-actuator) WITH_MOCK=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

is_ipv4() {
  local ip="$1" o
  [[ "$ip" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  for o in "${BASH_REMATCH[@]:1}"; do
    (( 10#$o <= 255 )) || return 1
  done
  return 0
}

if [[ -n "$HTTP_HOST_ARG" ]]; then
  is_ipv4 "$HTTP_HOST_ARG" || die "--http-host must be an IPv4 address of this Pi's LAN interface"
  if [[ "$HTTP_HOST_ARG" == "0.0.0.0" ]]; then
    warn "--http-host 0.0.0.0 binds the API on EVERY interface, including any Thread/WAN side. Use the LAN IP unless you have a firewall in front."
  fi
fi
if [[ -n "$ACTUATOR_HOST_ARG" ]]; then
  is_ipv4 "$ACTUATOR_HOST_ARG" || die "--actuator-host must be an IPv4 address"
fi

# ───────────── preflight ─────────────

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  die "must run as root: sudo $0 $*"
fi
command -v apt-get >/dev/null 2>&1 || die "apt-get not found; this script targets Raspberry Pi OS / Debian"
command -v systemctl >/dev/null 2>&1 || die "systemd is required"
if [[ "$BUILD_USER" != "root" ]] && ! id "$BUILD_USER" >/dev/null 2>&1; then
  die "SUDO_USER '$BUILD_USER' does not exist"
fi
case "$(uname -m)" in
  aarch64|arm64) ;;
  *) warn "architecture $(uname -m): tuned for Raspberry Pi 4 (arm64); continuing" ;;
esac

# Serialise concurrent runs.
mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
flock -n 9 || die "another install.sh run is in progress"

# Commands run as the invoking user (so the repo's node_modules/dist stay user-owned).
run_as_build() {
  if [[ "$BUILD_USER" == "root" ]]; then
    env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$@"
  else
    local home
    home="$(getent passwd "$BUILD_USER" | cut -d: -f6)"
    runuser -u "$BUILD_USER" -- env HOME="$home" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 PATH="$PATH" "$@"
  fi
}

# ───────────── env file helpers (values are plain KEY=value, no spaces) ─────────────

env_get() {
  [[ -f "$ENV_FILE" ]] || return 0
  grep -m1 "^$1=" "$ENV_FILE" | cut -d= -f2- || true
}

# Replace KEY=value (or append). Writes via a temp file in the same dir, keeping 0600 root:root.
env_set() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp "$CONF_DIR/.edge.env.XXXXXX")"
  {
    if [[ -f "$ENV_FILE" ]]; then grep -v "^${key}=" "$ENV_FILE" || true; fi
    printf '%s=%s\n' "$key" "$value"
  } >"$tmp"
  chown root:root "$tmp"
  chmod 0600 "$tmp"
  mv -f "$tmp" "$ENV_FILE"
}

# Adds KEY=default only when missing, so operator edits survive re-runs.
env_default() {
  if ! grep -q "^$1=" "$ENV_FILE" 2>/dev/null; then env_set "$1" "$2"; fi
}

detect_lan_ip() {
  local ip=""
  ip="$(ip -4 -o route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n1 || true)"
  if [[ -z "$ip" ]]; then
    ip="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' | grep -v '^127\.' | head -n1 || true)"
  fi
  if [[ -n "$ip" ]] && is_ipv4 "$ip" && [[ "$ip" != "127."* ]]; then printf '%s' "$ip"; fi
}

# ───────────── 1. apt base packages ─────────────

log "step 1/7: apt packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg openssl iproute2 util-linux postgresql postgresql-client

# ───────────── 2. Node LTS (NodeSource) and pnpm (corepack) ─────────────

current_node_major() {
  command -v node >/dev/null 2>&1 && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

log "step 2/7: Node.js ${NODE_MAJOR}.x LTS via NodeSource"
if [[ "$(current_node_major)" == "$NODE_MAJOR" ]]; then
  log "node $(node -v) already installed"
else
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --batch --yes --dearmor -o /etc/apt/keyrings/nodesource.gpg
  printf 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_%s.x nodistro main\n' \
    "$NODE_MAJOR" >/etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
  [[ "$(current_node_major)" == "$NODE_MAJOR" ]] || die "node major is $(current_node_major), expected $NODE_MAJOR"
fi
log "node $(node -v), npm $(npm -v 2>/dev/null || echo n/a)"

log "pnpm via corepack"
corepack enable pnpm
command -v pnpm >/dev/null 2>&1 || die "pnpm shim not on PATH after corepack enable"

# ───────────── 3. user, directories, env file ─────────────

log "step 3/7: user, directories, env file"
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --no-create-home --home-dir /var/lib/greenhouse-edge --shell /usr/sbin/nologin "$APP_USER"
fi
install -d -m 0755 "$APP_ROOT" "$APP_ROOT/edge" "$APP_ROOT/dashboard"
install -d -m 0750 -o root -g root "$CONF_DIR"

[[ -f "$ENV_FILE" ]] || { : >"$ENV_FILE"; chown root:root "$ENV_FILE"; chmod 0600 "$ENV_FILE"; }

# Keys that must exist. Values here are safe defaults; operator edits are kept.
env_default NODE_ENV production
env_default LOG_LEVEL info
env_default HTTP_PORT 8080
env_default DASHBOARD_DIR "$APP_ROOT/dashboard/dist"
env_default COAP_HOST "::"
env_default COAP_PORT 5683
env_default ACTUATOR_PORT 5684
env_default ACTUATOR_TIMEOUT_MS 3000
env_default DB_POOL_MAX 4
env_default DB_BUFFER_MAX 5000
env_default DB_QUERY_TIMEOUT_MS 5000
env_default DB_CONNECT_TIMEOUT_MS 3000
env_default SOIL_DRY_RAW 3000
env_default SOIL_WET_RAW 1200
env_default RULES_TICK_MS 1000
env_default RETENTION_DAYS 90
env_default CLOUD_ENABLED false

# API_TOKEN: keep an existing valid one (rotation is a documented manual step), else generate.
existing_token="$(env_get API_TOKEN)"
if [[ ${#existing_token} -lt 16 ]]; then
  env_set API_TOKEN "$(openssl rand -hex 32)"
  log "generated API_TOKEN (stored in $ENV_FILE, root-only)"
else
  log "kept existing API_TOKEN (see docs/README.md for rotation)"
fi

# HTTP_HOST: flag wins, then existing value, then detected LAN IPv4. Never 0.0.0.0 by default.
if [[ -n "$HTTP_HOST_ARG" ]]; then
  env_set HTTP_HOST "$HTTP_HOST_ARG"
elif [[ -z "$(env_get HTTP_HOST)" || "$(env_get HTTP_HOST)" == "127.0.0.1" ]]; then
  lan_ip="$(detect_lan_ip)"
  if [[ -z "$lan_ip" ]]; then
    die "could not detect a LAN IPv4 address; re-run with --http-host <ip> (the API cannot be reached on loopback from other devices)"
  fi
  env_set HTTP_HOST "$lan_ip"
  log "HTTP_HOST set to detected LAN address $lan_ip (override with --http-host)"
fi
if [[ "$(env_get HTTP_HOST)" == "0.0.0.0" ]] && [[ -z "$HTTP_HOST_ARG" ]]; then
  die "HTTP_HOST is 0.0.0.0 in $ENV_FILE without an explicit --http-host; refusing to bind every interface"
fi

# ACTUATOR_HOST: loopback is the default and points at nothing real unless a mock/adapter listens there.
if [[ -n "$ACTUATOR_HOST_ARG" ]]; then
  env_set ACTUATOR_HOST "$ACTUATOR_HOST_ARG"
else
  env_default ACTUATOR_HOST 127.0.0.1
fi
if [[ "$(env_get ACTUATOR_HOST)" == "127.0.0.1" && $WITH_MOCK -eq 0 ]]; then
  warn "ACTUATOR_HOST is 127.0.0.1 and the mock actuator is not enabled: pump commands will fail (fail-safe). Set --actuator-host once the real pump driver is up."
fi

# ───────────── 4. PostgreSQL role + database ─────────────

log "step 4/7: postgres role and database"
systemctl enable --now postgresql >/dev/null

# Reuse the password from an existing DATABASE_URL so re-runs do not churn credentials.
db_pw="$(env_get DATABASE_URL | sed -n 's#^postgres://[^:]*:\([^@]*\)@.*#\1#p')"
if ! [[ "$db_pw" =~ ^[0-9a-f]{32,}$ ]]; then
  db_pw="$(openssl rand -hex 24)"
  log "generated database password (stored in $ENV_FILE only)"
fi

# The password reaches psql over stdin (never on argv). Its value is hex, so quoting is safe.
# Errors are suppressed because psql may echo the statement, which contains the password.
if ! { printf "\\\\set pw '%s'\n" "$db_pw"; cat <<'SQL'
SELECT 'CREATE ROLE greenhouse LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'greenhouse')\gexec
ALTER ROLE greenhouse LOGIN PASSWORD :'pw';
SELECT 'CREATE DATABASE greenhouse OWNER greenhouse' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'greenhouse')\gexec
SQL
  } | runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -d postgres >/dev/null 2>&1; then
  die "postgres role/database setup failed; run 'sudo -u postgres psql' to inspect (output suppressed to keep the password out of logs)"
fi
env_set DATABASE_URL "postgres://greenhouse:${db_pw}@localhost:5432/greenhouse"
unset db_pw

# ───────────── 5. build (as the invoking user, inside the checkout) ─────────────

log "step 5/7: build edge and dashboard"
run_as_build pnpm --dir "$REPO_ROOT/edge" install --frozen-lockfile
run_as_build pnpm --dir "$REPO_ROOT/edge" build
run_as_build pnpm --dir "$REPO_ROOT/dashboard" install --frozen-lockfile
run_as_build pnpm --dir "$REPO_ROOT/dashboard" build
[[ -f "$REPO_ROOT/edge/dist/main.js" ]] || die "edge build did not produce dist/main.js"
[[ -f "$REPO_ROOT/dashboard/dist/index.html" ]] || die "dashboard build did not produce dist/index.html"

# ───────────── 6. stage runtime tree ─────────────

log "step 6/7: stage runtime under $APP_ROOT"
# Stop first: a graceful stop turns the pump OFF before files are swapped.
if systemctl is-active --quiet "$SERVICE"; then
  log "stopping $SERVICE for the file swap (pump OFF is sent on the way down)"
  systemctl stop "$SERVICE"
fi

rm -rf "$APP_ROOT/edge/dist" "$APP_ROOT/dashboard/dist"
cp -R "$REPO_ROOT/edge/dist" "$APP_ROOT/edge/dist"
# tsc does not copy .sql files. The migrator looks for dist/db/migrations first, so ship them there.
install -d "$APP_ROOT/edge/dist/db/migrations"
cp "$REPO_ROOT"/edge/src/db/migrations/*.sql "$APP_ROOT/edge/dist/db/migrations/"
cp -R "$REPO_ROOT/dashboard/dist" "$APP_ROOT/dashboard/dist"
install -m 0644 "$REPO_ROOT/edge/package.json" "$APP_ROOT/edge/package.json"
install -m 0644 "$REPO_ROOT/edge/pnpm-lock.yaml" "$APP_ROOT/edge/pnpm-lock.yaml"

# Production dependencies only, installed into the runtime tree (root-owned, read-only to the app).
pnpm --dir "$APP_ROOT/edge" install --prod --frozen-lockfile

chown -R root:root "$APP_ROOT"
find "$APP_ROOT" -type d -exec chmod 0755 {} +
find "$APP_ROOT" -type f -exec chmod 0644 {} +

# ───────────── 7. migrations, units, journald, start ─────────────

log "step 7/7: migrations, units, start"
(
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  cd "$APP_ROOT/edge"
  node dist/db/migrate.js
)

install -m 0644 "$SCRIPT_DIR/greenhouse-edge.service" "/etc/systemd/system/$SERVICE.service"
install -m 0644 "$SCRIPT_DIR/greenhouse-mock-actuator.service" "/etc/systemd/system/$MOCK_SERVICE.service"
install -d -m 0755 /etc/systemd/journald.conf.d
install -m 0644 "$SCRIPT_DIR/journald-greenhouse.conf" /etc/systemd/journald.conf.d/greenhouse.conf
systemctl restart systemd-journald
systemd-analyze verify "/etc/systemd/system/$SERVICE.service" 2>&1 || warn "systemd-analyze reported issues with $SERVICE.service"
systemctl daemon-reload

if (( WITH_MOCK )); then
  warn "mock actuator enabled. It is a FAKE pump: it reports ON without moving water. Never use it with a real pump."
  systemctl enable "$MOCK_SERVICE" >/dev/null
  systemctl restart "$MOCK_SERVICE"
fi

systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"

http_host="$(env_get HTTP_HOST)"
http_port="$(env_get HTTP_PORT)"
healthy=0
for _ in $(seq 1 20); do
  if curl -fsS --max-time 2 "http://${http_host}:${http_port}/healthz" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 1
done
if (( healthy )); then
  log "service healthy at http://${http_host}:${http_port}/ (dashboard) and /healthz"
else
  warn "health check did not pass within 20 s. Inspect: journalctl -u $SERVICE -n 100 -o cat"
  exit 1
fi

# ───────────── summary (no secrets) ─────────────

tz="$(timedatectl show -p Timezone --value 2>/dev/null || true)"
cat <<EOF

[install] done.
  env file        : $ENV_FILE  (root, 0600; contains API_TOKEN and DATABASE_URL)
  show token once : sudo grep '^API_TOKEN=' $ENV_FILE
  API / dashboard : http://${http_host}:${http_port}/
  CoAP ingest     : UDP $(env_get COAP_PORT) on [$(env_get COAP_HOST)] (sensor nodes use the Pi's Thread address)
  timezone        : ${tz:-unknown} (daily irrigation cap uses this LOCAL day; check: timedatectl)
                    change: sudo timedatectl set-timezone <Area/City>, then: sudo systemctl restart $SERVICE

Firewall (examples, NOT applied; adjust interface names and LAN CIDR):
  sudo ufw allow from 192.168.1.0/24 to any port $(env_get HTTP_PORT) proto tcp   # dashboard/API, LAN only
  sudo ufw allow in on wpan0 to any port $(env_get COAP_PORT) proto udp           # sensor CoAP, Thread side only
  sudo ufw default deny incoming   # only if you have checked SSH access first

Next: calibrate soil (docs/README.md, "Calibration"), then set ACTUATOR_HOST if a real pump driver is in place.
EOF
