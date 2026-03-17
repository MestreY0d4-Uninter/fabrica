import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GenesisPayload, StepContext } from "../types.js";
import { loadFabricaManifest, resolvePackagedAssetPath } from "../../setup/manifest.js";

type RuntimePathOptions = {
  homeDir?: string;
  workspaceDir?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

function isUsableFile(candidate: string | undefined): candidate is string {
  if (!candidate) return false;
  try {
    return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isUsableDir(candidate: string | undefined): candidate is string {
  if (!candidate) return false;
  try {
    return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function findNewestNvmOpenClaw(homeDir: string, env: NodeJS.ProcessEnv): string | null {
  const versionsDir = path.join(homeDir, ".nvm", "versions", "node");
  try {
    const versions = fs.readdirSync(versionsDir).sort().reverse();
    for (const version of versions) {
      const candidate = path.join(versionsDir, version, "bin", "openclaw");
      if (isUsableFile(candidate)) return candidate;
    }
  } catch {
    // Ignore — fall back to other locations.
  }
  return null;
}

function deriveOpenClawHome({ homeDir, workspaceDir, env }: Required<Pick<RuntimePathOptions, "homeDir" | "workspaceDir" | "env">>): string | null {
  const envHome = env.OPENCLAW_HOME;
  if (isUsableDir(envHome)) return envHome;

  if (workspaceDir) {
    const normalized = path.resolve(workspaceDir);
    if (path.basename(normalized) === "workspace") {
      const parent = path.dirname(normalized);
      if (isUsableDir(parent)) return parent;
    }
  }

  const homeFallback = path.join(homeDir, ".openclaw");
  return isUsableDir(homeFallback) ? homeFallback : null;
}

function candidateDirs(options: Required<RuntimePathOptions>): string[] {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(currentDir, "../../../../");
  const openClawHome = deriveOpenClawHome(options);
  const dirs = [
    options.cwd,
    repoRoot,
    openClawHome ? path.join(openClawHome, "workspace") : null,
    openClawHome ? path.join(openClawHome, "extensions", "fabrica") : null,
    openClawHome,
    options.workspaceDir,
    options.homeDir,
  ];
  return dirs.filter((value): value is string => typeof value === "string" && value.length > 0);
}

export function resolveOpenClawCli(opts: RuntimePathOptions = {}): string {
  const homeDir = opts.homeDir ?? os.homedir();
  const workspaceDir = opts.workspaceDir ?? "";
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const envCandidate = env.OPENCLAW_BIN;
  if (isUsableFile(envCandidate)) return envCandidate;

  for (const baseDir of candidateDirs({ homeDir, workspaceDir, cwd, env })) {
    const localBin = path.join(baseDir, "node_modules", ".bin", "openclaw");
    if (isUsableFile(localBin)) return localBin;
  }

  const siblingCandidate = path.join(path.dirname(process.execPath), "openclaw");
  if (isUsableFile(siblingCandidate)) return siblingCandidate;

  const nvmCandidate = findNewestNvmOpenClaw(homeDir, env);
  if (nvmCandidate) return nvmCandidate;

  for (const candidate of [
    path.join(homeDir, ".local", "bin", "openclaw"),
    "/usr/local/bin/openclaw",
    "/opt/homebrew/bin/openclaw",
    "/usr/bin/openclaw",
  ]) {
    if (isUsableFile(candidate)) return candidate;
  }

  return "openclaw";
}

export function resolveGenesisScriptsDir(
  opts: RuntimePathOptions = {},
  requiredScript = "scaffold-project.sh",
): string {
  const homeDir = opts.homeDir ?? os.homedir();
  const workspaceDir = opts.workspaceDir ?? "";
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const openClawHome = deriveOpenClawHome({ homeDir, workspaceDir, env });
  const envDirs = [
    env.FABRICA_GENESIS_SCRIPTS_DIR,
    env.FABRICA_ROOT ? path.join(env.FABRICA_ROOT, "genesis", "scripts") : undefined,
  ];
  for (const candidate of envDirs) {
    if (isUsableFile(candidate ? path.join(candidate, requiredScript) : undefined)) {
      return candidate!;
    }
  }

  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(currentDir, "../../../../");
  const manifest = loadFabricaManifest();
  const candidates = [
    openClawHome ? path.join(openClawHome, "extensions", "fabrica", "genesis", "scripts") : undefined,
    resolvePackagedAssetPath(manifest.assets.genesis.scriptsDir),
    path.join(repoRoot, "genesis", "scripts"),
    path.join(cwd, "genesis", "scripts"),
    workspaceDir ? path.join(workspaceDir, "skills", "project-genesis", "scripts") : undefined,
    openClawHome ? path.join(openClawHome, "workspace", "skills", "project-genesis", "scripts") : undefined,
  ];

  for (const candidate of candidates) {
    if (isUsableFile(candidate ? path.join(candidate, requiredScript) : undefined)) {
      return candidate!;
    }
  }

  throw new Error(
    "Genesis scripts directory not found. Set FABRICA_GENESIS_SCRIPTS_DIR or provide a workspace/repo with project-genesis scripts.",
  );
}

export async function runGenesisScript(
  ctx: StepContext,
  scriptName: string,
  payload: GenesisPayload,
  timeout = 120000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const scriptsDir = resolveGenesisScriptsDir(
    { homeDir: ctx.homeDir, workspaceDir: ctx.workspaceDir },
    scriptName,
  );
  const scriptPath = path.join(scriptsDir, scriptName);
  const tmpInput = path.join(
    os.tmpdir(),
    `fabrica-genesis-${scriptName}-${payload.session_id}-${Date.now()}.json`,
  );

  await fsp.writeFile(tmpInput, JSON.stringify(payload), "utf-8");
  try {
    return await ctx.runCommand(
      "bash",
      [scriptPath, tmpInput],
      { timeout },
    );
  } finally {
    await fsp.rm(tmpInput, { force: true });
  }
}
