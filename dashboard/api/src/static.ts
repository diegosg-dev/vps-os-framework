import fs from "node:fs";
import path from "node:path";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export interface StaticAssetResult {
  body: Buffer;
  contentType: string;
}

interface CachedAsset {
  mtimeMs: number;
  body: Buffer;
  contentType: string;
}

const MAX_CACHED_ASSETS = 128;
const assetCache = new Map<string, CachedAsset>();

function isWithinRoot(realRoot: string, realTarget: string): boolean {
  const rel = path.relative(realRoot, realTarget);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function resolveSafeStaticFile(
  webDistDir: string,
  requestPath: string,
): { targetFile: string; contentType: string; mtimeMs: number } | null {
  const root = path.resolve(webDistDir);
  if (!fs.existsSync(root)) {
    return null;
  }

  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return null;
  }

  const cleanPath = (requestPath.split("?")[0] ?? "/").split("#")[0] ?? "/";
  if (cleanPath.includes("\0")) {
    return null;
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(cleanPath);
  } catch {
    return null;
  }
  if (decodedPath.includes("\0") || decodedPath.includes("\\")) {
    return null;
  }

  const relativeReq =
    decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  const candidate = path.resolve(realRoot, relativeReq);
  const lexicalRel = path.relative(realRoot, candidate);
  if (lexicalRel.startsWith("..") || path.isAbsolute(lexicalRel)) {
    return null;
  }

  let targetFile: string | null = null;
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    targetFile = candidate;
  } else {
    // Only fall back to SPA index.html for extensionless client routes, not missing assets.
    const hasExtension = path.extname(relativeReq) !== "";
    if (!hasExtension) {
      const spaFallback = path.join(realRoot, "index.html");
      if (fs.existsSync(spaFallback) && fs.statSync(spaFallback).isFile()) {
        targetFile = spaFallback;
      }
    }
  }

  if (!targetFile) {
    return null;
  }

  let realTarget: string;
  try {
    realTarget = fs.realpathSync(targetFile);
  } catch {
    return null;
  }

  if (!isWithinRoot(realRoot, realTarget)) {
    return null;
  }

  const stat = fs.statSync(realTarget);
  if (!stat.isFile()) {
    return null;
  }

  const ext = path.extname(realTarget).toLowerCase();
  return {
    targetFile: realTarget,
    contentType: MIME_TYPES[ext] ?? "application/octet-stream",
    mtimeMs: stat.mtimeMs,
  };
}

/**
 * Safely resolves and reads static UI assets from `webDistDir` with
 * path-traversal + symlink containment protection and SPA fallback for extensionless routes.
 */
export function readStaticUiAsset(
  webDistDir: string,
  requestPath: string,
): StaticAssetResult | null {
  const resolved = resolveSafeStaticFile(webDistDir, requestPath);
  if (!resolved) {
    return null;
  }

  const cached = assetCache.get(resolved.targetFile);
  if (cached && cached.mtimeMs === resolved.mtimeMs) {
    assetCache.delete(resolved.targetFile);
    assetCache.set(resolved.targetFile, cached);
    return { body: cached.body, contentType: cached.contentType };
  }

  const body = fs.readFileSync(resolved.targetFile);
  if (assetCache.size >= MAX_CACHED_ASSETS) {
    const oldestKey = assetCache.keys().next().value;
    if (oldestKey !== undefined) {
      assetCache.delete(oldestKey);
    }
  }
  assetCache.set(resolved.targetFile, {
    mtimeMs: resolved.mtimeMs,
    body,
    contentType: resolved.contentType,
  });

  return { body, contentType: resolved.contentType };
}

/**
 * Async variant of `readStaticUiAsset` to avoid blocking the event loop on cache misses.
 */
export async function readStaticUiAssetAsync(
  webDistDir: string,
  requestPath: string,
): Promise<StaticAssetResult | null> {
  const resolved = resolveSafeStaticFile(webDistDir, requestPath);
  if (!resolved) {
    return null;
  }

  const cached = assetCache.get(resolved.targetFile);
  if (cached && cached.mtimeMs === resolved.mtimeMs) {
    assetCache.delete(resolved.targetFile);
    assetCache.set(resolved.targetFile, cached);
    return { body: cached.body, contentType: cached.contentType };
  }

  const body = await fs.promises.readFile(resolved.targetFile);
  if (assetCache.size >= MAX_CACHED_ASSETS) {
    const oldestKey = assetCache.keys().next().value;
    if (oldestKey !== undefined) {
      assetCache.delete(oldestKey);
    }
  }
  assetCache.set(resolved.targetFile, {
    mtimeMs: resolved.mtimeMs,
    body,
    contentType: resolved.contentType,
  });

  return { body, contentType: resolved.contentType };
}
