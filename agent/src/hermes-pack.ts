import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Hermes built-in curated memory file character bounds. */
export const HERMES_MEMORY_MAX_CHARS = 2200;
export const HERMES_USER_MAX_CHARS = 1375;

export const DEFAULT_HERMES_PACK_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../hermes",
);

export interface HermesConfigRenderOptions {
  mcpCommand?: string;
  mcpEntry?: string;
  registryDbPath?: string;
  appsRoot?: string;
  templatesRoot?: string;
}

export interface ProvisionHermesHomeOptions extends HermesConfigRenderOptions {
  hermesHome: string;
  packDir?: string;
  /** Overwrite user-owned memory files (`MEMORY.md`, `USER.md`) and `config.yaml`. */
  force?: boolean;
  /** Overwrite `config.yaml` even when `force` is false. */
  overwriteConfig?: boolean;
}

export interface ProvisionHermesHomeResult {
  hermesHome: string;
  updatedFiles: string[];
  preservedFiles: string[];
  syncedSkills: string[];
}

export interface ValidateHermesPackResult {
  valid: true;
  skillNames: string[];
  memoryChars: number;
  userChars: number;
}

function parseSkillFrontmatter(content: string): {
  name: string;
  description: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) {
    throw new Error("SKILL.md is missing YAML frontmatter.");
  }

  let name = "";
  let description = "";
  for (const line of match[1].split(/\r?\n/)) {
    const nameMatch = line.match(/^name:\s*(.+?)\s*$/);
    if (nameMatch?.[1]) {
      name = nameMatch[1].replace(/^['"]|['"]$/g, "");
    }
    const descMatch = line.match(/^description:\s*(.+?)\s*$/);
    if (descMatch?.[1]) {
      description = descMatch[1].replace(/^['"]|['"]$/g, "");
    }
  }

  if (!name || !description) {
    throw new Error("SKILL.md frontmatter must declare both 'name' and 'description'.");
  }

  return { name, description };
}

/**
 * Validates that the versioned Hermes CTO pack contains required identity, config,
 * bounded memory seeds (`<=2200` / `<=1375` chars), and valid `SKILL.md` playbooks.
 */
export function validateHermesPack(
  packDir: string = DEFAULT_HERMES_PACK_DIR,
): ValidateHermesPackResult {
  const soulPath = path.join(packDir, "SOUL.md");
  const configPath = path.join(packDir, "config.yaml");
  const memoryPath = path.join(packDir, "memories", "MEMORY.md");
  const userPath = path.join(packDir, "memories", "USER.md");
  const skillsDir = path.join(packDir, "skills");

  for (const required of [soulPath, configPath, memoryPath, userPath, skillsDir]) {
    if (!fs.existsSync(required)) {
      throw new Error(`Missing required Hermes pack path: ${required}`);
    }
  }

  if (!fs.readFileSync(soulPath, "utf8").trim()) {
    throw new Error("SOUL.md cannot be empty.");
  }

  const configText = fs.readFileSync(configPath, "utf8");
  if (!configText.includes("mcp_servers:") || !configText.includes("vps-os:")) {
    throw new Error("config.yaml must configure the 'vps-os' MCP server.");
  }

  const memoryChars = fs.readFileSync(memoryPath, "utf8").length;
  if (memoryChars > HERMES_MEMORY_MAX_CHARS) {
    throw new Error(
      `MEMORY.md (${memoryChars} chars) exceeds Hermes limit (${HERMES_MEMORY_MAX_CHARS}).`,
    );
  }

  const userChars = fs.readFileSync(userPath, "utf8").length;
  if (userChars > HERMES_USER_MAX_CHARS) {
    throw new Error(
      `USER.md (${userChars} chars) exceeds Hermes limit (${HERMES_USER_MAX_CHARS}).`,
    );
  }

  const skillEntries = fs.readdirSync(skillsDir, { withFileTypes: true });
  const skillNames: string[] = [];
  for (const entry of skillEntries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
    if (!fs.existsSync(skillFile)) {
      throw new Error(`Skill directory "${entry.name}" is missing SKILL.md.`);
    }
    const meta = parseSkillFrontmatter(fs.readFileSync(skillFile, "utf8"));
    if (meta.name !== entry.name) {
      throw new Error(
        `Skill folder "${entry.name}" does not match frontmatter name "${meta.name}".`,
      );
    }
    skillNames.push(meta.name);
  }

  if (skillNames.length === 0) {
    throw new Error("Hermes pack must include at least one CTO skill.");
  }

  return {
    valid: true,
    skillNames: skillNames.sort(),
    memoryChars,
    userChars,
  };
}

/** Renders `agent/hermes/config.yaml` with concrete MCP server command and paths. */
export function renderHermesConfig(
  template: string,
  options: HermesConfigRenderOptions = {},
): string {
  const mcpCommand = options.mcpCommand ?? "docker";
  const mcpEntry =
    options.mcpEntry ??
    (mcpCommand === "docker"
      ? "exec\n      - -i\n      - vps-os-agent\n      - node\n      - /srv/vps-os/agent/dist/mcp-server.js"
      : "/srv/vps-os/agent/dist/mcp-server.js");
  const registryDbPath = options.registryDbPath ?? "/data/registry.db";
  const appsRoot = options.appsRoot ?? "/apps";
  const templatesRoot = options.templatesRoot ?? "/srv/vps-os/templates";

  return template
    .replaceAll("__VPS_OS_MCP_COMMAND__", mcpCommand)
    .replaceAll("__VPS_OS_MCP_ENTRY__", mcpEntry)
    .replaceAll("__VPS_OS_REGISTRY_DB__", registryDbPath)
    .replaceAll("__VPS_OS_APPS_ROOT__", appsRoot)
    .replaceAll("__VPS_OS_TEMPLATES_ROOT__", templatesRoot);
}

function copyDirectoryRecursive(srcDir: string, dstDir: string): void {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcPath, dstPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

/**
 * Provisions or refreshes a Hermes CTO home directory (`HERMES_HOME`).
 * Repo-managed CTO identity (`SOUL.md`) and `skills/vps-os-*` playbooks are synced,
 * while server-owned `memories/*` and learned skills are preserved unless `force` is true.
 */
export function provisionHermesHome(
  options: ProvisionHermesHomeOptions,
): ProvisionHermesHomeResult {
  const packDir = options.packDir ?? DEFAULT_HERMES_PACK_DIR;
  const validation = validateHermesPack(packDir);

  const hermesHome = path.resolve(options.hermesHome);
  const memoriesDst = path.join(hermesHome, "memories");
  const skillsDst = path.join(hermesHome, "skills");
  fs.mkdirSync(memoriesDst, { recursive: true });
  fs.mkdirSync(skillsDst, { recursive: true });

  const updatedFiles: string[] = [];
  const preservedFiles: string[] = [];

  // Always keep CTO identity aligned with the installed VPS OS version.
  const soulDst = path.join(hermesHome, "SOUL.md");
  fs.copyFileSync(path.join(packDir, "SOUL.md"), soulDst);
  updatedFiles.push(soulDst);

  // Sync repo-managed `vps-os-*` skills without removing learned custom skills.
  for (const skillName of validation.skillNames) {
    const srcSkillDir = path.join(packDir, "skills", skillName);
    const dstSkillDir = path.join(skillsDst, skillName);
    copyDirectoryRecursive(srcSkillDir, dstSkillDir);
    updatedFiles.push(path.join(dstSkillDir, "SKILL.md"));
  }

  // Render config.yaml on first setup or when explicitly requested.
  const configDst = path.join(hermesHome, "config.yaml");
  if (
    !fs.existsSync(configDst) ||
    options.force === true ||
    options.overwriteConfig === true
  ) {
    const template = fs.readFileSync(path.join(packDir, "config.yaml"), "utf8");
    fs.writeFileSync(configDst, renderHermesConfig(template, options), "utf8");
    updatedFiles.push(configDst);
  } else {
    preservedFiles.push(configDst);
  }

  // Preserve server-owned memory files once initialized.
  for (const memoryFile of ["MEMORY.md", "USER.md"]) {
    const srcMem = path.join(packDir, "memories", memoryFile);
    const dstMem = path.join(memoriesDst, memoryFile);
    if (!fs.existsSync(dstMem) || options.force === true) {
      fs.copyFileSync(srcMem, dstMem);
      updatedFiles.push(dstMem);
    } else {
      preservedFiles.push(dstMem);
    }
  }

  return {
    hermesHome,
    updatedFiles,
    preservedFiles,
    syncedSkills: validation.skillNames,
  };
}