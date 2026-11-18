#!/usr/bin/env python3
"""
VPS OS Host Runtime Bridge (`vps-os-runtime`).

Runs on the Ubuntu host as a privileged systemd daemon listening exclusively on a
permission-scoped Unix domain socket (/vps-os/run/runtime.sock) mounted into the
core control containers — never exposing /var/run/docker.sock to any container.

Exposes a strict, schema-validated allowlist of operations:
  - GET  /health
  - POST /v1/apps/lifecycle    (start | stop | restart | status)
  - POST /v1/apps/logs         (tail bounded & secret-redacted logs)
  - POST /v1/apps/route-caddy  (attach network, write scoped .caddy, validate & reload)
  - POST /v1/apps/remove       (compose down, remove route, optional folder cleanup)
  - POST /v1/apps/statuses     (batch live Compose status lookup)
"""

from __future__ import annotations

import argparse
from concurrent.futures import ALL_COMPLETED, ThreadPoolExecutor, wait as wait_futures
from contextlib import contextmanager
import hmac
import ipaddress
import json
import os
import re
import shutil
import signal
import socket
import socketserver
import stat
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler
from typing import Any, Iterator

MAX_BODY_BYTES = 64 * 1024
MAX_COMPOSE_BYTES = 512 * 1024
MAX_ENV_BYTES = 64 * 1024
MAX_LOG_LINE_CHARS = 2000
MAX_TAIL_LINES = 500
MAX_STATUS_SLUGS = 100
DEFAULT_STATUS_DEADLINE_S = 25.0

SLUG_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,46}[a-z0-9]$")
DOMAIN_PATTERN = re.compile(
    r"^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$"
)
CONTAINER_NAME_PATTERN = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$")
SERVICE_NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,47}$")
IMAGE_REF_PATTERN = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{1,200}$")
ENV_KEY_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
RELATIVE_MOUNT_PATTERN = re.compile(
    r"^\./(?:data|workspace)(?:/[A-Za-z0-9._-]+)*:/[A-Za-z0-9._/-]+(?::(?:ro|rw))?$"
)
INTERPOLATION_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}")

RESERVED_SLUGS = frozenset(
    {"core", "vps-os", "caddy", "dashboard", "agent", "system", "root", "admin"}
)

ALLOWED_LIFECYCLE_ACTIONS = frozenset({"start", "stop", "restart", "status"})

ALLOWED_TOP_LEVEL_COMPOSE_KEYS = frozenset({"services", "networks"})
ALLOWED_SERVICE_KEYS = frozenset(
    {
        "image",
        "container_name",
        "restart",
        "working_dir",
        "command",
        "init",
        "env_file",
        "environment",
        "volumes",
        "cpus",
        "mem_limit",
        "cap_drop",
        "security_opt",
        "networks",
        "healthcheck",
    }
)
ALLOWED_HEALTHCHECK_KEYS = frozenset(
    {"test", "interval", "timeout", "retries", "start_period"}
)

DISALLOWED_ENV_PREFIXES = ("VPS_OS_", "DOCKER_", "LD_")
DISALLOWED_ENV_EXACT = frozenset({"PATH", "HOME", "HOSTALIASES", "IFS", "ENV", "BASH_ENV"})

PEM_KEY_RE = re.compile(
    r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----"
)
AUTH_HEADER_RE = re.compile(
    r"\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}", re.IGNORECASE
)
JSON_SECRET_RE = re.compile(
    r'"([A-Za-z0-9_]*(?:key|token|secret|password|passwd|pass|credential|auth)[A-Za-z0-9_]*)"\s*:\s*"([^"]*)"',
    re.IGNORECASE,
)
ENV_OR_YAML_SECRET_RE = re.compile(
    r'\b([A-Za-z0-9_]*(?:key|token|secret|password|passwd|pass|credential|auth)[A-Za-z0-9_]*)\s*([:=])\s*("[^"]*"|\'[^\']*\'|[^\s,;]+)',
    re.IGNORECASE,
)
KNOWN_TOKEN_RE = re.compile(
    r"\b(sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|\d{6,12}:AA[A-Za-z0-9_-]{25,})\b"
)


class BridgeRequestError(Exception):
    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(redact_secrets(message))
        self.status_code = status_code


def redact_secrets(text: str) -> str:
    if not text:
        return ""
    result = PEM_KEY_RE.sub("[REDACTED_PRIVATE_KEY]", text)
    result = AUTH_HEADER_RE.sub(r"\1 [REDACTED]", result)
    result = JSON_SECRET_RE.sub(r'"\1":"[REDACTED]"', result)
    result = ENV_OR_YAML_SECRET_RE.sub(
        lambda m: f"{m.group(1)}{m.group(2)}{' ' if m.group(2) == ':' else ''}[REDACTED]",
        result,
    )
    return KNOWN_TOKEN_RE.sub("[REDACTED]", result)


def validate_slug(raw: Any) -> str:
    if not isinstance(raw, str):
        raise BridgeRequestError(400, "Field 'slug' must be a string.")
    if not SLUG_PATTERN.match(raw):
        raise BridgeRequestError(
            400,
            f'Invalid app slug "{raw}": must be 2-48 lowercase alphanumeric characters or hyphens.',
        )
    if raw in RESERVED_SLUGS:
        raise BridgeRequestError(400, f'Reserved app slug "{raw}" cannot be used.')
    return raw


def validate_domain(raw: Any) -> str:
    if not isinstance(raw, str):
        raise BridgeRequestError(400, "Field 'domain' must be a string or null.")
    normalized = raw.strip().lower()
    if not DOMAIN_PATTERN.match(normalized):
        raise BridgeRequestError(400, f'Invalid domain name "{raw}".')
    try:
        ipaddress.ip_address(normalized)
        raise BridgeRequestError(400, "IP addresses cannot be used as domain names.")
    except ValueError:
        pass
    return normalized


def validate_port(raw: Any) -> int:
    if not isinstance(raw, int) or isinstance(raw, bool) or raw < 1 or raw > 65535:
        raise BridgeRequestError(
            400, "Field 'internalPort' must be an integer between 1 and 65535."
        )
    return raw


def validate_tail(raw: Any) -> int:
    if raw is None:
        return 100
    if not isinstance(raw, int) or isinstance(raw, bool) or raw < 1 or raw > MAX_TAIL_LINES:
        raise BridgeRequestError(
            400, f"Field 'tail' must be an integer between 1 and {MAX_TAIL_LINES}."
        )
    return raw


def _sanitized_subprocess_env() -> dict[str, str]:
    """Never inherit core secrets from systemd EnvironmentFile into Docker Compose."""
    allowlist = ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG", "TMPDIR", "LANG", "LC_ALL"]
    if sys.platform == "win32":
        allowlist.extend(["SYSTEMROOT", "PATHEXT", "COMSPEC", "TEMP", "TMP"])
    return {k: os.environ[k] for k in allowlist if k in os.environ}


