#!/usr/bin/env bash
set -euo pipefail

# VPS OS Framework - Idempotent Ubuntu LTS Bootstrapper (Step 0)
# Usage:
#   sudo bash bootstrap/install.sh [--force] [--non-interactive] [--domain os.yourdomain.com] [--email you@yourdomain.com]
#   curl -fsSL https://raw.githubusercontent.com/diegosg-dev/vps-os-framework/main/bootstrap/install.sh | sudo bash

VPS_OS_ROOT="${VPS_OS_ROOT:-/vps-os}"
APPS_ROOT="${APPS_ROOT:-/apps}"
HERMES_HOME="${HERMES_HOME:-${VPS_OS_ROOT}/hermes}"
CORE_NETWORK="${CORE_NETWORK:-vps-os-core}"
INSTALL_HERMES="${INSTALL_HERMES:-true}"
VPS_OS_REPO_URL="${VPS_OS_REPO_URL:-https://github.com/diegosg-dev/vps-os-framework.git}"
VPS_OS_REPO_REF="${VPS_OS_REPO_REF:-main}"
VPS_OS_REPO_DIR="${VPS_OS_REPO_DIR:-/opt/vps-os-framework}"

FORCE_OVERWRITE=""
NON_INTERACTIVE="false"
ARG_DOMAIN=""
ARG_EMAIL=""
ARG_LLM_PROVIDER=""
ARG_LLM_MODEL=""
ARG_LLM_KEY=""
ROTATE_SETUP_CODE="false"
GENERATED_SETUP_CODE=""
DETECTED_PUBLIC_IP=""

SOURCE_PATH="${BASH_SOURCE[0]:-}"
if [[ -n "${SOURCE_PATH}" && -f "${SOURCE_PATH}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${SOURCE_PATH}")" && pwd)"
  REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
else
  SCRIPT_DIR=""
  REPO_ROOT=""
fi

log() {
  printf '[vps-os-bootstrap] %s\n' "$1"
}

usage() {
  cat <<'EOF'
VPS OS Framework — Ubuntu LTS Bootstrapper

Options:
  --domain <host>         Public dashboard domain (e.g. os.yourdomain.com)
  --email <email>         ACME/Let's Encrypt notification email
  --llm-provider <name>   Pre-configure LLM provider (openai|anthropic|openrouter|nous|ollama)
  --llm-model <model>     Pre-configure LLM model identifier
  --llm-key <key>         Pre-configure LLM API key
  --rotate-setup-code     Generate a fresh single-use browser setup pairing code
  --non-interactive, -y   Skip interactive prompts (for cloud-init / CI)
  --force                 Overwrite preserved config and unit files
  --help, -h              Show this help message
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --force)
        FORCE_OVERWRITE="--force"
        shift
        ;;
      --non-interactive|-y)
        NON_INTERACTIVE="true"
        shift
        ;;
      --domain)
        ARG_DOMAIN="${2:-}"
        shift 2
        ;;
      --email)
        ARG_EMAIL="${2:-}"
        shift 2
        ;;
      --llm-provider)
        ARG_LLM_PROVIDER="${2:-}"
        shift 2
        ;;
      --llm-model)
        ARG_LLM_MODEL="${2:-}"
        shift 2
        ;;
      --llm-key)
        ARG_LLM_KEY="${2:-}"
        shift 2
        ;;
      --rotate-setup-code)
        ROTATE_SETUP_CODE="true"
        shift
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        echo "Error: Unknown argument '$1'." >&2
        usage >&2
        exit 1
        ;;
    esac
  done
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

