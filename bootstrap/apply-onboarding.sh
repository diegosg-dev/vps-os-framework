#!/usr/bin/env bash
set -euo pipefail

# VPS OS Framework - Scoped Host Onboarding Sync
# Invoked by vps-os-onboarding-apply.service when dashboard-api updates
# /vps-os/config/onboarding.env or /vps-os/data/hermes-staging/*.

VPS_OS_ROOT="${VPS_OS_ROOT:-/vps-os}"
HERMES_HOME="${HERMES_HOME:-${VPS_OS_ROOT}/hermes}"
ONBOARDING_ENV="${VPS_OS_ROOT}/config/onboarding.env"
MAIN_ENV="${VPS_OS_ROOT}/.env"
STAGING_DIR="${VPS_OS_ROOT}/data/hermes-staging"
STATUS_FILE="${VPS_OS_ROOT}/data/onboarding-apply-status.json"
TRIGGER_FILE="${VPS_OS_ROOT}/data/onboarding-apply.trigger"

log() {
  printf '[vps-os-onboarding-apply] %s\n' "$1"
}

is_allowed_key() {
  case "$1" in
    VPS_OS_DOMAIN|VPS_OS_SITE_ADDRESS|VPS_OS_ACME_EMAIL|VPS_OS_PUBLIC_IP|LLM_PROVIDER|LLM_MODEL|LLM_API_KEY|LLM_BASE_URL|TELEGRAM_BOT_TOKEN|DISCORD_BOT_TOKEN)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

upsert_env_key() {
  local env_file="$1"
  local key="$2"
  local val="$3"
  local tmp_file
  tmp_file="$(mktemp)"

  if [[ -f "${env_file}" ]]; then
    awk -v target_key="${key}" -v target_val="${val}" '
      BEGIN { updated = 0 }
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
  else
    printf '%s=%s\n' "${key}" "${val}" > "${tmp_file}"
  fi

  chmod 600 "${tmp_file}"
  mv "${tmp_file}" "${env_file}"
}

