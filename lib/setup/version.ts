/**
 * setup/version.ts — Version tracking for Fabrica workspaces.
 *
 * Reads/writes `.version` inside the canonical Fabrica data dir to track which
 * plugin version last scaffolded or migrated the workspace.
 */
import fsAsync from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Injected at build time by esbuild (see build.mjs). */
declare const __PLUGIN_VERSION__: string | undefined;

const VERSION_FILE = ".version";

// Pre-compute package.json path for dev/test fallback (ESM-safe)
const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Get the current Fabrica plugin version. */
export function getCurrentVersion(): string {
  if (typeof __PLUGIN_VERSION__ !== "undefined" && __PLUGIN_VERSION__) {
    return __PLUGIN_VERSION__;
  }
  // Dev/test fallback: read from package.json
  try {
    const pkgPath = path.join(THIS_DIR, "..", "..", "package.json");
    const pkg = JSON.parse(fsSync.readFileSync(pkgPath, "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Read the stored workspace version marker. */
export async function readVersionFile(dataDir: string): Promise<string | null> {
  try {
    const content = await fsAsync.readFile(path.join(dataDir, VERSION_FILE), "utf-8");
    return content.trim() || null;
  } catch {
    return null;
  }
}

/** Write the current version marker to the workspace data dir. */
export async function writeVersionFile(dataDir: string): Promise<void> {
  await fsAsync.writeFile(
    path.join(dataDir, VERSION_FILE),
    getCurrentVersion() + "\n",
    "utf-8",
  );
}

/**
 * Detect whether an upgrade occurred.
 *
 * Returns null for first-run (no existing .version file) or same version.
 * Returns { from, to } when versions differ.
 */
export async function detectUpgrade(
  dataDir: string,
): Promise<{ from: string; to: string } | null> {
  const stored = await readVersionFile(dataDir);
  if (!stored) return null; // First run — no upgrade

  const current = getCurrentVersion();
  if (stored === current) return null; // Same version

  return { from: stored, to: current };
}
