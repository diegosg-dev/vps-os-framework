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

/**
 * Safely resolves and reads static UI assets from `webDistDir` with
 * path-traversal protection and SPA fallback to `index.html`.
 */
export function readStaticUiAsset(
  webDistDir: string,
  requestPath: string,
): StaticAssetResult | null {
  const root = path.resolve(webDistDir);
  if (!fs.existsSync(root)) {
    return null;
  }

  const cleanPath = requestPath.split("?")[0] ?? "/";
  if (cleanPath.includes("\0")) {
    return null;
  }

  const relativeReq = cleanPath === "/" ? "index.html" : cleanPath.replace(/^\/+/, "");
  const candidate = path.resolve(root, relativeReq);
  const rel = path.relative(root, candidate);

  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }

  const targetFile =
    fs.existsSync(candidate) && fs.statSync(candidate).isFile()
      ? candidate
      : path.join(root, "index.html");

  if (!fs.existsSync(targetFile) || !fs.statSync(targetFile).isFile()) {
    return null;
  }

  const ext = path.extname(targetFile).toLowerCase();
  return {
    body: fs.readFileSync(targetFile),
    contentType: MIME_TYPES[ext] ?? "application/octet-stream",
  };
}
