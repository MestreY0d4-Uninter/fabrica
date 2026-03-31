import path from "node:path";
import { fileTypeFromBuffer } from "file-type";

type ToolTextResult<T> = {
  content: Array<{ type: "text"; text: string }>;
  details: T;
};

const MIME_BY_EXT: Record<string, string> = {
  ".aac": "audio/aac",
  ".csv": "text/csv",
  ".flac": "audio/flac",
  ".gif": "image/gif",
  ".gz": "application/gzip",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".m4a": "audio/mp4",
  ".md": "text/markdown",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".rar": "application/vnd.rar",
  ".tar": "application/x-tar",
  ".txt": "text/plain",
  ".wav": "audio/wav",
  ".webp": "image/webp",
  ".zip": "application/zip",
};

function normalizeMimeType(value?: string): string | undefined {
  return value?.split(";")[0]?.trim().toLowerCase() || undefined;
}

function getFileExtension(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  try {
    if (/^https?:\/\//i.test(filePath)) {
      return path.extname(new URL(filePath).pathname).toLowerCase() || undefined;
    }
  } catch {
    // fall through to plain path.extname
  }
  return path.extname(filePath).toLowerCase() || undefined;
}

function isGenericMime(value?: string): boolean {
  const normalized = normalizeMimeType(value);
  if (!normalized) return true;
  return (
    normalized === "application/octet-stream" ||
    normalized === "application/zip"
  );
}

function prepareSniffBuffer(value: Uint8Array): Buffer {
  const source = Buffer.from(value);
  if (source.length >= 64) return source;
  return Buffer.concat([source, Buffer.alloc(64 - source.length)]);
}

export function jsonResult<T>(payload: T): ToolTextResult<T> {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

export async function detectMime(opts: {
  filePath?: string;
  buffer?: Uint8Array;
  headerMime?: string;
}): Promise<string | undefined> {
  const extMime = MIME_BY_EXT[getFileExtension(opts.filePath) ?? ""];
  const headerMime = normalizeMimeType(opts.headerMime);
  const sniffed = opts.buffer
    ? normalizeMimeType((await fileTypeFromBuffer(prepareSniffBuffer(opts.buffer)))?.mime)
    : undefined;

  if (sniffed && (!isGenericMime(sniffed) || !extMime)) return sniffed;
  if (extMime) return extMime;
  if (headerMime && !isGenericMime(headerMime)) return headerMime;
  return sniffed ?? headerMime;
}
