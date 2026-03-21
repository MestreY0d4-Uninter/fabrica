import path from "node:path";

/**
 * Resolves path segments relative to `base` and ensures the result stays
 * within `base`. Throws if the resolved path would escape the base directory.
 */
export function safePath(base: string, ...segments: string[]): string {
  const resolved = path.resolve(base, ...segments);
  const resolvedBase = path.resolve(base);
  if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + path.sep)) {
    throw new Error(`Path traversal detected: ${segments.join("/")} escapes ${base}`);
  }
  return resolved;
}

/**
 * Validates a single path component (no slashes, no "..", no null bytes).
 * Returns the component unchanged if valid; throws otherwise.
 */
export function safeComponent(component: string): string {
  if (/[/\\]/.test(component) || component.includes("..") || component.includes("\0")) {
    throw new Error(`Unsafe path component: ${component}`);
  }
  return component;
}