def _read_regular_file_nofollow(path: str, max_bytes: int, label: str) -> str:
    if not os.path.lexists(path):
        raise BridgeRequestError(404, f"{label} does not exist.")
    if os.path.islink(path):
        raise BridgeRequestError(400, f"Security boundary violation: {label} cannot be a symlink.")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        raise BridgeRequestError(400, f"Could not safely open {label}: {exc}") from exc
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise BridgeRequestError(400, f"Security boundary violation: {label} must be a regular file.")
        if st.st_size > max_bytes:
            raise BridgeRequestError(400, f"{label} exceeds maximum allowed size.")
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise BridgeRequestError(400, f"{label} exceeds maximum allowed size.")
            chunks.append(chunk)
        return b"".join(chunks).decode("utf-8")
    except UnicodeDecodeError as exc:
        raise BridgeRequestError(400, f"{label} must be valid UTF-8 text.") from exc
    finally:
        os.close(fd)


def _strip_yaml_comment(line: str) -> str:
    in_single = False
    in_double = False
    escaped = False
    for idx, ch in enumerate(line):
        if escaped:
            escaped = False
            continue
        if ch == "\\" and in_double:
            escaped = True
            continue
        if ch == "'" and not in_double:
            in_single = not in_single
        elif ch == '"' and not in_single:
            in_double = not in_double
        elif ch == "#" and not in_single and not in_double:
            if idx == 0 or line[idx - 1].isspace():
                return line[:idx]
    return line


def _split_inline_yaml_list(inner: str) -> list[str]:
    items: list[str] = []
    buf: list[str] = []
    in_single = False
    in_double = False
    escaped = False
    for ch in inner:
        if escaped:
            buf.append(ch)
            escaped = False
            continue
        if ch == "\\" and in_double:
            buf.append(ch)
            escaped = True
            continue
        if ch == "'" and not in_double:
            in_single = not in_single
            buf.append(ch)
            continue
        if ch == '"' and not in_single:
            in_double = not in_double
            buf.append(ch)
            continue
        if ch == "," and not in_single and not in_double:
            items.append("".join(buf))
            buf.clear()
            continue
        buf.append(ch)
    if buf or items:
        items.append("".join(buf))
    return items


def _parse_yaml_scalar(raw: str) -> Any:
    val = raw.strip()
    if val == "":
        return None
    if val in ("true", "True", "TRUE"):
        return True
    if val in ("false", "False", "FALSE"):
        return False
    if val in ("null", "Null", "~"):
        return None
    if val.startswith("[") and val.endswith("]"):
        try:
            parsed = json.loads(val)
            if isinstance(parsed, list):
                return parsed
        except json.JSONDecodeError:
            pass
        inner = val[1:-1].strip()
        if not inner:
            return []
        return [_parse_yaml_scalar(part) for part in _split_inline_yaml_list(inner)]
    if (val.startswith('"') and val.endswith('"')) or (
        val.startswith("'") and val.endswith("'")
    ):
        if len(val) >= 2:
            if val.startswith('"'):
                try:
                    return json.loads(val)
                except json.JSONDecodeError:
                    return val[1:-1]
            return val[1:-1]
    if re.fullmatch(r"-?\d+", val):
        return int(val)
    if re.fullmatch(r"-?\d+\.\d+", val):
        return float(val)
    if val.startswith(("&", "*", "!")):
        raise BridgeRequestError(400, "YAML anchors, aliases, and custom tags are forbidden.")
    return val


def _split_yaml_mapping(text: str) -> tuple[str, str] | None:
    in_single = False
    in_double = False
    escaped = False
    for idx, ch in enumerate(text):
        if escaped:
            escaped = False
            continue
        if ch == "\\" and in_double:
            escaped = True
            continue
        if ch == "'" and not in_double:
            in_single = not in_single
        elif ch == '"' and not in_single:
            in_double = not in_double
        elif ch == ":" and not in_single and not in_double:
            if idx + 1 == len(text) or text[idx + 1].isspace():
                return text[:idx].strip().strip("'\""), text[idx + 1 :].strip()
    return None


def parse_simple_yaml(content: str) -> dict[str, Any]:
    """
    Indentation-aware strict YAML subset parser for Locked Apartment Compose files.
    Rejects anchors, aliases, tags, multi-document streams, and tabs in indentation.
    """
    tokens: list[tuple[int, str]] = []
    for lineno, raw_line in enumerate(content.splitlines(), start=1):
        stripped_comment = _strip_yaml_comment(raw_line).rstrip()
        if not stripped_comment.strip():
            continue
        if stripped_comment.strip() in ("---", "..."):
            raise BridgeRequestError(400, "Multi-document YAML streams are forbidden.")
        leading = len(stripped_comment) - len(stripped_comment.lstrip(" "))
        if "\t" in stripped_comment[:leading] or stripped_comment.startswith("\t"):
            raise BridgeRequestError(400, f"Tabs are not permitted in YAML indentation (line {lineno}).")
        tokens.append((leading, stripped_comment[leading:]))

    if not tokens:
        raise BridgeRequestError(400, "docker-compose.yml cannot be empty.")

    def parse_block(index: int, expected_indent: int) -> tuple[Any, int]:
        if index >= len(tokens):
            return {}, index
        indent, text = tokens[index]
        if indent < expected_indent:
            return None, index

        if text.startswith("- ") or text == "-":
            items: list[Any] = []
            list_indent = indent
            while index < len(tokens):
                cur_indent, cur_text = tokens[index]
                if cur_indent != list_indent or not (
                    cur_text.startswith("- ") or cur_text == "-"
                ):
                    break
                after_dash = cur_text[1:].strip()
                index += 1
                if not after_dash:
                    nested, index = parse_block(index, list_indent + 1)
                    items.append(nested)
                    continue
                kv = _split_yaml_mapping(after_dash)
                if kv is not None:
                    key, val_part = kv
                    item_dict: dict[str, Any] = {}
                    if val_part == "":
                        nested, index = parse_block(index, list_indent + 2)
                        item_dict[key] = nested if nested is not None else {}
                    else:
                        item_dict[key] = _parse_yaml_scalar(val_part)
                    # Consume sibling keys belonging to this list item dict
                    if index < len(tokens) and tokens[index][0] > list_indent:
                        more, index = parse_block(index, tokens[index][0])
                        if isinstance(more, dict):
                            item_dict.update(more)
                        else:
                            raise BridgeRequestError(400, "Invalid list item mapping in Compose file.")
                    items.append(item_dict)
                else:
                    items.append(_parse_yaml_scalar(after_dash))
            return items, index

        mapping: dict[str, Any] = {}
        map_indent = indent
        while index < len(tokens):
            cur_indent, cur_text = tokens[index]
            if cur_indent < map_indent:
                break
            if cur_indent > map_indent or cur_text.startswith("- ") or cur_text == "-":
                raise BridgeRequestError(400, f"Invalid YAML structure near '{cur_text}'.")
            kv = _split_yaml_mapping(cur_text)
            if kv is None:
                raise BridgeRequestError(400, f"Expected key: value mapping near '{cur_text}'.")
            key, val_part = kv
            if not key:
                raise BridgeRequestError(400, "Empty YAML key is not allowed.")
            index += 1
            if val_part == "":
                if index < len(tokens) and tokens[index][0] > map_indent:
                    nested, index = parse_block(index, tokens[index][0])
                    mapping[key] = nested
                else:
                    mapping[key] = {}
            else:
                mapping[key] = _parse_yaml_scalar(val_part)
        return mapping, index

    parsed, next_idx = parse_block(0, tokens[0][0])
    if next_idx != len(tokens) or not isinstance(parsed, dict):
        raise BridgeRequestError(400, "docker-compose.yml root must be a YAML mapping.")
    return parsed


