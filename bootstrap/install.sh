#!/usr/bin/env bash
set -euo pipefail

# VPS OS Framework - Idempotent Ubuntu LTS Bootstrapper (Step 0)
# Usage: sudo bash bootstrap/install.sh [--force]

VPS_OS_ROOT="${VPS_OS_ROOT:-/vps-os}"
APPS_ROOT="${APPS_ROOT:-/apps}"
HERMES_HOME="${HERMES_HOME:-${VPS_OS_ROOT}/hermes}"
CORE_NETWORK="${CORE_NETWORK:-vps-os-core}"
INSTALL_HERMES="${INSTALL_HERMES:-true}"
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
  log "Preparing ${VPS_OS_ROOT}, ${APPS_ROOT}, and ${HERMES_HOME}..."
  mkdir -p "${VPS_OS_ROOT}/data" "${VPS_OS_ROOT}/caddy/apps.d" "${APPS_ROOT}" \
    "${HERMES_HOME}/memories" "${HERMES_HOME}/skills"
  chmod 750 "${VPS_OS_ROOT}" "${APPS_ROOT}" "${HERMES_HOME}"
  chown 1000:1000 "${VPS_OS_ROOT}/data" "${APPS_ROOT}"

  if [[ ! -f "${VPS_OS_ROOT}/.env" ]]; then
    local generated_token generated_hermes_key
    generated_token="$(openssl rand -hex 32)"
    generated_hermes_key="$(openssl rand -hex 32)"
    sed \
      -e "s|^VPS_OS_ADMIN_TOKEN=.*$|VPS_OS_ADMIN_TOKEN=${generated_token}|" \
      -e "s|^HERMES_API_SERVER_KEY=.*$|HERMES_API_SERVER_KEY=${generated_hermes_key}|" \
      -e "s|^HERMES_HOME=.*$|HERMES_HOME=${HERMES_HOME}|" \
      "${SCRIPT_DIR}/.env.example" > "${VPS_OS_ROOT}/.env"
    chmod 600 "${VPS_OS_ROOT}/.env"
    log "Created ${VPS_OS_ROOT}/.env with generated VPS_OS_ADMIN_TOKEN and HERMES_API_SERVER_KEY."
  fi

  copy_if_needed "${SCRIPT_DIR}/Caddyfile" "${VPS_OS_ROOT}/Caddyfile"
  copy_if_needed "${SCRIPT_DIR}/docker-compose.core.yml" "${VPS_OS_ROOT}/docker-compose.yml"
  copy_if_needed "${SCRIPT_DIR}/caddy/apps.d/00-default.caddy" "${VPS_OS_ROOT}/caddy/apps.d/00-default.caddy"
}

render_hermes_config() {
  local src_cfg="$1"
  local dst_cfg="$2"
  # Invoke the MCP stdio server inside the hardened vps-os-agent container so
  # the Ubuntu host does not need its own Node.js toolchain installed.
  local mcp_args_block
  mcp_args_block=$'exec\n      - -i\n      - vps-os-agent\n      - node\n      - /srv/vps-os/agent/dist/mcp-server.js'

  awk \
    -v cmd="docker" \
    -v entry="${mcp_args_block}" \
    -v db="/data/registry.db" \
    -v apps="/apps" \
    -v tpl="/srv/vps-os/templates" \
    '{
      gsub(/__VPS_OS_MCP_COMMAND__/, cmd);
      gsub(/__VPS_OS_MCP_ENTRY__/, entry);
      gsub(/__VPS_OS_REGISTRY_DB__/, db);
      gsub(/__VPS_OS_APPS_ROOT__/, apps);
      gsub(/__VPS_OS_TEMPLATES_ROOT__/, tpl);
      print;
    }' "${src_cfg}" > "${dst_cfg}"
}

