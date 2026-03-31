import { describe, it, expect } from "vitest";
import { findRuntimeBoundaryViolations } from "../../scripts/verify-runtime-boundary.mjs";

describe("verify-runtime-boundary script", () => {
  it("detects side-effect imports to openclaw/plugin-sdk", () => {
    const bundle = `
      import "openclaw/plugin-sdk";
      export const ok = true;
    `;
    const found = findRuntimeBoundaryViolations(bundle);
    expect(found).toContain('import "openclaw/plugin-sdk";');
  });

  it("returns no violations for safe bundle text", () => {
    const found = findRuntimeBoundaryViolations('import { x } from "./local.js";');
    expect(found).toEqual([]);
  });
});