ensure_repo_checkout() {
  if [[ -n "${REPO_ROOT}" && -d "${REPO_ROOT}/agent/hermes" && -f "${REPO_ROOT}/bootstrap/docker-compose.core.yml" ]]; then
    return
  fi

  if ! command -v git >/dev/null 2>&1; then
    log "Installing git to fetch VPS OS repository..."
    apt-get update -y
    apt-get install -y git ca-certificates curl
  fi

  if [[ -d "${VPS_OS_REPO_DIR}/.git" ]]; then
    log "Updating existing VPS OS repository in ${VPS_OS_REPO_DIR}..."
    git -C "${VPS_OS_REPO_DIR}" fetch --depth 1 origin "${VPS_OS_REPO_REF}"
    git -C "${VPS_OS_REPO_DIR}" checkout -B "${VPS_OS_REPO_REF}" "origin/${VPS_OS_REPO_REF}"
  else
    log "Cloning VPS OS repository into ${VPS_OS_REPO_DIR}..."
    git clone --depth 1 --branch "${VPS_OS_REPO_REF}" "${VPS_OS_REPO_URL}" "${VPS_OS_REPO_DIR}"
  fi

  REPO_ROOT="${VPS_OS_REPO_DIR}"
  SCRIPT_DIR="${REPO_ROOT}/bootstrap"
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

ensure_python3() {
  if command -v python3 >/dev/null 2>&1; then
    return
  fi
  log "Installing Python 3 for the VPS OS Host Runtime Bridge..."
  apt-get update -y
  apt-get install -y python3
}

detect_ssh_port() {
  local port=""
  if [[ -f /etc/ssh/sshd_config ]]; then
    port="$(awk '/^[[:space:]]*Port[[:space:]]+[0-9]+/ {print $2; exit}' /etc/ssh/sshd_config || true)"
  fi
  printf '%s' "${port:-22}"
}

detect_public_ip() {
  local ip=""
  local probe
  for probe in "https://api.ipify.org" "https://ipv4.icanhazip.com"; do
    ip="$(curl -fsS --max-time 3 "${probe}" 2>/dev/null | tr -d '[:space:]' || true)"
    if [[ "${ip}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      printf '%s' "${ip}"
      return
    fi
  done
  if command -v ip >/dev/null 2>&1; then
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1; i<=NF; i++) if ($i == "src") {print $(i+1); exit}}' || true)"
    if [[ "${ip}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      printf '%s' "${ip}"
      return
    fi
  fi
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

upsert_env_key() {
  local env_file="$1"
  local key="$2"
  local val="$3"
  local tmp_file
  tmp_file="$(mktemp)"
  TARGET_KEY="${key}" TARGET_VAL="${val}" awk '
    BEGIN {
      target_key = ENVIRON["TARGET_KEY"]
      target_val = ENVIRON["TARGET_VAL"]
      updated = 0
    }
    index($0, target_key "=") == 1 {
      print target_key "=" target_val
      updated = 1
      next
    }
    { print }
    END {
      if (!updated) {
        print target_key "=" target_val
      }
    }
  ' "${env_file}" > "${tmp_file}"
  chmod 600 "${tmp_file}"
  mv "${tmp_file}" "${env_file}"
}

sha256_hex() {
  local input="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "${input}" | sha256sum | awk '{print $1}'
  else
    printf '%s' "${input}" | openssl dgst -sha256 -r | awk '{print $1}'
  fi
}

generate_setup_claim() {
  local claim_file="${VPS_OS_ROOT}/data/setup-claim.json"
  if [[ -f "${claim_file}" && "${ROTATE_SETUP_CODE}" != "true" ]]; then
    return
  fi

  local raw_code=""
  while [[ "${#raw_code}" -lt 12 ]]; do
    raw_code="${raw_code}$(openssl rand -base64 24 | tr -dc 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789')"
  done
  raw_code="${raw_code:0:12}"
  GENERATED_SETUP_CODE="${raw_code:0:4}-${raw_code:4:4}-${raw_code:8:4}"

  local code_hash created_at expires_at
  code_hash="$(sha256_hex "${raw_code}")"
  created_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  expires_at="$(date -u -d "+24 hours" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u +"%Y-%m-%dT23:59:59Z")"

  cat > "${claim_file}" <<EOF
{
  "codeHash": "${code_hash}",
  "createdAt": "${created_at}",
  "expiresAt": "${expires_at}",
  "consumedAt": null,
  "failedAttempts": 0
}
EOF
  chown 1000:1000 "${claim_file}"
  chmod 600 "${claim_file}"
}

prompt_domain_if_interactive() {
  if [[ -n "${ARG_DOMAIN}" || "${NON_INTERACTIVE}" == "true" || ! -t 0 ]]; then
    return
  fi

  # shellcheck source=/dev/null
  source "${VPS_OS_ROOT}/.env"
  if [[ -n "${VPS_OS_DOMAIN:-}" && "${VPS_OS_DOMAIN}" != "localhost" && "${VPS_OS_DOMAIN}" != "os.example.com" ]]; then
    return
  fi

  printf '\n'
  log "Optional domain setup (you can also do this in the browser Setup Wizard):"
  if [[ -n "${DETECTED_PUBLIC_IP}" ]]; then
    printf '  Detected public IP: %s\n' "${DETECTED_PUBLIC_IP}"
  fi
  local input_domain=""
  read -r -p "  Enter domain for automatic HTTPS (or press Enter for IP setup mode): " input_domain || true
  input_domain="${input_domain// /}"
  if [[ -n "${input_domain}" ]]; then
    ARG_DOMAIN="${input_domain}"
    if [[ -z "${ARG_EMAIL}" ]]; then
      local input_email=""
      read -r -p "  Enter email for Let's Encrypt SSL alerts (optional): " input_email || true
      ARG_EMAIL="${input_email// /}"
    fi
  fi
}

check_domain_dns() {
  local domain="$1"
  local resolved=""
  if command -v getent >/dev/null 2>&1; then
    resolved="$(getent ahostsv4 "${domain}" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || true)"
  fi
  if [[ -z "${resolved}" ]] && command -v dig >/dev/null 2>&1; then
    resolved="$(dig +short A "${domain}" 2>/dev/null | tr '\n' ' ' || true)"
  fi

  if [[ -z "${resolved}" ]]; then
    log "Warning: DNS A record for ${domain} does not resolve yet."
    if [[ -n "${DETECTED_PUBLIC_IP}" ]]; then
      log "Create an A record: ${domain} -> ${DETECTED_PUBLIC_IP}, then verify in the Setup Wizard."
    fi
  elif [[ -n "${DETECTED_PUBLIC_IP}" && " ${resolved} " != *" ${DETECTED_PUBLIC_IP} "* ]]; then
    log "Warning: ${domain} resolves to [${resolved}], expected ${DETECTED_PUBLIC_IP}."
    log "Update your DNS A record to ${DETECTED_PUBLIC_IP} before requesting public TLS certificates."
  else
    log "DNS check passed: ${domain} -> ${resolved}"
  fi
}

prepare_directories() {
  log "Preparing ${VPS_OS_ROOT}, ${APPS_ROOT}, and ${HERMES_HOME}..."
  mkdir -p "${VPS_OS_ROOT}/data" "${VPS_OS_ROOT}/config" "${VPS_OS_ROOT}/run" \
    "${VPS_OS_ROOT}/caddy/apps.d" "${APPS_ROOT}" "${HERMES_HOME}/memories" "${HERMES_HOME}/skills"
  chmod 750 "${VPS_OS_ROOT}" "${VPS_OS_ROOT}/config" "${VPS_OS_ROOT}/run" "${APPS_ROOT}" "${HERMES_HOME}"
  chown 0:1000 "${VPS_OS_ROOT}/run"
  chown 1000:1000 "${VPS_OS_ROOT}/data" "${VPS_OS_ROOT}/config" "${APPS_ROOT}"

  local fresh_env="false"
  if [[ ! -f "${VPS_OS_ROOT}/.env" ]]; then
    local generated_token generated_runtime_token generated_hermes_key
    generated_token="$(openssl rand -hex 32)"
    generated_runtime_token="$(openssl rand -hex 32)"
    generated_hermes_key="$(openssl rand -hex 32)"
    sed \
      -e "s|^VPS_OS_ADMIN_TOKEN=.*$|VPS_OS_ADMIN_TOKEN=${generated_token}|" \
      -e "s|^VPS_OS_RUNTIME_TOKEN=.*$|VPS_OS_RUNTIME_TOKEN=${generated_runtime_token}|" \
      -e "s|^HERMES_API_SERVER_KEY=.*$|HERMES_API_SERVER_KEY=${generated_hermes_key}|" \
      -e "s|^HERMES_HOME=.*$|HERMES_HOME=${HERMES_HOME}|" \
      "${SCRIPT_DIR}/.env.example" > "${VPS_OS_ROOT}/.env"
    chmod 600 "${VPS_OS_ROOT}/.env"
    fresh_env="true"
    log "Created ${VPS_OS_ROOT}/.env with generated admin, runtime, and Hermes keys."
  else
    # Ensure existing installs upgrading to the runtime bridge receive VPS_OS_RUNTIME_TOKEN.
    # shellcheck source=/dev/null
    source "${VPS_OS_ROOT}/.env"
    if [[ -z "${VPS_OS_RUNTIME_TOKEN:-}" ]] || [[ "${VPS_OS_RUNTIME_TOKEN}" == replace-with-* ]]; then
      upsert_env_key "${VPS_OS_ROOT}/.env" "VPS_OS_RUNTIME_TOKEN" "$(openssl rand -hex 32)"
      log "Generated missing VPS_OS_RUNTIME_TOKEN in ${VPS_OS_ROOT}/.env."
    fi
  fi

  if [[ ! -f "${VPS_OS_ROOT}/config/onboarding.env" ]]; then
    : > "${VPS_OS_ROOT}/config/onboarding.env"
    chown 1000:1000 "${VPS_OS_ROOT}/config/onboarding.env"
    chmod 600 "${VPS_OS_ROOT}/config/onboarding.env"
  fi

  DETECTED_PUBLIC_IP="$(detect_public_ip || true)"
  if [[ -n "${DETECTED_PUBLIC_IP}" ]]; then
    upsert_env_key "${VPS_OS_ROOT}/.env" "VPS_OS_PUBLIC_IP" "${DETECTED_PUBLIC_IP}"
  fi

  prompt_domain_if_interactive

  if [[ -n "${ARG_DOMAIN}" ]]; then
    if [[ "${ARG_DOMAIN}" == "os.example.com" ]]; then
      echo "Error: --domain cannot be placeholder os.example.com." >&2
      exit 1
    fi
    upsert_env_key "${VPS_OS_ROOT}/.env" "VPS_OS_DOMAIN" "${ARG_DOMAIN}"
    upsert_env_key "${VPS_OS_ROOT}/.env" "VPS_OS_SITE_ADDRESS" "${ARG_DOMAIN}"
    check_domain_dns "${ARG_DOMAIN}"
  else
    # Default to :80 setup mode on initial install when no domain is bound yet,
    # so the owner can immediately open http://<PUBLIC_IP> and run the Setup Wizard.
    # shellcheck source=/dev/null
    source "${VPS_OS_ROOT}/.env"
    if [[ "${VPS_OS_DOMAIN:-localhost}" == "localhost" && -n "${DETECTED_PUBLIC_IP}" ]]; then
      upsert_env_key "${VPS_OS_ROOT}/.env" "VPS_OS_SITE_ADDRESS" ":80"
    fi
  fi

  if [[ -n "${ARG_EMAIL}" ]]; then
    upsert_env_key "${VPS_OS_ROOT}/.env" "VPS_OS_ACME_EMAIL" "${ARG_EMAIL}"
  fi
  if [[ -n "${ARG_LLM_PROVIDER}" ]]; then
    upsert_env_key "${VPS_OS_ROOT}/.env" "LLM_PROVIDER" "${ARG_LLM_PROVIDER}"
  fi
  if [[ -n "${ARG_LLM_MODEL}" ]]; then
    upsert_env_key "${VPS_OS_ROOT}/.env" "LLM_MODEL" "${ARG_LLM_MODEL}"
  fi
  if [[ -n "${ARG_LLM_KEY}" ]]; then
    upsert_env_key "${VPS_OS_ROOT}/.env" "LLM_API_KEY" "${ARG_LLM_KEY}"
  fi

  if [[ "${fresh_env}" == "true" || "${ROTATE_SETUP_CODE}" == "true" ]]; then
    generate_setup_claim
  fi

  copy_if_needed "${SCRIPT_DIR}/Caddyfile" "${VPS_OS_ROOT}/Caddyfile"
  if [[ -f "${VPS_OS_ROOT}/docker-compose.yml" ]] && [[ "${FORCE_OVERWRITE}" != "--force" ]] && ! grep -q "VPS_OS_RUNTIME_SOCKET" "${VPS_OS_ROOT}/docker-compose.yml"; then
    cp "${VPS_OS_ROOT}/docker-compose.yml" "${VPS_OS_ROOT}/docker-compose.yml.bak"
    cp "${SCRIPT_DIR}/docker-compose.core.yml" "${VPS_OS_ROOT}/docker-compose.yml"
    log "Upgraded ${VPS_OS_ROOT}/docker-compose.yml for runtime bridge wiring (backup at docker-compose.yml.bak)."
  else
    copy_if_needed "${SCRIPT_DIR}/docker-compose.core.yml" "${VPS_OS_ROOT}/docker-compose.yml"
  fi
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

  # Start gateway automatically once an LLM API key (or local Ollama) is configured.
  # shellcheck source=/dev/null
  source "${VPS_OS_ROOT}/.env"
  if [[ "${LLM_PROVIDER:-}" == "ollama" ]] || { [[ -n "${LLM_API_KEY:-}" ]] && [[ "${LLM_API_KEY}" != replace-with-* ]]; }; then
    systemctl restart vps-os-hermes-cto.service
    log "Hermes CTO gateway is running on 127.0.0.1:8642."
  else
    log "Hermes CTO configured at ${HERMES_HOME}; complete setup in the browser Setup Wizard to start it automatically."
  fi
}

configure_onboarding_sync_service() {
  if ! command -v systemctl >/dev/null 2>&1; then
    return
  fi
  local apply_script="${REPO_ROOT}/bootstrap/apply-onboarding.sh"
  if [[ ! -f "${apply_script}" ]]; then
    return
  fi
  chmod 750 "${apply_script}"

  local svc_file="/etc/systemd/system/vps-os-onboarding-apply.service"
  local path_file="/etc/systemd/system/vps-os-onboarding-apply.path"
  if [[ ! -f "${svc_file}" ]] || [[ "${FORCE_OVERWRITE}" == "--force" ]]; then
    cat > "${svc_file}" <<EOF
[Unit]
Description=Apply VPS OS Browser Onboarding Configuration
After=docker.service

[Service]
Type=oneshot
Environment="VPS_OS_ROOT=${VPS_OS_ROOT}"
Environment="HERMES_HOME=${HERMES_HOME}"
ExecStart=/bin/bash ${apply_script}
EOF
    chmod 644 "${svc_file}"
  fi

  if [[ ! -f "${path_file}" ]] || [[ "${FORCE_OVERWRITE}" == "--force" ]]; then
    cat > "${path_file}" <<EOF
[Unit]
Description=Watch VPS OS Onboarding Apply Trigger

[Path]
PathModified=${VPS_OS_ROOT}/data/onboarding-apply.trigger

[Install]
WantedBy=multi-user.target
EOF
    chmod 644 "${path_file}"
  fi

  systemctl daemon-reload
  systemctl enable --now vps-os-onboarding-apply.path
}

configure_runtime_bridge_service() {
  if ! command -v systemctl >/dev/null 2>&1; then
    return
  fi
  local bridge_script="${REPO_ROOT}/bootstrap/runtime-bridge.py"
  if [[ ! -f "${bridge_script}" ]]; then
    echo "Error: missing runtime bridge script at ${bridge_script}." >&2
    exit 1
  fi
  chmod 750 "${bridge_script}"

  # Expose ONLY VPS_OS_RUNTIME_TOKEN to the root runtime daemon (never admin/LLM keys),
  # stored under root-owned ${VPS_OS_ROOT} (not container-writable config/).
  # shellcheck source=/dev/null
  source "${VPS_OS_ROOT}/.env"
  local bridge_env="${VPS_OS_ROOT}/runtime-bridge.env"
  local tmp_env
  tmp_env="$(mktemp)"
  printf 'VPS_OS_RUNTIME_TOKEN=%s\n' "${VPS_OS_RUNTIME_TOKEN}" > "${tmp_env}"
  chown 0:0 "${tmp_env}"
  chmod 600 "${tmp_env}"
  mv "${tmp_env}" "${bridge_env}"

  local svc_file="/etc/systemd/system/vps-os-runtime.service"
  if [[ ! -f "${svc_file}" ]] || [[ "${FORCE_OVERWRITE}" == "--force" ]] || ! grep -q "ProtectHome=true" "${svc_file}"; then
    log "Configuring ${svc_file}..."
    cat > "${svc_file}" <<EOF
[Unit]
Description=VPS OS Host Runtime Bridge (Docker Compose & Caddy)
After=docker.service
Requires=docker.service

[Service]
Type=simple
EnvironmentFile=${bridge_env}
Environment="VPS_OS_RUNTIME_SOCKET=${VPS_OS_ROOT}/run/runtime.sock"
Environment="VPS_OS_APPS_ROOT=${APPS_ROOT}"
Environment="VPS_OS_CADDY_APPS_DIR=${VPS_OS_ROOT}/caddy/apps.d"
Environment="VPS_OS_CADDY_CONTAINER=vps-os-caddy"
ExecStart=/usr/bin/env python3 ${bridge_script}
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateDevices=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ReadWritePaths=${VPS_OS_ROOT} ${APPS_ROOT} /run
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
    chmod 644 "${svc_file}"
    systemctl daemon-reload
  fi

  systemctl enable vps-os-runtime.service
  systemctl restart vps-os-runtime.service
  log "Host runtime bridge listening at ${VPS_OS_ROOT}/run/runtime.sock."
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
  if [[ -z "${VPS_OS_RUNTIME_TOKEN:-}" ]] || [[ "${VPS_OS_RUNTIME_TOKEN}" == replace-with-* ]]; then
    echo "Error: VPS_OS_RUNTIME_TOKEN in ${VPS_OS_ROOT}/.env must be a generated secret." >&2
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

print_onboarding_summary() {
  # shellcheck source=/dev/null
  source "${VPS_OS_ROOT}/.env"
  local base_url=""
  if [[ -n "${VPS_OS_DOMAIN:-}" && "${VPS_OS_DOMAIN}" != "localhost" ]]; then
    base_url="https://${VPS_OS_DOMAIN}"
  elif [[ -n "${DETECTED_PUBLIC_IP}" ]]; then
    base_url="http://${DETECTED_PUBLIC_IP}"
  else
    base_url="http://localhost"
  fi

  printf '\n====================================================================\n'
  printf '  VPS OS Framework is ready for browser onboarding!\n'
  printf '====================================================================\n'
  printf '  Dashboard URL : %s/\n' "${base_url}"
  if [[ -n "${GENERATED_SETUP_CODE}" ]]; then
    printf '  Setup Code    : %s (single-use, expires in 24h)\n' "${GENERATED_SETUP_CODE}"
    printf '  One-Click Link: %s/#claim=%s\n' "${base_url}" "${GENERATED_SETUP_CODE}"
  else
    printf '  Sign In       : Use your Admin Passphrase or VPS_OS_ADMIN_TOKEN\n'
    printf '                  (run with --rotate-setup-code to mint a new pairing code)\n'
  fi
  printf '====================================================================\n\n'
}

main() {
  parse_args "$@"
  require_root
  require_ubuntu
  ensure_repo_checkout
  ensure_docker
  ensure_python3
  harden_ssh
  configure_firewall
  prepare_directories
  validate_runtime_env
  ensure_core_network
  configure_runtime_bridge_service
  bring_up_core
  # Install Hermes before syncing our CTO pack so repo SOUL.md, config.yaml,
  # and vps-os-* skills take precedence over installer defaults.
  ensure_hermes
  sync_hermes_pack
  configure_hermes_service
  configure_onboarding_sync_service
  print_onboarding_summary
}

main "$@"
