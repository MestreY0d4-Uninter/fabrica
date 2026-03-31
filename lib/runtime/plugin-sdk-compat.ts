import path from "node:path";
import { fileTypeFromBuffer } from "file-type";

type ToolTextResult<T> = {
  content: Array<{ type: "text"; text: string }>;
  details: T;
};

const MIME_BY_EXT: Record<string, string> = {
  ".aac": "audio/aac",
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".flac": "audio/flac",
  ".gif": "image/gif",
  ".gz": "application/gzip",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript",
  ".json": "application/json",
  ".mov": "video/quicktime",
  ".m4a": "audio/x-m4a",
  ".md": "text/markdown",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".rar": "application/vnd.rar",
  ".tar": "application/x-tar",
  ".txt": "text/plain",
  ".wav": "audio/wav",
  ".webp": "image/webp",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".zip": "application/zip",
  ".7z": "application/x-7z-compressed",
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
  const sniffLimit = 64;
  let sniffBuffer: Uint8Array | undefined;
  if (opts.buffer && opts.buffer.length > 0) {
    const prefix = opts.buffer.subarray(0, Math.min(opts.buffer.length, sniffLimit));
    if (prefix.length === sniffLimit) {
      sniffBuffer = prefix;
    } else {
      sniffBuffer = Buffer.concat([
        Buffer.from(prefix),
        Buffer.alloc(sniffLimit - prefix.length),
      ]);
    }
  }
  const sniffed = sniffBuffer
    ? normalizeMimeType((await fileTypeFromBuffer(sniffBuffer))?.mime)
    : undefined;

  if (sniffed && (!isGenericMime(sniffed) || !extMime)) return sniffed;
  if (extMime) return extMime;
  if (headerMime && !isGenericMime(headerMime)) return headerMime;
  return sniffed ?? headerMime;
}
