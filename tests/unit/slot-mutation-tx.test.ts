import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DATA_DIR } from "../../lib/setup/constants.js";
import { withProjectsMutation } from "../../lib/projects/io.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-tx-"));
  const dataDir = path.join(tmpDir, DATA_DIR);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(
    path.join(dataDir, "projects.json"),
    JSON.stringify({ _seq: 1, projects: { "test-proj": { slug: "test-proj", name: "Test", workers: {}, channels: [] } } }, null, 2),
    "utf-8",
  );
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("withProjectsMutation", () => {
  it("increments _seq on each write", async () => {
    await withProjectsMutation(tmpDir, (data) => {
      (data.projects as any)["test-proj"].name = "Updated";
    });

    const raw = await fs.readFile(path.join(tmpDir, DATA_DIR, "projects.json"), "utf-8");
    const updated = JSON.parse(raw);
    expect(updated._seq).toBe(2);
    expect(updated.projects["test-proj"].name).toBe("Updated");
  });

  it("returns the result of the mutation function", async () => {
    const { result } = await withProjectsMutation(tmpDir, (data) => {
      return (data.projects as any)["test-proj"].name as string;
    });
    expect(result).toBe("Test");
  });

  it("applies mutation atomically — no partial writes", async () => {
    // Multiple mutations in sequence should each increment _seq
    await withProjectsMutation(tmpDir, (data) => { (data.projects as any)["test-proj"].name = "A"; });
    await withProjectsMutation(tmpDir, (data) => { (data.projects as any)["test-proj"].name = "B"; });

    const raw = await fs.readFile(path.join(tmpDir, DATA_DIR, "projects.json"), "utf-8");
    const final = JSON.parse(raw);
    expect(final._seq).toBe(3); // started at 1, two mutations
    expect(final.projects["test-proj"].name).toBe("B");
  });
});
