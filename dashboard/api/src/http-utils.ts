import crypto from "node:crypto";
import type { Context } from "hono";

export class PayloadTooLargeError extends Error {
  constructor() {
    super("Payload too large.");
  }
}

export class InvalidJsonError extends Error {
  constructor() {
    super("Invalid JSON body.");
  }
}

export function sha256Digest(value: string): Buffer {
  return crypto.createHash("sha256").update(value, "utf8").digest();
}

export function tokensEqual(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  return crypto.timingSafeEqual(sha256Digest(provided), sha256Digest(expected));
}

export function extractRequestToken(
  authHeader: string | undefined,
  headerToken: string | undefined,
): string | undefined {
  if (headerToken?.trim()) {
    return headerToken.trim();
  }
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    return token || undefined;
  }
  return undefined;
}

export async function readJsonBody(
  c: Context,
  maxBodyBytes: number,
  options?: { allowEmpty?: boolean },
): Promise<unknown> {
  const declaredLen = c.req.header("content-length");
  if (declaredLen !== undefined) {
    const parsedLen = Number(declaredLen);
    if (Number.isFinite(parsedLen) && parsedLen > maxBodyBytes) {
      throw new PayloadTooLargeError();
    }
  }

  let rawText: string;
  const bodyStream = c.req.raw.body;
  if (bodyStream) {
    const reader = bodyStream.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > maxBodyBytes) {
            await reader.cancel().catch(() => undefined);
            throw new PayloadTooLargeError();
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
    rawText = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
      "utf8",
    );
  } else {
    rawText = await c.req.text();
    if (Buffer.byteLength(rawText, "utf8") > maxBodyBytes) {
      throw new PayloadTooLargeError();
    }
  }

  if (options?.allowEmpty && rawText.trim() === "") {
    return undefined;
  }

  try {
    return JSON.parse(rawText) as unknown;
  } catch {
    throw new InvalidJsonError();
  }
}

export function handleBodyReadError(c: Context, err: unknown): Response {
  if (err instanceof PayloadTooLargeError) {
    return c.json({ error: err.message }, 413);
  }
  if (err instanceof InvalidJsonError) {
    return c.json({ error: err.message }, 400);
  }
  return c.json({ error: "Invalid request body." }, 400);
}
