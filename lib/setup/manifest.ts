import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type FabricaManifest = {
  layoutVersion: string;
  assets: {
    defaultsDir: string;
    promptsDir: string;
    securityChecklistPath: string;
    workflowPath: string;
    templatesDir: string;
    genesis: {
      root: string;
      scriptsDir: string;
      configsDir: string;
    };
    migrations: string[];
  };
  layout: {
    primaryDataDir: string;
    versionFile: string;
  };
};

function resolvePackageRoot(): string {
  const baseDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(baseDir, "..", ".."),
    path.join(baseDir, ".."),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "fabrica.manifest.json"))) {
      return candidate;
    }
  }

  return candidates[0]!;
}

export function loadFabricaManifest(): FabricaManifest {
  const packageRoot = resolvePackageRoot();
  const manifestPath = path.join(packageRoot, "fabrica.manifest.json");
  return JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as FabricaManifest;
}

export function resolvePackagedAssetPath(relativePath: string): string {
  const packageRoot = resolvePackageRoot();
  const packagedCandidate = path.join(packageRoot, relativePath);
  if (fs.existsSync(packagedCandidate)) {
    return packagedCandidate;
  }

  // Source-tree fallback: before `build.mjs` copies Genesis assets into
  // fabrica/genesis, they still live one directory above the package root.
  const sourceTreeCandidate = path.join(packageRoot, "..", relativePath);
  if (fs.existsSync(sourceTreeCandidate)) {
    return sourceTreeCandidate;
  }

  return packagedCandidate;
}