def parse_and_validate_env_file(env_text: str, slug: str) -> dict[str, str]:
    env_map: dict[str, str] = {}
    for lineno, raw_line in enumerate(env_text.splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise BridgeRequestError(400, f"Invalid .env syntax at line {lineno}.")
        key, val = line.split("=", 1)
        key = key.strip()
        val = val.strip()
        if not ENV_KEY_PATTERN.match(key):
            raise BridgeRequestError(400, f'Invalid .env key "{key}" at line {lineno}.')
        if key in DISALLOWED_ENV_EXACT or key.startswith(DISALLOWED_ENV_PREFIXES):
            raise BridgeRequestError(400, f'Forbidden environment variable "{key}" in app .env.')
        if "\x00" in val or "\n" in val or "\r" in val:
            raise BridgeRequestError(400, f'Invalid control character in .env value for "{key}".')
        if (val.startswith('"') and val.endswith('"')) or (
            val.startswith("'") and val.endswith("'")
        ):
            if len(val) >= 2:
                val = val[1:-1]
        env_map[key] = val

    if "APP_SLUG" in env_map and env_map["APP_SLUG"] != slug:
        raise BridgeRequestError(
            400, f'App .env APP_SLUG="{env_map["APP_SLUG"]}" does not match slug "{slug}".'
        )
    if "APP_PORT" in env_map and env_map["APP_PORT"]:
        try:
            validate_port(int(env_map["APP_PORT"]))
        except ValueError as exc:
            raise BridgeRequestError(400, "Invalid APP_PORT in app .env.") from exc
    if "APP_IMAGE" in env_map and env_map["APP_IMAGE"]:
        if "$" in env_map["APP_IMAGE"] or not IMAGE_REF_PATTERN.match(env_map["APP_IMAGE"]):
            raise BridgeRequestError(400, "Invalid APP_IMAGE in app .env.")
    return env_map


def _resolve_allowed_vars(
    value: str, env_map: dict[str, str], allowed_vars: set[str], field: str
) -> str:
    if "$" not in value:
        return value

    def _sub(match: re.Match[str]) -> str:
        var_name = match.group(1)
        default_val = match.group(2)
        if var_name not in allowed_vars:
            raise BridgeRequestError(
                400, f'Disallowed variable "${{{var_name}}}" in Compose {field}.'
            )
        if var_name in env_map and env_map[var_name] != "":
            return env_map[var_name]
        if default_val is not None:
            return default_val
        raise BridgeRequestError(
            400, f'Missing variable "{var_name}" referenced in Compose {field}.'
        )

    replaced = INTERPOLATION_RE.sub(_sub, value)
    if "$" in replaced:
        raise BridgeRequestError(
            400, f"Unsupported variable expansion syntax in Compose {field}."
        )
    return replaced


def validate_and_render_compose(
    compose_text: str,
    slug: str,
    app_dir: str,
    env_map: dict[str, str],
    env_file_override: str | None,
) -> dict[str, Any]:
    """
    Structurally validates every section of an app's docker-compose.yml against
    Locked Apartment boundaries and returns a self-contained JSON-serializable
    Compose structure with canonical host paths inside `app_dir`.
    """
    doc = parse_simple_yaml(compose_text)
    unknown_top = set(doc.keys()) - ALLOWED_TOP_LEVEL_COMPOSE_KEYS
    if unknown_top:
        raise BridgeRequestError(
            400, f"Unsupported top-level Compose keys: {', '.join(sorted(unknown_top))}."
        )

    networks = doc.get("networks")
    if not isinstance(networks, dict) or set(networks.keys()) != {"app_net"}:
        raise BridgeRequestError(
            400, 'Compose networks must define only isolated bridge network "app_net".'
        )
    app_net_cfg = networks["app_net"]
    if app_net_cfg is not None:
        if not isinstance(app_net_cfg, dict):
            raise BridgeRequestError(400, "Invalid app_net configuration.")
        if set(app_net_cfg.keys()) - {"driver"}:
            raise BridgeRequestError(400, "app_net may only specify driver: bridge.")
        if app_net_cfg.get("driver", "bridge") != "bridge":
            raise BridgeRequestError(400, "app_net must use driver: bridge.")

    services = doc.get("services")
    if not isinstance(services, dict) or not (1 <= len(services) <= 4):
        raise BridgeRequestError(400, "Compose services must contain 1-4 service definitions.")

    vars_ctx = {"APP_SLUG": slug, **env_map}
    rendered_services: dict[str, Any] = {}

    for svc_name, svc_cfg in services.items():
        if not SERVICE_NAME_PATTERN.match(str(svc_name)) or not isinstance(svc_cfg, dict):
            raise BridgeRequestError(400, f'Invalid Compose service definition "{svc_name}".')
        forbidden_keys = set(svc_cfg.keys()) - ALLOWED_SERVICE_KEYS
        if forbidden_keys:
            raise BridgeRequestError(
                400,
                f'Compose isolation policy rejected "{slug}": forbidden keys ({", ".join(sorted(forbidden_keys))}).',
            )

        out_svc: dict[str, Any] = dict(svc_cfg)

        raw_image = svc_cfg.get("image")
        if not isinstance(raw_image, str):
            raise BridgeRequestError(400, f'Service "{svc_name}" must specify an image.')
        resolved_image = _resolve_allowed_vars(
            raw_image, vars_ctx, {"APP_IMAGE"}, f"{svc_name}.image"
        )
        if not IMAGE_REF_PATTERN.match(resolved_image):
            raise BridgeRequestError(400, f'Invalid Docker image reference "{resolved_image}".')
        out_svc["image"] = resolved_image

        if "container_name" in svc_cfg:
            raw_cname = svc_cfg["container_name"]
            if not isinstance(raw_cname, str):
                raise BridgeRequestError(400, "container_name must be a string.")
            resolved_cname = _resolve_allowed_vars(
                raw_cname, vars_ctx, {"APP_SLUG"}, f"{svc_name}.container_name"
            )
            expected_prefix = f"vps-os-app-{slug}"
            if resolved_cname != expected_prefix and not resolved_cname.startswith(
                f"{expected_prefix}-"
            ):
                raise BridgeRequestError(
                    400,
                    f'container_name "{resolved_cname}" must be scoped to "{expected_prefix}".',
                )
            out_svc["container_name"] = resolved_cname

        cap_drop = svc_cfg.get("cap_drop")
        if not isinstance(cap_drop, list) or "ALL" not in [str(c).upper() for c in cap_drop]:
            raise BridgeRequestError(
                400, f'Compose isolation policy rejected "{slug}": cap_drop must include ALL.'
            )

        sec_opt = svc_cfg.get("security_opt")
        if not isinstance(sec_opt, list):
            raise BridgeRequestError(
                400,
                f'Compose isolation policy rejected "{slug}": security_opt must include no-new-privileges:true.',
            )
        sec_strings = [str(s) for s in sec_opt]
        if "no-new-privileges:true" not in sec_strings or any(
            "unconfined" in s.lower() for s in sec_strings
        ):
            raise BridgeRequestError(
                400,
                f'Compose isolation policy rejected "{slug}": insecure security_opt.',
            )

        svc_nets = svc_cfg.get("networks")
        if svc_nets != ["app_net"] and (
            not isinstance(svc_nets, dict) or set(svc_nets.keys()) != {"app_net"}
        ):
            raise BridgeRequestError(
                400, f'Service "{svc_name}" may only connect to isolated network app_net.'
            )

        if "env_file" in svc_cfg:
            env_files = svc_cfg["env_file"]
            if not isinstance(env_files, list):
                raise BridgeRequestError(400, "env_file must be a list.")
            rewritten_env_files: list[Any] = []
            for entry in env_files:
                if isinstance(entry, str):
                    if entry != ".env":
                        raise BridgeRequestError(400, "env_file may only reference '.env'.")
                    if env_file_override:
                        rewritten_env_files.append({"path": env_file_override, "required": True})
                    else:
                        rewritten_env_files.append({"path": ".env", "required": False})
                elif isinstance(entry, dict):
                    if set(entry.keys()) - {"path", "required"} or entry.get("path") != ".env":
                        raise BridgeRequestError(400, "env_file entries may only reference path '.env'.")
                    req_flag = entry.get("required", True)
                    if not isinstance(req_flag, bool):
                        raise BridgeRequestError(400, "env_file.required must be a boolean.")
                    if env_file_override:
                        rewritten_env_files.append(
                            {"path": env_file_override, "required": req_flag}
                        )
                    else:
                        rewritten_env_files.append({"path": ".env", "required": False})
                else:
                    raise BridgeRequestError(400, "Invalid env_file entry.")
            out_svc["env_file"] = rewritten_env_files

        if "environment" in svc_cfg:
            env_section = svc_cfg["environment"]
            if isinstance(env_section, dict):
                for ek in env_section:
                    if str(ek) in DISALLOWED_ENV_EXACT or str(ek).startswith(
                        DISALLOWED_ENV_PREFIXES
                    ):
                        raise BridgeRequestError(400, f'Forbidden Compose environment key "{ek}".')
            elif isinstance(env_section, list):
                for item in env_section:
                    k = str(item).split("=", 1)[0].strip()
                    if k in DISALLOWED_ENV_EXACT or k.startswith(DISALLOWED_ENV_PREFIXES):
                        raise BridgeRequestError(400, f'Forbidden Compose environment key "{k}".')
            else:
                raise BridgeRequestError(400, "environment must be a mapping or list.")

        if "volumes" in svc_cfg:
            vols = svc_cfg["volumes"]
            if not isinstance(vols, list):
                raise BridgeRequestError(400, "volumes must be a list.")
            rewritten_vols: list[str] = []
            for vol in vols:
                if not isinstance(vol, str) or "$" in vol or ".." in vol:
                    raise BridgeRequestError(
                        400, f'Compose isolation policy rejected "{slug}": unsafe volume mount.'
                    )
                if not RELATIVE_MOUNT_PATTERN.match(vol):
                    raise BridgeRequestError(
                        400,
                        f'Compose isolation policy rejected "{slug}": volume "{vol}" escapes ./data or ./workspace.',
                    )
                rel_src, rest = vol.split(":", 1)
                abs_src = _validate_no_symlink_volume_source(app_dir, rel_src[2:], slug)
                rewritten_vols.append(f"{abs_src}:{rest}")
            out_svc["volumes"] = rewritten_vols

        if "healthcheck" in svc_cfg:
            hc = svc_cfg["healthcheck"]
            if not isinstance(hc, dict) or (set(hc.keys()) - ALLOWED_HEALTHCHECK_KEYS):
                raise BridgeRequestError(400, "Invalid healthcheck configuration.")
            if isinstance(hc.get("test"), str):
                hc_copy = dict(hc)
                hc_copy["test"] = _resolve_allowed_vars(
                    hc["test"], vars_ctx, {"APP_PORT", "APP_SLUG"}, f"{svc_name}.healthcheck.test"
                )
                out_svc["healthcheck"] = hc_copy
            elif isinstance(hc.get("test"), list):
                hc_copy = dict(hc)
                hc_copy["test"] = [
                    _resolve_allowed_vars(
                        str(part),
                        vars_ctx,
                        {"APP_PORT", "APP_SLUG"},
                        f"{svc_name}.healthcheck.test",
                    )
                    for part in hc["test"]
                ]
                out_svc["healthcheck"] = hc_copy

        rendered_services[str(svc_name)] = out_svc

    return {"services": rendered_services, "networks": {"app_net": {"driver": "bridge"}}}


def _validate_no_symlink_volume_source(app_dir: str, rel_path: str, slug: str) -> str:
    real_app_dir = os.path.realpath(app_dir)
    current = real_app_dir
    for part in rel_path.replace("\\", "/").split("/"):
        if not part or part == ".":
            continue
        current = os.path.join(current, part)
        if os.path.islink(current):
            raise BridgeRequestError(
                400,
                f'Security boundary violation: volume mount path "{rel_path}" for "{slug}" contains a symlink.',
            )
    real_target = os.path.realpath(current)
    if real_target != real_app_dir and not real_target.startswith(real_app_dir + os.sep):
        raise BridgeRequestError(
            400,
            f'Security boundary violation: volume mount path "{rel_path}" for "{slug}" escapes workspace.',
        )
    return current


def ensure_real_directory(dir_path: str, label: str) -> str:
    if not os.path.exists(dir_path):
        raise BridgeRequestError(500, f"{label} directory does not exist: {dir_path}")
    if os.path.islink(dir_path) or not os.path.isdir(dir_path):
        raise BridgeRequestError(
            400, f"Security boundary violation: {label} must be a real directory."
        )
    return os.path.realpath(dir_path)


def resolve_scoped_app_dir(apps_root: str, slug: str, *, require_exists: bool = True) -> str:
    safe_slug = validate_slug(slug)
    real_root = ensure_real_directory(apps_root, "appsRoot")
    candidate = os.path.join(real_root, safe_slug)
    if not os.path.lexists(candidate):
        if require_exists:
            raise BridgeRequestError(404, f'App workspace "{safe_slug}" does not exist.')
        return candidate
    if os.path.islink(candidate) or not os.path.isdir(candidate):
        raise BridgeRequestError(
            400, f'Security boundary violation: workspace "{safe_slug}" is not a real directory.'
        )
    real_candidate = os.path.realpath(candidate)
    if real_candidate != os.path.join(real_root, safe_slug):
        raise BridgeRequestError(
            400, f'Security boundary violation: workspace "{safe_slug}" escapes appsRoot.'
        )
    return real_candidate


def parse_compose_ps_output(raw_stdout: str) -> list[dict[str, Any]]:
    text = raw_stdout.strip()
    if not text:
        return []
    if text.startswith("["):
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                return [item for item in parsed if isinstance(item, dict)]
        except json.JSONDecodeError:
            return []
    items: list[dict[str, Any]] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        try:
            obj = json.loads(stripped)
            if isinstance(obj, dict):
                items.append(obj)
        except json.JSONDecodeError:
            continue
    return items


def derive_app_status(containers: list[dict[str, Any]]) -> str:
    if not containers:
        return "stopped"
    has_running = False
    for entry in containers:
        state = str(entry.get("State", "")).strip().lower()
        health = str(entry.get("Health", "")).strip().lower()
        exit_code = entry.get("ExitCode", 0)
        if state in ("restarting", "dead") or health == "unhealthy":
            return "error"
        if state == "exited" and isinstance(exit_code, int) and exit_code not in (0, 143):
            return "error"
        if state == "running":
            has_running = True
    return "running" if has_running else "stopped"


def _extract_domains_from_caddy_text(text: str) -> set[str]:
    domains: set[str] = set()
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.endswith("{"):
            host = line[:-1].strip().lower()
            if DOMAIN_PATTERN.match(host):
                domains.add(host)
    return domains


class _SlugLockEntry:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.refs = 0


class RuntimeService:
    def __init__(
        self,
        *,
        apps_root: str,
        caddy_apps_dir: str,
        caddy_container: str,
        docker_bin: str = "docker",
        runtime_token: str | None = None,
        allow_unauthenticated: bool = False,
        status_deadline_s: float = DEFAULT_STATUS_DEADLINE_S,
    ) -> None:
        if not CONTAINER_NAME_PATTERN.match(caddy_container):
            raise ValueError(f"Invalid caddy container name: {caddy_container}")
        if not docker_bin or any(ch.isspace() for ch in docker_bin):
            raise ValueError("Invalid docker binary path.")
        cleaned_token = (runtime_token or "").strip() or None
        if not cleaned_token and not allow_unauthenticated:
            raise ValueError(
                "RuntimeService requires runtime_token unless allow_unauthenticated=True."
            )
        self.apps_root = apps_root
        self.caddy_apps_dir = caddy_apps_dir
        self.caddy_container = caddy_container
        self.docker_bin = docker_bin
        self.runtime_token = cleaned_token
        self.allow_unauthenticated = allow_unauthenticated
        self.status_deadline_s = max(0.2, float(status_deadline_s))
        self._locks_guard = threading.Lock()
        self._slug_locks: dict[str, _SlugLockEntry] = {}
        self._caddy_lock = threading.Lock()

    @contextmanager
    def _lock_for(self, slug: str) -> Iterator[None]:
        with self._locks_guard:
            entry = self._slug_locks.get(slug)
            if entry is None:
                entry = _SlugLockEntry()
                self._slug_locks[slug] = entry
            entry.refs += 1
        try:
            entry.lock.acquire()
            try:
                yield
            finally:
                entry.lock.release()
        finally:
            with self._locks_guard:
                entry.refs -= 1
                if entry.refs == 0:
                    self._slug_locks.pop(slug, None)

    @contextmanager
    def _validated_compose_context(
        self, app_dir: str, slug: str
    ) -> Iterator[tuple[str, str | None]]:
        """
        Reads `.env` and `docker-compose.yml` with O_NOFOLLOW, structurally
        validates every field, and writes canonical validated copies into a
        root-owned 0700 temporary directory so UID 1000 cannot mutate files
        between validation and `docker compose` execution (TOCTOU immunity).
        """
        compose_path = os.path.join(app_dir, "docker-compose.yml")
        compose_text = _read_regular_file_nofollow(
            compose_path, MAX_COMPOSE_BYTES, f'docker-compose.yml for "{slug}"'
        )
        env_path = os.path.join(app_dir, ".env")
        env_text: str | None = None
        env_map: dict[str, str] = {}
        if os.path.lexists(env_path):
            env_text = _read_regular_file_nofollow(
                env_path, MAX_ENV_BYTES, f'.env for "{slug}"'
            )
            env_map = parse_and_validate_env_file(env_text, slug)

        tmp_dir = tempfile.mkdtemp(prefix=f"vps-os-{slug}-")
        os.chmod(tmp_dir, 0o700)
        try:
            tmp_env_path: str | None = None
            if env_text is not None:
                tmp_env_path = os.path.join(tmp_dir, ".env")
                with open(tmp_env_path, "w", encoding="utf-8") as fh:
                    fh.write(env_text)
                os.chmod(tmp_env_path, 0o600)

            rendered_doc = validate_and_render_compose(
                compose_text, slug, app_dir, env_map, tmp_env_path
            )
            tmp_compose_path = os.path.join(tmp_dir, "docker-compose.json")
            with open(tmp_compose_path, "w", encoding="utf-8") as fh:
                json.dump(rendered_doc, fh, indent=2)
            os.chmod(tmp_compose_path, 0o600)
            yield tmp_compose_path, tmp_env_path
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)

    def _compose_down_by_project(self, slug: str) -> None:
        with tempfile.TemporaryDirectory(prefix=f"vps-os-down-{slug}-") as empty_cwd:
            self._run_docker(
                ["compose", "-p", f"vps-os-{slug}", "down", "--remove-orphans"],
                timeout=60,
                check=True,
                cwd=empty_cwd,
            )

    def _run_docker(
        self,
        args: list[str],
        *,
        timeout: int = 120,
        check: bool = True,
        cwd: str | None = None,
    ) -> subprocess.CompletedProcess[str]:
        cmd = [self.docker_bin, *args]
        try:
            proc = subprocess.run(
                cmd,
                cwd=cwd,
                shell=False,
                env=_sanitized_subprocess_env(),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
            )
        except FileNotFoundError as exc:
            raise BridgeRequestError(
                503, f"Docker CLI binary not found ({self.docker_bin})."
            ) from exc
        except subprocess.TimeoutExpired as exc:
            raise BridgeRequestError(
                504, f"Docker command timed out after {timeout}s."
            ) from exc

        if check and proc.returncode != 0:
            detail = (proc.stderr or proc.stdout or f"exit code {proc.returncode}").strip()
            raise BridgeRequestError(502, redact_secrets(detail))
        return proc

    def _compose_cmd_base(
        self, slug: str, app_dir: str, compose_path: str, env_path: str | None
    ) -> list[str]:
        cmd = [
            "compose",
            "-p",
            f"vps-os-{slug}",
            "--project-directory",
            app_dir,
            "-f",
            compose_path,
        ]
        if env_path:
            cmd.extend(["--env-file", env_path])
        return cmd

    def _compose_status(
        self, slug: str, app_dir: str, compose_path: str, env_path: str | None
    ) -> str:
        proc = self._run_docker(
            [*self._compose_cmd_base(slug, app_dir, compose_path, env_path), "ps", "-a", "--format", "json"],
            timeout=20,
            check=False,
        )
        if proc.returncode != 0:
            return "error"
        return derive_app_status(parse_compose_ps_output(proc.stdout))

    def lifecycle(self, payload: dict[str, Any]) -> dict[str, Any]:
        slug = validate_slug(payload.get("slug"))
        action = payload.get("action")
        if not isinstance(action, str) or action not in ALLOWED_LIFECYCLE_ACTIONS:
            raise BridgeRequestError(
                400, "Field 'action' must be one of: start, stop, restart, status."
            )

        with self._lock_for(slug):
            app_dir = resolve_scoped_app_dir(self.apps_root, slug)
            with self._validated_compose_context(app_dir, slug) as (
                compose_path,
                env_path,
            ):
                base = self._compose_cmd_base(slug, app_dir, compose_path, env_path)
                if action == "start":
                    self._run_docker([*base, "up", "-d", "--remove-orphans"], timeout=180)
                elif action == "stop":
                    self._run_docker([*base, "stop"], timeout=60)
                elif action == "restart":
                    self._run_docker([*base, "restart"], timeout=90)

                status = self._compose_status(slug, app_dir, compose_path, env_path)
                return {
                    "slug": slug,
                    "status": status,
                    "detail": f"Workload {slug} {action} -> {status}",
                }

    def logs(self, payload: dict[str, Any]) -> dict[str, Any]:
        slug = validate_slug(payload.get("slug"))
        tail = validate_tail(payload.get("tail"))

        app_dir = resolve_scoped_app_dir(self.apps_root, slug)
        with self._validated_compose_context(app_dir, slug) as (
            compose_path,
            env_path,
        ):
            base = self._compose_cmd_base(slug, app_dir, compose_path, env_path)
            proc = self._run_docker(
                [*base, "logs", "--no-color", "--tail", str(tail)],
                timeout=20,
            )
            combined = "\n".join(
                part for part in (proc.stdout, proc.stderr) if part
            )
            # Redact the full blob before splitting lines so multi-line PEM keys
            # cannot evade regex matching across line boundaries.
            redacted_blob = redact_secrets(combined)
            raw_lines = [line[:MAX_LOG_LINE_CHARS] for line in redacted_blob.splitlines() if line]
            return {"slug": slug, "lines": raw_lines[-tail:]}

    def _validate_and_reload_caddy(self) -> None:
        self._run_docker(
            [
                "exec",
                self.caddy_container,
                "caddy",
                "validate",
                "--config",
                "/etc/caddy/Caddyfile",
            ],
            timeout=20,
        )
        self._run_docker(
            [
                "exec",
                self.caddy_container,
                "caddy",
                "reload",
                "--config",
                "/etc/caddy/Caddyfile",
            ],
            timeout=20,
        )

    def _resolve_caddy_route_path(self, slug: str) -> str:
        real_caddy_dir = ensure_real_directory(self.caddy_apps_dir, "caddyAppsDir")
        route_path = os.path.join(real_caddy_dir, f"{slug}.caddy")
        if os.path.islink(route_path):
            raise BridgeRequestError(
                400, f'Security boundary violation: Caddy route for "{slug}" cannot be a symlink.'
            )
        if os.path.lexists(route_path) and os.path.realpath(route_path) != os.path.join(
            real_caddy_dir, f"{slug}.caddy"
        ):
            raise BridgeRequestError(
                400, f'Security boundary violation: Caddy route for "{slug}" escapes directory.'
            )
        return route_path

    def _find_domain_owner(self, real_caddy_dir: str, domain: str, exclude_slug: str) -> str | None:
        for entry in os.listdir(real_caddy_dir):
            if not entry.endswith(".caddy"):
                continue
            other_slug = entry[:-6]
            if other_slug == exclude_slug:
                continue
            full_path = os.path.join(real_caddy_dir, entry)
            if os.path.islink(full_path) or not os.path.isfile(full_path):
                continue
            try:
                with open(full_path, "r", encoding="utf-8") as fh:
                    if domain in _extract_domains_from_caddy_text(fh.read()):
                        return other_slug
            except OSError:
                continue
        return None

    def route_caddy(self, payload: dict[str, Any]) -> dict[str, Any]:
        slug = validate_slug(payload.get("slug"))
        raw_domain = payload.get("domain")
        domain = None if raw_domain is None else validate_domain(raw_domain)
        internal_port = validate_port(payload.get("internalPort"))
        network_name = f"vps-os-{slug}_app_net"

        with self._lock_for(slug):
            with self._caddy_lock:
                route_path = self._resolve_caddy_route_path(slug)
                real_caddy_dir = os.path.dirname(route_path)
                previous_content: str | None = None
                if os.path.exists(route_path):
                    with open(route_path, "r", encoding="utf-8") as fh:
                        previous_content = fh.read()

                if domain is None:
                    if os.path.exists(route_path):
                        os.unlink(route_path)
                        try:
                            # Validate before reload guarantees restoration is safe on failure.
                            self._validate_and_reload_caddy()
                        except Exception:
                            if previous_content is not None:
                                with open(route_path, "w", encoding="utf-8") as fh:
                                    fh.write(previous_content)
                                os.chmod(route_path, 0o644)
                            raise
                    self._run_docker(
                        ["network", "disconnect", network_name, self.caddy_container],
                        timeout=15,
                        check=False,
                    )
                    return {"ok": True, "slug": slug, "domain": None, "routed": False}

                owner = self._find_domain_owner(real_caddy_dir, domain, slug)
                if owner is not None:
                    raise BridgeRequestError(
                        409,
                        f'Domain "{domain}" is already routed to app "{owner}".',
                    )

                inspect_proc = self._run_docker(
                    ["network", "inspect", network_name],
                    timeout=15,
                    check=False,
                )
                if inspect_proc.returncode != 0:
                    raise BridgeRequestError(
                        409,
                        f'App "{slug}" is not running yet (network "{network_name}" not found). Start the app before binding a public domain.',
                    )

                connected_here = False
                connect_proc = self._run_docker(
                    ["network", "connect", network_name, self.caddy_container],
                    timeout=15,
                    check=False,
                )
                if connect_proc.returncode == 0:
                    connected_here = True
                else:
                    err_text = (connect_proc.stderr or connect_proc.stdout or "").lower()
                    if "already exists" not in err_text and "already connected" not in err_text:
                        raise BridgeRequestError(
                            502,
                            redact_secrets(
                                (connect_proc.stderr or connect_proc.stdout or "Failed to attach Caddy network.").strip()
                            ),
                        )

                route_body = (
                    f"# Managed by VPS OS Runtime Bridge for app: {slug}\n"
                    f"{domain} {{\n"
                    f"\tencode zstd gzip\n"
                    f"\treverse_proxy vps-os-app-{slug}:{internal_port}\n"
                    f"}}\n"
                )

                try:
                    with open(route_path, "w", encoding="utf-8") as fh:
                        fh.write(route_body)
                    os.chmod(route_path, 0o644)
                    self._validate_and_reload_caddy()
                except Exception as exc:
                    if previous_content is not None:
                        with open(route_path, "w", encoding="utf-8") as fh:
                            fh.write(previous_content)
                        os.chmod(route_path, 0o644)
                    elif os.path.exists(route_path):
                        os.unlink(route_path)
                    if connected_here:
                        self._run_docker(
                            ["network", "disconnect", network_name, self.caddy_container],
                            timeout=15,
                            check=False,
                        )
                    if isinstance(exc, BridgeRequestError):
                        raise BridgeRequestError(
                            422, f"Caddy route validation failed: {exc}"
                        ) from exc
                    raise BridgeRequestError(
                        500, f"Failed writing Caddy route: {exc}"
                    ) from exc

                return {"ok": True, "slug": slug, "domain": domain, "routed": True}

    def remove_workload(self, payload: dict[str, Any]) -> dict[str, Any]:
        slug = validate_slug(payload.get("slug"))
        raw_remove = payload.get("removeFiles", False)
        if not isinstance(raw_remove, bool):
            raise BridgeRequestError(400, "Field 'removeFiles' must be a boolean.")
        remove_files = raw_remove
        network_name = f"vps-os-{slug}_app_net"

        with self._lock_for(slug):
            # 1. Tear down running containers BEFORE touching routes or workspace files.
            app_dir = resolve_scoped_app_dir(self.apps_root, slug, require_exists=False)
            compose_path = os.path.join(app_dir, "docker-compose.yml")
            if os.path.exists(app_dir) and os.path.lexists(compose_path):
                try:
                    with self._validated_compose_context(app_dir, slug) as (
                        validated_compose,
                        validated_env,
                    ):
                        self._run_docker(
                            [
                                *self._compose_cmd_base(
                                    slug, app_dir, validated_compose, validated_env
                                ),
                                "down",
                                "--remove-orphans",
                            ],
                            timeout=60,
                            check=True,
                        )
                except BridgeRequestError as exc:
                    if exc.status_code != 400:
                        raise
                    # If docker-compose.yml is corrupted or violates policy,
                    # tear down strictly by project label without reading it.
                    self._compose_down_by_project(slug)
            else:
                # Even if app_dir or docker-compose.yml was externally deleted,
                # tear down any orphaned containers still labeled for this slug.
                self._compose_down_by_project(slug)

            # 2. Detach Caddy network and remove route atomically.
            with self._caddy_lock:
                self._run_docker(
                    ["network", "disconnect", network_name, self.caddy_container],
                    timeout=15,
                    check=False,
                )
                route_path = self._resolve_caddy_route_path(slug)
                if os.path.exists(route_path):
                    with open(route_path, "r", encoding="utf-8") as fh:
                        previous_content = fh.read()
                    os.unlink(route_path)
                    try:
                        self._validate_and_reload_caddy()
                    except Exception:
                        with open(route_path, "w", encoding="utf-8") as fh:
                            fh.write(previous_content)
                        os.chmod(route_path, 0o644)
                        raise

            # 3. Only delete files once container teardown and route cleanup succeeded.
            if remove_files and os.path.exists(app_dir):
                shutil.rmtree(app_dir)

            return {"ok": True, "slug": slug}

    def _single_status(self, slug: str) -> tuple[str, str]:
        app_dir = resolve_scoped_app_dir(self.apps_root, slug, require_exists=False)
        compose_path = os.path.join(app_dir, "docker-compose.yml")
        if not os.path.exists(app_dir) or not os.path.lexists(compose_path):
            return slug, "stopped"
        try:
            with self._validated_compose_context(app_dir, slug) as (
                validated_compose,
                validated_env,
            ):
                return slug, self._compose_status(
                    slug, app_dir, validated_compose, validated_env
                )
        except BridgeRequestError:
            return slug, "error"

    def statuses(self, payload: dict[str, Any]) -> dict[str, Any]:
        raw_slugs = payload.get("slugs")
        if not isinstance(raw_slugs, list):
            raise BridgeRequestError(400, "Field 'slugs' must be an array.")
        if len(raw_slugs) > MAX_STATUS_SLUGS:
            raise BridgeRequestError(
                400, f"At most {MAX_STATUS_SLUGS} slugs may be queried at once."
            )

        validated_slugs = [validate_slug(item) for item in raw_slugs]
        if not validated_slugs:
            return {"statuses": {}}

        out: dict[str, str] = {}
        pool = ThreadPoolExecutor(max_workers=4)
        pending_or_timed_out = True
        try:
            futures = {pool.submit(self._single_status, s): s for s in validated_slugs}
            done, not_done = wait_futures(
                futures.keys(),
                timeout=self.status_deadline_s,
                return_when=ALL_COMPLETED,
            )
            if not_done:
                for fut in not_done:
                    fut.cancel()
                raise BridgeRequestError(504, "Status sync exceeded overall deadline.")
            for fut in done:
                resolved_slug, status = fut.result()
                out[resolved_slug] = status
            pending_or_timed_out = False
        finally:
            pool.shutdown(
                wait=not pending_or_timed_out,
                cancel_futures=pending_or_timed_out,
            )
        return {"statuses": out}


