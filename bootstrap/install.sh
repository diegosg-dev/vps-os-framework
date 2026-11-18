#!/usr/bin/env bash
set -euo pipefail

# VPS OS Framework - Idempotent Ubuntu LTS Bootstrapper (Step 0)
# Usage: sudo bash bootstrap/install.sh [--force]

VPS_OS_ROOT="${VPS_OS_ROOT:-/vps-os}"
APPS_ROOT="${APPS_ROOT:-/apps}"
CORE_NETWORK="${CORE_NETWORK:-vps-os-core}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
FORCE_OVERWRITE="${1:-}"

log() {
  printf '[vps-os-bootstrap] %s\n' "$1"
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "Error: bootstrap/install.sh must run as root (use sudo)." >&2
    exit 1
  fi
}

require_ubuntu() {
  if [[ ! -f /etc/os-release ]]; then
    echo "Error: cannot detect OS (/etc/os-release missing)." >&2
    exit 1
  fi
  # shellcheck source=/dev/null
  source /etc/os-release
  if [[ "${ID:-}" != "ubuntu" ]]; then
    echo "Error: Ubuntu LTS is required (detected: ${ID:-unknown})." >&2
    exit 1
  fi
  log "Detected Ubuntu ${VERSION_ID:-unknown}"
}

ensure_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log "Docker Engine and Compose v2 already installed."
    return
  fi

  log "Installing Docker Engine and Docker Compose v2 from official apt repository..."
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg openssl ufw
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc

  # shellcheck source=/dev/null
  source /etc/os-release
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' \
    "$(dpkg --print-architecture)" "${VERSION_CODENAME}" > /etc/apt/sources.list.d/docker.list

  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
}

detect_ssh_port() {
  local port=""
  if [[ -f /etc/ssh/sshd_config ]]; then
    port="$(awk '/^[[:space:]]*Port[[:space:]]+[0-9]+/ {print $2; exit}' /etc/ssh/sshd_config || true)"
  fi
  printf '%s' "${port:-22}"
}

harden_ssh() {
  local conf_dir="/etc/ssh/sshd_config.d"
  local conf_file="${conf_dir}/99-vps-os-hardening.conf"
  if [[ ! -d "${conf_dir}" ]] || [[ -f "${conf_file}" && "${FORCE_OVERWRITE}" != "--force" ]]; then
    return
  fi

  log "Applying non-destructive SSH hardening defaults..."
  {
    echo "PermitRootLogin prohibit-password"
    if [[ -s /root/.ssh/authorized_keys ]]; then
      echo "PasswordAuthentication no"
    fi
  } > "${conf_file}"
  chmod 644 "${conf_file}"
  systemctl reload ssh || systemctl reload sshd || true
}

configure_firewall() {
  if ! command -v ufw >/dev/null 2>&1; then
    apt-get update -y && apt-get install -y ufw
  fi

  local ssh_port
  ssh_port="$(detect_ssh_port)"
  log "Configuring UFW firewall (allow SSH ${ssh_port}/tcp, 80/tcp, 443/tcp)..."
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow "${ssh_port}/tcp"
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw --force enable
}

copy_if_needed() {
  local src="$1"
  local dst="$2"
  if [[ ! -f "${dst}" ]] || [[ "${FORCE_OVERWRITE}" == "--force" ]]; then
    cp "${src}" "${dst}"
  else
    log "Preserving existing ${dst} (pass --force to overwrite)."
  fi
}

prepare_directories() {
  log "Preparing ${VPS_OS_ROOT} and ${APPS_ROOT}..."
  mkdir -p "${VPS_OS_ROOT}/data" "${VPS_OS_ROOT}/caddy/apps.d" "${APPS_ROOT}"
  chmod 750 "${VPS_OS_ROOT}" "${APPS_ROOT}"
  chown 1000:1000 "${VPS_OS_ROOT}/data" "${APPS_ROOT}"

  if [[ ! -f "${VPS_OS_ROOT}/.env" ]]; then
    local generated_token
    generated_token="$(openssl rand -hex 32)"
    sed "s|^VPS_OS_ADMIN_TOKEN=.*$|VPS_OS_ADMIN_TOKEN=${generated_token}|" \
      "${SCRIPT_DIR}/.env.example" > "${VPS_OS_ROOT}/.env"
    chmod 600 "${VPS_OS_ROOT}/.env"
    log "Created ${VPS_OS_ROOT}/.env with a generated VPS_OS_ADMIN_TOKEN."
  fi

  copy_if_needed "${SCRIPT_DIR}/Caddyfile" "${VPS_OS_ROOT}/Caddyfile"
  copy_if_needed "${SCRIPT_DIR}/docker-compose.core.yml" "${VPS_OS_ROOT}/docker-compose.yml"
  copy_if_needed "${SCRIPT_DIR}/caddy/apps.d/00-default.caddy" "${VPS_OS_ROOT}/caddy/apps.d/00-default.caddy"
}

validate_runtime_env() {
  # shellcheck source=/dev/null
  source "${VPS_OS_ROOT}/.env"
  if [[ "${VPS_OS_DOMAIN:-}" == "os.example.com" ]]; then
    echo "Error: VPS_OS_DOMAIN in ${VPS_OS_ROOT}/.env is still set to placeholder os.example.com." >&2
    exit 1
  fi
  if [[ -z "${VPS_OS_ADMIN_TOKEN:-}" ]] || [[ "${VPS_OS_ADMIN_TOKEN}" == replace-with-* ]]; then
    echo "Error: VPS_OS_ADMIN_TOKEN in ${VPS_OS_ROOT}/.env must be a generated secret." >&2
    exit 1
  fi
}

ensure_core_network() {
  if ! docker network inspect "${CORE_NETWORK}" >/dev/null 2>&1; then
    log "Creating isolated core Docker network (${CORE_NETWORK})..."
    docker network create --driver bridge "${CORE_NETWORK}"
  fi
}

bring_up_core() {
  log "Building, validating, and starting VPS OS core stack..."
  export CORE_NETWORK
  export VPS_OS_REPO_DIR="${REPO_ROOT}"
  docker compose \
    -f "${VPS_OS_ROOT}/docker-compose.yml" \
    --env-file "${VPS_OS_ROOT}/.env" config >/dev/null
  docker compose \
    -f "${VPS_OS_ROOT}/docker-compose.yml" \
    --env-file "${VPS_OS_ROOT}/.env" up -d --build
  log "VPS OS core stack is running."
}

main() {
  require_root
  require_ubuntu
  ensure_docker
  harden_ssh
  configure_firewall
  prepare_directories
  validate_runtime_env
  ensure_core_network
  bring_up_core
}

main "$@"
