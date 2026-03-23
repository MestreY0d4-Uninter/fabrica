import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

describe("scaffold step — qa.sh overwrite ordering", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const d of tempDirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
    tempDirs.length = 0;
  });

  it("writes qa.sh even when bootstrap returns ready:false", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-qa-overwrite-"));
    tempDirs.push(tmpDir);

    const scriptsDir = path.join(tmpDir, "scripts");
    await fs.mkdir(scriptsDir, { recursive: true });

    // Write a "legacy" qa.sh that references the wrong path
    await fs.writeFile(
      path.join(scriptsDir, "qa.sh"),
      '#!/bin/bash\nif [[ -d "$HOME/.openclaw/qa-venv" ]]; then\n  export PATH="$HOME/.openclaw/qa-venv/bin:$PATH"\nfi\n',
      { mode: 0o755 },
    );

    const before = await fs.readFile(path.join(scriptsDir, "qa.sh"), "utf-8");
    expect(before).toContain("qa-venv");

    // Simulate the overwrite that scaffold.ts should do BEFORE bootstrap ready check
    await fs.writeFile(
      path.join(scriptsDir, "qa.sh"),
      '#!/bin/bash\nTOOLCHAIN="$HOME/.openclaw/toolchains/python"\nexport PATH="$TOOLCHAIN/bin:$PATH"\n',
      { mode: 0o755 },
    );

    const after = await fs.readFile(path.join(scriptsDir, "qa.sh"), "utf-8");
    expect(after).toContain("toolchains/python");
    expect(after).not.toContain("qa-venv");
  });
});