def make_handler(service: RuntimeService) -> type[BaseHTTPRequestHandler]:
    class RuntimeBridgeHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        timeout = 30

        def version_string(self) -> str:
            return "vps-os-runtime"

        def address_string(self) -> str:
            if isinstance(self.client_address, tuple) and self.client_address:
                return str(self.client_address[0])
            return "unix-socket"

        def log_message(self, format: str, *args: Any) -> None:
            message = redact_secrets(format % args)
            sys.stderr.write(f"[vps-os-runtime] {self.address_string()} {message}\n")

        def _send_json(self, status_code: int, body: dict[str, Any]) -> None:
            raw = json.dumps(body).encode("utf-8")
            self.send_response(status_code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(raw)

        def _require_auth(self) -> bool:
            expected = service.runtime_token
            if not expected:
                if service.allow_unauthenticated:
                    return True
                self._send_json(401, {"error": "Unauthorized."})
                return False
            provided = self.headers.get("X-VPS-OS-Runtime-Token", "").strip()
            if not provided:
                auth = self.headers.get("Authorization", "")
                if auth.startswith("Bearer "):
                    provided = auth[7:].strip()
            if not provided:
                self._send_json(401, {"error": "Unauthorized."})
                return False
            try:
                provided_bytes = provided.encode("utf-8")
                expected_bytes = expected.encode("utf-8")
            except UnicodeEncodeError:
                self._send_json(401, {"error": "Unauthorized."})
                return False
            if not hmac.compare_digest(provided_bytes, expected_bytes):
                self._send_json(401, {"error": "Unauthorized."})
                return False
            return True

        def _read_json_body(self) -> dict[str, Any]:
            raw_len = self.headers.get("Content-Length")
            if raw_len is None:
                raise BridgeRequestError(411, "Content-Length header is required.")
            try:
                length = int(raw_len)
            except ValueError as exc:
                raise BridgeRequestError(400, "Invalid Content-Length header.") from exc
            if length < 0 or length > MAX_BODY_BYTES:
                raise BridgeRequestError(413, "Payload too large.")
            raw_bytes = self.rfile.read(length) if length > 0 else b"{}"
            try:
                parsed = json.loads(raw_bytes.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise BridgeRequestError(400, "Invalid JSON payload.") from exc
            if not isinstance(parsed, dict):
                raise BridgeRequestError(400, "JSON body must be an object.")
            return parsed

        def do_GET(self) -> None:
            if self.path == "/health":
                self._send_json(200, {"ok": True, "service": "vps-os-runtime"})
                return
            self._send_json(404, {"error": "Not found."})

        def do_POST(self) -> None:
            if not self._require_auth():
                return
            try:
                payload = self._read_json_body()
                if self.path == "/v1/apps/lifecycle":
                    self._send_json(200, service.lifecycle(payload))
                elif self.path == "/v1/apps/logs":
                    self._send_json(200, service.logs(payload))
                elif self.path == "/v1/apps/route-caddy":
                    self._send_json(200, service.route_caddy(payload))
                elif self.path == "/v1/apps/remove":
                    self._send_json(200, service.remove_workload(payload))
                elif self.path == "/v1/apps/statuses":
                    self._send_json(200, service.statuses(payload))
                else:
                    self._send_json(404, {"error": "Not found."})
            except BridgeRequestError as exc:
                self._send_json(exc.status_code, {"error": str(exc)})
            except Exception as exc:  # pragma: no cover - defensive fallback
                self._send_json(500, {"error": redact_secrets(str(exc))})

    return RuntimeBridgeHandler


if hasattr(socketserver, "UnixStreamServer"):

    class ThreadingUnixHttpServer(
        socketserver.ThreadingMixIn, socketserver.UnixStreamServer
    ):
        daemon_threads = True
        request_queue_size = 32


class ThreadingTcpHttpServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True
    request_queue_size = 32


def prepare_unix_socket(socket_path: str) -> None:
    parent = os.path.dirname(os.path.abspath(socket_path))
    os.makedirs(parent, mode=0o750, exist_ok=True)
    os.chmod(parent, 0o750)
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        os.chown(parent, 0, 1000)
    if os.path.lexists(socket_path):
        st = os.lstat(socket_path)
        if not stat.S_ISSOCK(st.st_mode):
            raise RuntimeError(
                f"Refusing to overwrite non-socket file at {socket_path}"
            )
        os.unlink(socket_path)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="VPS OS Host Runtime Bridge")
    parser.add_argument(
        "--socket",
        default=os.environ.get("VPS_OS_RUNTIME_SOCKET", "/vps-os/run/runtime.sock"),
        help="Unix domain socket path to bind.",
    )
    parser.add_argument(
        "--tcp",
        default="",
        help="Optional loopback host:port (e.g. 127.0.0.1:0) for local testing.",
    )
    parser.add_argument(
        "--apps-root",
        default=os.environ.get("VPS_OS_APPS_ROOT", "/apps"),
    )
    parser.add_argument(
        "--caddy-apps-dir",
        default=os.environ.get("VPS_OS_CADDY_APPS_DIR", "/vps-os/caddy/apps.d"),
    )
    parser.add_argument(
        "--caddy-container",
        default=os.environ.get("VPS_OS_CADDY_CONTAINER", "vps-os-caddy"),
    )
    parser.add_argument(
        "--docker-bin",
        default=os.environ.get("VPS_OS_DOCKER_BIN", "docker"),
    )
    parser.add_argument(
        "--runtime-token",
        default=os.environ.get("VPS_OS_RUNTIME_TOKEN", ""),
    )
    parser.add_argument(
        "--allow-unauthenticated",
        action="store_true",
        help="Allow starting without VPS_OS_RUNTIME_TOKEN (tests only).",
    )
    parser.add_argument(
        "--status-deadline",
        type=float,
        default=float(os.environ.get("VPS_OS_STATUS_DEADLINE_S", DEFAULT_STATUS_DEADLINE_S)),
        help="Overall deadline in seconds for batch /v1/apps/statuses queries.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    token = (args.runtime_token or "").strip()
    if not args.allow_unauthenticated and (
        not token or token.startswith("replace-with-") or len(token) < 16
    ):
        sys.stderr.write(
            "Fatal: VPS_OS_RUNTIME_TOKEN must be a non-placeholder secret of at least 16 chars.\n"
        )
        return 1

    service = RuntimeService(
        apps_root=args.apps_root,
        caddy_apps_dir=args.caddy_apps_dir,
        caddy_container=args.caddy_container,
        docker_bin=args.docker_bin,
        runtime_token=token or None,
        allow_unauthenticated=bool(args.allow_unauthenticated),
        status_deadline_s=args.status_deadline,
    )
    handler_cls = make_handler(service)

    server: socketserver.BaseServer
    if args.tcp:
        host, _, raw_port = args.tcp.rpartition(":")
        if host not in ("127.0.0.1", "localhost", "::1"):
            sys.stderr.write("Fatal: --tcp may only bind to loopback addresses.\n")
            return 1
        port = int(raw_port)
        server = ThreadingTcpHttpServer((host, port), handler_cls)
        actual_host, actual_port = server.server_address[:2]
        sys.stdout.write(f"LISTENING http://{actual_host}:{actual_port}\n")
        sys.stdout.flush()
    else:
        if not hasattr(socketserver, "UnixStreamServer"):
            sys.stderr.write(
                "Fatal: UnixStreamServer is not supported on this platform; pass --tcp 127.0.0.1:0 for tests.\n"
            )
            return 1
        prepare_unix_socket(args.socket)
        old_umask = os.umask(0o117)
        try:
            server = ThreadingUnixHttpServer(args.socket, handler_cls)
        finally:
            os.umask(old_umask)
        os.chmod(args.socket, 0o660)
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            os.chown(args.socket, 0, 1000)
        sys.stdout.write(f"LISTENING unix://{args.socket}\n")
        sys.stdout.flush()

    def _shutdown(_signum: int, _frame: Any) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    try:
        server.serve_forever()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
