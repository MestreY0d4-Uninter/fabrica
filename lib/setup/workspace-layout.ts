import path from "node:path";
import fs from "node:fs/promises";
import { DATA_DIR } from "./constants.js";
import {
  resolveWorkspaceLayout as resolveCanonicalWorkspaceLayout,
  type WorkspaceLayoutVersion,
} from "./migrate-layout.js";

export const PREFERRED_DATA_DIR = DATA_DIR;
export const WORKSPACE_LAYOUT_VERSION_FILE = ".layout-version";
const LEGACY_DATA_DIR = "devclaw";

export type ResolvedWorkspaceLayout = {
  workspaceDir: string;
  dataDirName: string;
  dataDir: string;
  preferredDataDir: string;
  legacyDataDir: string;
  layoutVersion: WorkspaceLayoutVersion;
};

export async function resolveWorkspaceLayout(workspaceDir: string): Promise<ResolvedWorkspaceLayout> {
  const resolved = await resolveCanonicalWorkspaceLayout(workspaceDir);
  return {
    workspaceDir,
    dataDirName: resolved.dataDirName,
    dataDir: resolved.dataDirPath,
    preferredDataDir: path.join(workspaceDir, DATA_DIR),
    legacyDataDir: path.join(workspaceDir, LEGACY_DATA_DIR),
    layoutVersion: resolved.layoutVersion,
  };
}

export async function resolveWorkspaceDataDir(workspaceDir: string): Promise<string> {
  return (await resolveWorkspaceLayout(workspaceDir)).dataDir;
}

export async function writeWorkspaceLayoutVersion(
  workspaceDir: string,
  layoutVersion: WorkspaceLayoutVersion = "fabrica-v1",
): Promise<void> {
  const layout = await resolveWorkspaceLayout(workspaceDir);
  const targetDir = layout.preferredDataDir;
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(path.join(targetDir, WORKSPACE_LAYOUT_VERSION_FILE), `${layoutVersion}\n`, "utf-8");
}