sync_hermes_pack() {
  local pack_dir="${REPO_ROOT}/agent/hermes"
  if [[ ! -d "${pack_dir}" ]]; then
    echo "Error: missing Hermes CTO pack at ${pack_dir}." >&2
    exit 1
  fi

  log "Syncing Hermes CTO identity and core skills into ${HERMES_HOME}..."
  cp "${pack_dir}/SOUL.md" "${HERMES_HOME}/SOUL.md"

  local skill_dir skill_name
  for skill_dir in "${pack_dir}/skills"/vps-os-*; do
    [[ -d "${skill_dir}" ]] || continue
    skill_name="$(basename "${skill_dir}")"
    mkdir -p "${HERMES_HOME}/skills/${skill_name}"
    cp -r "${skill_dir}/." "${HERMES_HOME}/skills/${skill_name}/"
  done

  copy_if_needed "${pack_dir}/memories/MEMORY.md" "${HERMES_HOME}/memories/MEMORY.md"
  copy_if_needed "${pack_dir}/memories/USER.md" "${HERMES_HOME}/memories/USER.md"

  if [[ ! -f "${HERMES_HOME}/config.yaml" ]] || [[ "${FORCE_OVERWRITE}" == "--force" ]]; then
    render_hermes_config "${pack_dir}/config.yaml" "${HERMES_HOME}/config.yaml"
    chmod 600 "${HERMES_HOME}/config.yaml"
  else
    log "Preserving existing ${HERMES_HOME}/config.yaml (pass --force to overwrite)."
  fi
}

find_hermes_bin() {
  if command -v hermes >/dev/null 2>&1; then
    command -v hermes
    return
  fi
  local candidate
  for candidate in /usr/local/bin/hermes /root/.local/bin/hermes "${HERMES_HOME}/bin/hermes"; do
    if [[ -x "${candidate}" ]]; then
      printf '%s' "${candidate}"
      return
    fi
  done
}

ensure_hermes() {
  if [[ "${INSTALL_HERMES}" != "true" ]]; then
    log "Skipping Hermes Agent installation (INSTALL_HERMES=${INSTALL_HERMES})."
    return
  fi

  if [[ -n "$(find_hermes_bin)" ]]; then
    log "Hermes Agent CLI already installed."
    return
  fi

  log "Installing NousResearch Hermes Agent into ${HERMES_HOME}..."
  HERMES_HOME="${HERMES_HOME}" curl -fsSL https://hermes-agent.nousresearch.com/install.sh | HERMES_HOME="${HERMES_HOME}" bash
}

configure_hermes_service() {
  if [[ "${INSTALL_HERMES}" != "true" ]]; then
    return
  fi

  local hermes_bin
  hermes_bin="$(find_hermes_bin)"
  if [[ -z "${hermes_bin}" ]]; then
    log "Warning: hermes CLI not found; skipping systemd service setup."
    return
  fi

  local unit_file="/etc/systemd/system/vps-os-hermes-cto.service"
  if [[ ! -f "${unit_file}" ]] || [[ "${FORCE_OVERWRITE}" == "--force" ]]; then
    log "Configuring ${unit_file}..."
    cat > "${unit_file}" <<EOF
[Unit]
Description=VPS OS Hermes Autonomous CTO Gateway
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=${HERMES_HOME}
EnvironmentFile=${VPS_OS_ROOT}/.env
Environment="HERMES_HOME=${HERMES_HOME}"
Environment="API_SERVER_ENABLED=true"
Environment="API_SERVER_HOST=127.0.0.1"
Environment="API_SERVER_PORT=8642"
ExecStart=${hermes_bin} gateway
Restart=always
RestartSec=10
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
    chmod 644 "${unit_file}"
    systemctl daemon-reload
    systemctl enable vps-os-hermes-cto.service
  fi

  # Start gateway automatically once an LLM API key is configured.
  # shellcheck source=/dev/null
  source "${VPS_OS_ROOT}/.env"
  if [[ -n "${LLM_API_KEY:-}" ]] && [[ "${LLM_API_KEY}" != replace-with-* ]]; then
    systemctl restart vps-os-hermes-cto.service
    log "Hermes CTO gateway is running on 127.0.0.1:8642."
  else
    log "Hermes CTO configured at ${HERMES_HOME}; set LLM_API_KEY in ${VPS_OS_ROOT}/.env and run 'systemctl start vps-os-hermes-cto'."
  fi
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
  # Install Hermes before syncing our CTO pack so repo SOUL.md, config.yaml,
  # and vps-os-* skills take precedence over installer defaults.
  ensure_hermes
  sync_hermes_pack
  configure_hermes_service
}

main "$@"
