import { describe, it, expect } from "vitest";
import { validateConfig } from "../../lib/config/schema.js";

describe("effort config validation", () => {
  it("accepts valid effort levels in roles", () => {
    expect(() =>
      validateConfig({
        roles: {
          developer: { effort: { junior: "minimal", medior: "standard", senior: "deep" } },
        },
      }),
    ).not.toThrow();
  });

  it("rejects invalid effort level", () => {
    expect(() =>
      validateConfig({
        roles: {
          developer: { effort: { junior: "turbo" } },
        },
      }),
    ).toThrow();
  });

  it("accepts roles without effort (optional)", () => {
    expect(() =>
      validateConfig({
        roles: {
          developer: { models: { junior: "some/model" } },
        },
      }),
    ).not.toThrow();
  });
});
