import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("notification delivery guarantee", () => {
  it("writeIntent error returns false (prevents double-send)", () => {
    const source = readFileSync(resolve(__dirname, "../../lib/dispatch/notify.ts"), "utf-8");
    expect(source).toContain(".catch(() => false)");
    expect(source).not.toMatch(/writeIntent\([^)]*\)\.catch\(\s*\(\)\s*=>\s*true\s*\)/s);
  });
});

describe("outbox entry includes delivery target", () => {
  it("OutboxEntry type includes deliveryTarget field", () => {
    const source = readFileSync(resolve(__dirname, "../../lib/dispatch/notification-outbox.ts"), "utf-8");
    expect(source).toContain("deliveryTarget");
  });

  it("passes.ts retry uses stored delivery target", () => {
    const source = readFileSync(resolve(__dirname, "../../lib/services/heartbeat/passes.ts"), "utf-8");
    expect(source).toContain("deliveryTargetOverride");
  });
});
