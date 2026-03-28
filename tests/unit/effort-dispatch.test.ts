import { describe, it, expect } from "vitest";
import { buildEffortPrompt, EFFORT_PROMPTS } from "../../lib/dispatch/session.js";

describe("buildEffortPrompt", () => {
  it("returns effort prefix for deep level", () => {
    const result = buildEffortPrompt("deep", "You are a developer.");
    expect(result).toContain(EFFORT_PROMPTS.deep);
    expect(result).toContain("You are a developer.");
  });

  it("returns effort prefix before role instructions", () => {
    const result = buildEffortPrompt("minimal", "Role instructions here.");
    const effortIdx = result.indexOf(EFFORT_PROMPTS.minimal);
    const roleIdx = result.indexOf("Role instructions here.");
    expect(effortIdx).toBeLessThan(roleIdx);
  });

  it("returns just role instructions when effort is undefined", () => {
    const result = buildEffortPrompt(undefined, "Role instructions here.");
    expect(result).toBe("Role instructions here.");
  });

  it("returns just effort prompt when no role instructions", () => {
    const result = buildEffortPrompt("standard", undefined);
    expect(result).toBe(EFFORT_PROMPTS.standard);
  });
});
