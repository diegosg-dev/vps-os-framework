import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type AppRecord,
  type SystemRegistryStore,
  type WorkloadKind,
  resolveScopedAppDir,
  validateDomain,
} from "@vps-os/shared";

export interface ProvisionWorkspaceInput {
  appsRoot: string;
  templatesRoot: string;
  slug: string;
  name: string;
  kind: WorkloadKind;
  domain: string | null;
  internalPort?: number;
  registry: SystemRegistryStore;
}

export interface ProvisionWorkspaceResult {
  appDir: string;
  composePath: string;
  envExamplePath: string;
  envPath: string;
  dataDir: string;
  record: AppRecord;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildStarterWebHtml(appName: string, slug: string): string {
  const safeName = escapeHtml(appName);
  const safeSlug = escapeHtml(slug);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeName} · VPS OS</title>
    <style>
      body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; display: grid; place-items: center; min-height: 100vh; }
      main { max-width: 34rem; padding: 2rem; border: 1px solid #1e293b; border-radius: 1rem; background: #020617; }
      h1 { margin: 0 0 0.5rem; font-size: 1.5rem; }
      p { margin: 0.25rem 0; color: #94a3b8; line-height: 1.5; }
      code { color: #38bdf8; }
    </style>
  </head>
  <body>
    <main>
      <h1>${safeName}</h1>
      <p>Isolated VPS OS workload <code>${safeSlug}</code> is up and serving traffic.</p>
      <p>Replace files in <code>/apps/${safeSlug}/data/</code> to customize this app.</p>
    </main>
  </body>
</html>
`;
}

/**
 * Isolated Subagent Runtime (Step 6):
 * Prepares a "Locked Apartment" workspace under `<appsRoot>/<slug>` without
 * overwriting existing apps, touching sibling folders, or leaking secrets.
 */
export function provisionIsolatedWorkspace(
  input: ProvisionWorkspaceInput,
): ProvisionWorkspaceResult {
  const appDir = resolveScopedAppDir(input.appsRoot, input.slug);
  const safeDomain = input.domain ? validateDomain(input.domain) : null;

  if (fs.existsSync(appDir) || input.registry.getAppBySlug(input.slug)) {
    throw new Error(`App workspace "${input.slug}" already exists.`);
  }

  const templateDir = path.resolve(input.templatesRoot, input.kind);
  const templateCompose = path.join(templateDir, "docker-compose.yml");
  const templateEnvExample = path.join(templateDir, ".env.example");

  if (!fs.existsSync(templateCompose) || !fs.existsSync(templateEnvExample)) {
    throw new Error(
      `Missing workload template for kind "${input.kind}" at "${templateDir}".`,
    );
  }

  const port = input.internalPort ?? (input.kind === "personal-agent" ? 3000 : 8080);
  const persistentSubdir = input.kind === "personal-agent" ? "workspace" : "data";
  const dataDir = path.join(appDir, persistentSubdir);
  const composePath = path.join(appDir, "docker-compose.yml");
  const envExamplePath = path.join(appDir, ".env.example");
  const envPath = path.join(appDir, ".env");

  fs.mkdirSync(dataDir, { recursive: true });

  try {
    fs.copyFileSync(templateCompose, composePath);

    let envTemplate = fs
      .readFileSync(templateEnvExample, "utf8")
      .replace(/^APP_SLUG=.*$/m, `APP_SLUG=${input.slug}`);
    if (/^APP_PORT=.*$/m.test(envTemplate)) {
      envTemplate = envTemplate.replace(/^APP_PORT=.*$/m, `APP_PORT=${port}`);
    } else {
      envTemplate = `${envTemplate.trimEnd()}\nAPP_PORT=${port}\n`;
    }

    fs.writeFileSync(envExamplePath, envTemplate, "utf8");
    fs.writeFileSync(envPath, envTemplate, { encoding: "utf8", mode: 0o600 });

    if (input.kind === "web-app") {
      const indexHtmlPath = path.join(dataDir, "index.html");
      if (!fs.existsSync(indexHtmlPath)) {
        fs.writeFileSync(
          indexHtmlPath,
          buildStarterWebHtml(input.name.trim(), input.slug),
          "utf8",
        );
      }
    }

    const now = new Date().toISOString();
    const record = input.registry.upsertApp({
      slug: input.slug,
      name: input.name.trim(),
      kind: input.kind,
      domain: safeDomain,
      folderPath: appDir,
      internalPort: port,
      status: "provisioning",
      cpuLimit: input.kind === "personal-agent" ? "1.0" : "0.5",
      memoryLimitMb: input.kind === "personal-agent" ? 1024 : 512,
      createdAt: now,
      updatedAt: now,
    });

    input.registry.recordAudit({
      id: crypto.randomUUID(),
      actor: "agent",
      action: "workspace.provisioned",
      targetSlug: record.slug,
      summary: `Prepared isolated ${record.kind} workspace at ${record.folderPath}`,
      riskLevel: "medium",
      createdAt: now,
    });

    return {
      appDir,
      composePath,
      envExamplePath,
      envPath,
      dataDir,
      record,
    };
  } catch (err) {
    fs.rmSync(appDir, { recursive: true, force: true });
    throw err;
  }
}
