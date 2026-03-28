import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PREFERRED_DATA_DIR,
  resolveWorkspaceLayout,
} from "../../lib/setup/workspace-layout.js";

const LEGACY_DATA_DIR = "devclaw";

describe("workspace layout resolver", () => {
  it("prefers fabrica when present", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-layout-"));
    try {
      await fs.mkdir(path.join(ws, PREFERRED_DATA_DIR), { recursive: true });
      await fs.mkdir(path.join(ws, LEGACY_DATA_DIR), { recursive: true });

      const layout = await resolveWorkspaceLayout(ws);
      expect(layout.dataDirName).toBe(PREFERRED_DATA_DIR);
      expect(layout.layoutVersion).toBe("fabrica-v1");
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  });

  it("falls back to legacy devclaw when fabrica is absent", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-layout-"));
    try {
      await fs.mkdir(path.join(ws, LEGACY_DATA_DIR), { recursive: true });
      const layout = await resolveWorkspaceLayout(ws);
      expect(layout.dataDirName).toBe(LEGACY_DATA_DIR);
      expect(layout.layoutVersion).toBe("devclaw-legacy");
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  });
});
