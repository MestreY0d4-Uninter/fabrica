import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runSecurityDoctor } from "../../lib/setup/security-doctor.js";
import { DATA_DIR } from "../../lib/setup/constants.js";

describe("runSecurityDoctor", () => {
  it("reports legacy genesis-router separately from current genesis binding", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-security-doctor-"));
    const workspace = path.join(home, "workspace");
    const promptsDir = path.join(workspace, DATA_DIR, "prompts");
    const cronDir = path.join(home, "cron");
    await fs.mkdir(promptsDir, { recursive: true });
    await fs.mkdir(cronDir, { recursive: true });
    await fs.writeFile(path.join(promptsDir, "security-checklist.md"), "ok\n", "utf-8");
    await fs.writeFile(path.join(cronDir, "jobs.json"), JSON.stringify({ jobs: [] }, null, 2), "utf-8");
    await fs.writeFile(
      path.join(home, "openclaw.json"),
      JSON.stringify({
        gateway: { bind: "loopback", auth: { mode: "token", token: "abc" } },
        channels: { telegram: { enabled: true, allowFrom: ["123"] } },
        plugins: { entries: {}, allow: [] },
        bindings: [
          { agentId: "genesis-router", match: { channel: "telegram" } },
          { agentId: "genesis", match: { channel: "telegram" } },
        ],
      }, null, 2),
      "utf-8",
    );

    try {
      const result = await runSecurityDoctor(home);
      const legacy = result.checks.find((check) => check.name === "bindings:telegram-router");
      const genesis = result.checks.find((check) => check.name === "bindings:telegram-genesis");

      expect(legacy?.severity).toBe("warn");
      expect(legacy?.message).toContain("legacy genesis-router");
      expect(genesis?.severity).toBe("ok");
      expect(genesis?.message).toContain("Genesis agent owns");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
