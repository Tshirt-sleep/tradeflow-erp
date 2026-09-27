#!/usr/bin/env bash
set -Eeuo pipefail

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

if [[ "${EUID}" -ne 0 ]]; then
  die "Run this script with sudo: sudo bash infra/alibaba/deploy-ecs.sh"
fi

if [[ ! -r /etc/os-release ]]; then
  die "Cannot identify the operating system. This script supports Alibaba Cloud Linux 3."
fi
# shellcheck disable=SC1091
source /etc/os-release
[[ "${ID:-}" == "alinux" && "${VERSION_ID:-}" == 3* ]] || die "Expected Alibaba Cloud Linux 3; found ${PRETTY_NAME:-unknown}."

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
DATA_DIR="/srv/tradeflow"
cd "$ROOT_DIR"

[[ -f compose.yaml ]] || die "compose.yaml is missing from $ROOT_DIR. Copy the complete project source first."
[[ -f .env ]] || die "Create the production .env in $ROOT_DIR before deploying."
mountpoint -q "$DATA_DIR" || die "$DATA_DIR is not a mount point. Mount and verify the separate ECS data disk before starting TradeFlow."

require_env() {
  local key="$1"
  grep -Eq "^${key}=.+$" .env || die "Set ${key} in .env before deployment."
}

grep -Fxq 'TRADEFLOW_DATA_DIR=/srv/tradeflow' .env || die "Set TRADEFLOW_DATA_DIR=/srv/tradeflow so SQLite stays on the mounted data disk."
require_env BACKUP_S3_BUCKET
require_env BACKUP_S3_REGION
require_env BACKUP_S3_ENDPOINT
require_env BACKUP_S3_PREFIX
require_env TRADEFLOW_DOMAIN
grep -Fxq 'TRUST_PROXY_HOPS=1' .env || die "Set TRUST_PROXY_HOPS=1 because Caddy is the single trusted reverse proxy."
grep -Eq '^TRADEFLOW_SETUP_TOKEN=.{32,}$' .env || die "Set TRADEFLOW_SETUP_TOKEN to a random secret of at least 32 characters before deployment."
grep -Eq '^TRADEFLOW_DOMAIN=[A-Za-z0-9][A-Za-z0-9.-]+[A-Za-z0-9]$' .env || die "Set TRADEFLOW_DOMAIN to a public DNS hostname in .env."
grep -Eq '^TRADEFLOW_DOMAIN=[A-Za-z0-9.-]*example\.(com|net|org)$' .env && die "Replace the example TRADEFLOW_DOMAIN with your own public DNS hostname."
grep -Fxq 'BACKUP_S3_CREDENTIAL_MODE=ecs_ram_role' .env || die "Set BACKUP_S3_CREDENTIAL_MODE=ecs_ram_role."
require_env BACKUP_S3_RAM_ROLE_NAME

chmod 600 .env
install -d -m 0750 "$DATA_DIR"
if [[ -z "$(find "$DATA_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  chown 1000:1000 "$DATA_DIR"
else
  [[ "$(stat -c '%u' "$DATA_DIR")" == 1000 ]] || die "Existing data directory must be owned by container uid 1000: $DATA_DIR"
  non_node_owned="$(find "$DATA_DIR" -mindepth 1 ! -uid 1000 -print -quit)"
  [[ -z "$non_node_owned" ]] || die "Existing data is not owned by container uid 1000; inspect and migrate permissions without overwriting files: $non_node_owned"
fi

if ! command -v docker >/dev/null 2>&1; then
  command -v dnf >/dev/null 2>&1 || die "dnf is required to install Docker on Alibaba Cloud Linux 3."
  dnf -y install dnf-plugin-releasever-adapter --repo alinux3-plus
  dnf -y install curl
  curl -fsSL https://mirrors.aliyun.com/docker-ce/linux/centos/docker-ce.repo -o /etc/yum.repos.d/docker-ce.repo
  dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
elif ! docker compose version >/dev/null 2>&1; then
  die "Docker is already installed without the Compose plugin. Resolve the existing Docker packages manually to avoid replacing a working engine."
fi

systemctl enable --now docker
docker compose --profile cloud config --quiet
docker compose --profile cloud up -d --build

for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3001/api/health >/dev/null \
    && docker compose exec -T next-web node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    printf '\nTradeFlow API and Next.js are healthy.\n'
    docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
    docker compose ps
    exit 0
  fi
  sleep 2
done

docker compose logs --tail=100 tradeflow next-web caddy >&2 || true
die "TradeFlow API or Next.js did not become healthy within 60 seconds."
