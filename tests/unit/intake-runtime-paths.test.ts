import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveGenesisScriptsDir,
  resolveOpenClawCli,
  runGenesisScript,
} from "../../lib/intake/lib/runtime-paths.js";
import type { GenesisPayload, StepContext } from "../../lib/intake/types.js";

const envKeys = [
  "OPENCLAW_BIN",
  "OPENCLAW_HOME",
  "FABRICA_GENESIS_SCRIPTS_DIR",
  "FABRICA_ROOT",
] as const;

const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

afterEach(async () => {
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
});

function basePayload(sessionId = "session-1"): GenesisPayload {
  return {
    session_id: sessionId,
    timestamp: new Date().toISOString(),
    step: "impact",
    raw_idea: "Criar uma CLI reproduzivel",
    answers: {},
    metadata: {
      source: "test",
      factory_change: false,
    },
  };
}

describe("runtime-paths", () => {
  it("prefers OPENCLAW_BIN when it points to a real file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-openclaw-bin-"));
    const fakeBin = path.join(root, "openclaw");
    await fs.writeFile(fakeBin, "#!/usr/bin/env bash\n", "utf-8");
    process.env.OPENCLAW_BIN = fakeBin;

    try {
      expect(resolveOpenClawCli({ homeDir: root, workspaceDir: path.join(root, ".openclaw", "workspace") })).toBe(fakeBin);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("prefers bundled extension scripts before legacy workspace fallbacks", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-genesis-runtime-"));
    const workspaceDir = path.join(root, ".openclaw", "workspace");
    const workspaceScriptsDir = path.join(workspaceDir, "skills", "project-genesis", "scripts");
    const extensionScriptsDir = path.join(root, ".openclaw", "extensions", "fabrica", "genesis", "scripts");
    await fs.mkdir(workspaceScriptsDir, { recursive: true });
    await fs.mkdir(extensionScriptsDir, { recursive: true });
    await fs.writeFile(path.join(workspaceScriptsDir, "scaffold-project.sh"), "#!/usr/bin/env bash\n", "utf-8");
    await fs.writeFile(path.join(extensionScriptsDir, "scaffold-project.sh"), "#!/usr/bin/env bash\n", "utf-8");

    try {
      expect(resolveGenesisScriptsDir({ homeDir: root, workspaceDir })).toBe(extensionScriptsDir);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to the legacy workspace scripts when the bundled extension is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-genesis-runtime-legacy-"));
    const workspaceDir = path.join(root, ".openclaw", "workspace");
    const scriptsDir = path.join(workspaceDir, "skills", "project-genesis", "scripts");
    const scriptName = "legacy-only.sh";
    await fs.mkdir(scriptsDir, { recursive: true });
    await fs.writeFile(path.join(scriptsDir, scriptName), "#!/usr/bin/env bash\n", "utf-8");

    try {
      expect(resolveGenesisScriptsDir({ homeDir: root, workspaceDir }, scriptName)).toBe(scriptsDir);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("invokes genesis scripts through bash with an explicit script path and input file argument", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-genesis-run-"));
    const workspaceDir = path.join(root, ".openclaw", "workspace");
    const scriptsDir = path.join(root, ".openclaw", "extensions", "fabrica", "genesis", "scripts");
    const scriptName = "custom-register.sh";
    await fs.mkdir(scriptsDir, { recursive: true });
    await fs.writeFile(path.join(scriptsDir, scriptName), "#!/usr/bin/env bash\ncat\n", "utf-8");

    const calls: Array<{ cmd: string; args: string[] }> = [];
    const ctx: StepContext = {
      homeDir: root,
      workspaceDir,
      log: () => {},
      runCommand: async (cmd, args) => {
        calls.push({ cmd, args });
        return { stdout: "{}", stderr: "", exitCode: 0 };
      },
    };

    try {
      await runGenesisScript(ctx, scriptName, basePayload("sid-safe"), 5000);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.cmd).toBe("bash");
      expect(calls[0]?.args[0]).toBe(path.join(scriptsDir, scriptName));
      expect(calls[0]?.args[1]).toMatch(/fabrica-genesis-custom-register\.sh-sid-safe-\d+\.json$/);
      expect(calls[0]?.args).not.toContain("-c");
      expect(calls[0]?.args).not.toContain("-lc");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
