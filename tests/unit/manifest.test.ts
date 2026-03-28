import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  loadFabricaManifest,
  resolvePackagedAssetPath,
} from "../../lib/setup/manifest.js";

describe("fabrica manifest", () => {
  it("declares the canonical layout and packaged assets", () => {
    const manifest = loadFabricaManifest();

    expect(manifest.layoutVersion).toBe("fabrica-v1");
    expect(manifest.layout.primaryDataDir).toBe("fabrica");
    expect(manifest.layout.versionFile).toBe(".layout-version");

    expect(manifest.assets.defaultsDir).toBe("defaults");
    expect(manifest.assets.promptsDir).toBe("defaults/fabrica/prompts");
    expect(manifest.assets.securityChecklistPath).toBe("defaults/fabrica/prompts/security-checklist.md");
    expect(manifest.assets.workflowPath).toBe("defaults/fabrica/workflow.yaml");
    expect(manifest.assets.templatesDir).toBe("defaults");
    expect(manifest.assets.genesis.scriptsDir).toBe("genesis/scripts");
    expect(manifest.assets.genesis.configsDir).toBe("genesis/configs");
    expect(manifest.assets.migrations).toContain("layout");
    expect(manifest.assets.migrations).toContain("workflow");
  });

  it("resolves packaged asset paths that exist in the source tree", () => {
    const manifest = loadFabricaManifest();
    const pathsToCheck = [
      manifest.assets.defaultsDir,
      manifest.assets.promptsDir,
      manifest.assets.securityChecklistPath,
      manifest.assets.workflowPath,
    ];

    for (const relativePath of pathsToCheck) {
      expect(fs.existsSync(resolvePackagedAssetPath(relativePath))).toBe(true);
    }
  });

  it("resolves the packaged genesis asset directories", () => {
    const manifest = loadFabricaManifest();
    const scriptsDir = resolvePackagedAssetPath(manifest.assets.genesis.scriptsDir);
    const configsDir = resolvePackagedAssetPath(manifest.assets.genesis.configsDir);

    expect(fs.existsSync(scriptsDir)).toBe(true);
    expect(fs.statSync(scriptsDir).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(scriptsDir, "scaffold-project.sh"))).toBe(true);
    expect(fs.existsSync(configsDir)).toBe(true);
    expect(fs.statSync(configsDir).isDirectory()).toBe(true);
  });
});