merge_onboarding_env() {
  if [[ ! -f "${ONBOARDING_ENV}" ]]; then
    return 1
  fi

  local changed=1
  local line key val
  while IFS= read -r line || [[ -n "${line}" ]]; do
    line="${line%$'\r'}"
    [[ -z "${line}" || "${line}" == \#* ]] && continue
    [[ "${line}" != *"="* ]] && continue
    key="${line%%=*}"
    val="${line#*=}"

    if ! is_allowed_key "${key}"; then
      continue
    fi
    if [[ "${val}" == *$'\n'* || "${val}" == *$'\r'* ]]; then
      log "Skipping key ${key} due to disallowed control characters."
      continue
    fi
    upsert_env_key "${MAIN_ENV}" "${key}" "${val}"
    changed=0
  done < "${ONBOARDING_ENV}"

  chmod 600 "${MAIN_ENV}"
  return "${changed}"
}

sync_staged_hermes() {
  if [[ ! -d "${STAGING_DIR}" ]]; then
    return 0
  fi

  mkdir -p "${HERMES_HOME}/memories"
  if [[ -f "${STAGING_DIR}/memories/USER.md" ]]; then
    local user_chars
    user_chars="$(wc -m < "${STAGING_DIR}/memories/USER.md" | tr -d '[:space:]')"
    if [[ "${user_chars}" -le 1375 ]]; then
      cp "${STAGING_DIR}/memories/USER.md" "${HERMES_HOME}/memories/USER.md"
    fi
  fi

  if [[ -f "${STAGING_DIR}/memories/MEMORY.md" ]]; then
    local mem_chars
    mem_chars="$(wc -m < "${STAGING_DIR}/memories/MEMORY.md" | tr -d '[:space:]')"
    if [[ "${mem_chars}" -le 2200 ]]; then
      cp "${STAGING_DIR}/memories/MEMORY.md" "${HERMES_HOME}/memories/MEMORY.md"
    fi
  fi

  if [[ -f "${STAGING_DIR}/config-overrides.json" ]] && [[ -f "${HERMES_HOME}/config.yaml" ]]; then
    local approval_mode provider_val model_val
    approval_mode="$(sed -n 's/.*"approvalMode":[[:space:]]*"\([a-z]*\)".*/\1/p' "${STAGING_DIR}/config-overrides.json" | head -n 1 || true)"
    provider_val="$(sed -n 's/.*"provider":[[:space:]]*"\([a-z0-9_-]*\)".*/\1/p' "${STAGING_DIR}/config-overrides.json" | head -n 1 || true)"
    model_val="$(sed -n 's/.*"model":[[:space:]]*"\([^"]*\)".*/\1/p' "${STAGING_DIR}/config-overrides.json" | head -n 1 || true)"

    if [[ "${approval_mode}" == "manual" || "${approval_mode}" == "smart" ]] || [[ -n "${provider_val}" ]] || [[ -n "${model_val}" ]]; then
      local tmp_cfg
      tmp_cfg="$(mktemp)"
      awk -v prov="${provider_val}" -v mod="${model_val}" -v app="${approval_mode}" '
        /^[A-Za-z0-9_]+:[[:space:]]*$/ {
          section = $1
          sub(/:.*/, "", section)
          print
          next
        }
        section == "model" && prov != "" && $0 ~ /^[[:space:]]+provider:[[:space:]]*/ {
          print "  provider: \"" prov "\""
          next
        }
        section == "model" && mod != "" && $0 ~ /^[[:space:]]+name:[[:space:]]*/ {
          print "  name: \"" mod "\""
          next
        }
        section == "approvals" && app != "" && $0 ~ /^[[:space:]]+mode:[[:space:]]*/ {
          print "  mode: " app
          next
        }
        { print }
      ' "${HERMES_HOME}/config.yaml" > "${tmp_cfg}"
      chmod 600 "${tmp_cfg}"
      mv "${tmp_cfg}" "${HERMES_HOME}/config.yaml"
    fi
  fi
}

read_env_value() {
  local key="$1"
  local file="$2"
  if [[ ! -f "${file}" ]]; then
    return 0
  fi
  awk -v k="${key}" '
    index($0, k "=") == 1 {
      print substr($0, length(k) + 2)
      exit
    }
  ' "${file}"
}

main() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "Error: apply-onboarding.sh must run as root." >&2
    exit 1
  fi

  local caddy_reloaded="false"
  local hermes_restarted="false"
  local hermes_active="false"

  merge_onboarding_env || true
  sync_staged_hermes

  if [[ -f "${VPS_OS_ROOT}/docker-compose.yml" && -f "${MAIN_ENV}" ]] && command -v docker >/dev/null 2>&1; then
    if docker compose -f "${VPS_OS_ROOT}/docker-compose.yml" --env-file "${MAIN_ENV}" up -d caddy agent >/dev/null 2>&1; then
      caddy_reloaded="true"
      log "Updated caddy and agent containers with new onboarding config."
    fi
  fi

  if systemctl list-unit-files vps-os-hermes-cto.service >/dev/null 2>&1; then
    local llm_key llm_provider
    llm_key="$(read_env_value "LLM_API_KEY" "${MAIN_ENV}")"
    llm_provider="$(read_env_value "LLM_PROVIDER" "${MAIN_ENV}")"
    if [[ "${llm_provider}" == "ollama" ]] || { [[ -n "${llm_key}" ]] && [[ "${llm_key}" != replace-with-* ]]; }; then
      if systemctl restart vps-os-hermes-cto.service >/dev/null 2>&1; then
        hermes_restarted="true"
      fi
      if systemctl is-active --quiet vps-os-hermes-cto.service; then
        hermes_active="true"
      fi
    fi
  fi

  local now_iso
  now_iso="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  cat > "${STATUS_FILE}" <<EOF
{
  "appliedAt": "${now_iso}",
  "caddyReloaded": ${caddy_reloaded},
  "hermesRestarted": ${hermes_restarted},
  "hermesActive": ${hermes_active}
}
EOF
  chown 1000:1000 "${STATUS_FILE}" || true
  chmod 644 "${STATUS_FILE}"
  rm -f "${TRIGGER_FILE}" || true
}

main "$@"
