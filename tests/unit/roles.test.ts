/**
 * Unit tests for the role registry and selectors.
 */
import { describe, it, expect } from "vitest";
import { ROLE_REGISTRY } from "../../lib/roles/registry.js";
import {
  getAllRoleIds,
  isValidRole,
  getRole,
  requireRole,
  getLevelsForRole,
  getDefaultLevel,
  getDefaultModel,
  getAllDefaultModels,
  resolveModel,
  getEmoji,
  getFallbackEmoji,
  getCompletionResults,
  isValidResult,
  isNotificationEnabled,
  getSessionKeyRolePattern,
  getAllLevels,
  isLevelForRole,
  roleForLevel,
} from "../../lib/roles/selectors.js";

// ---------------------------------------------------------------------------
// Registry structure
// ---------------------------------------------------------------------------

describe("role registry", () => {
  it("has 4 roles", () => {
    expect(Object.keys(ROLE_REGISTRY)).toHaveLength(4);
  });

  it("all roles have required fields", () => {
    for (const [id, config] of Object.entries(ROLE_REGISTRY)) {
      expect(config.id).toBe(id);
      expect(config.displayName).toBeTruthy();
      expect(config.levels.length).toBeGreaterThan(0);
      expect(config.defaultLevel).toBeTruthy();
      expect(config.levels).toContain(config.defaultLevel);
      expect(Object.keys(config.models).length).toBeGreaterThan(0);
      expect(config.completionResults.length).toBeGreaterThan(0);
      expect(config.sessionKeyPattern).toBeTruthy();
      expect(config.fallbackEmoji).toBeTruthy();
    }
  });

  it("every level has a model", () => {
    for (const config of Object.values(ROLE_REGISTRY)) {
      for (const level of config.levels) {
        expect(config.models[level]).toBeTruthy();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Selectors — role IDs
// ---------------------------------------------------------------------------

describe("role selectors — IDs", () => {
  it("getAllRoleIds returns all 4", () => {
    const ids = getAllRoleIds();
    expect(ids).toEqual(expect.arrayContaining(["developer", "tester", "architect", "reviewer"]));
    expect(ids).toHaveLength(4);
  });

  it("isValidRole true for known roles", () => {
    expect(isValidRole("developer")).toBe(true);
    expect(isValidRole("tester")).toBe(true);
  });

  it("isValidRole false for unknown roles", () => {
    expect(isValidRole("janitor")).toBe(false);
    expect(isValidRole("")).toBe(false);
  });

  it("getRole returns config for known role", () => {
    const role = getRole("developer");
    expect(role).toBeDefined();
    expect(role!.displayName).toBe("DEVELOPER");
  });

  it("getRole returns undefined for unknown", () => {
    expect(getRole("janitor")).toBeUndefined();
  });

  it("requireRole throws for unknown", () => {
    expect(() => requireRole("janitor")).toThrow(/Unknown role/);
  });

  it("requireRole returns config for known", () => {
    expect(requireRole("tester").id).toBe("tester");
  });
});

// ---------------------------------------------------------------------------
// Selectors — levels
// ---------------------------------------------------------------------------

describe("role selectors — levels", () => {
  it("developer has 3 levels", () => {
    expect(getLevelsForRole("developer")).toEqual(["junior", "medior", "senior"]);
  });

  it("architect has 2 levels", () => {
    expect(getLevelsForRole("architect")).toEqual(["junior", "senior"]);
  });

  it("unknown role returns empty array", () => {
    expect(getLevelsForRole("janitor")).toEqual([]);
  });

  it("getDefaultLevel returns correct defaults", () => {
    expect(getDefaultLevel("developer")).toBe("medior");
    expect(getDefaultLevel("architect")).toBe("junior");
  });

  it("getAllLevels returns all levels across roles", () => {
    const all = getAllLevels();
    expect(all).toContain("junior");
    expect(all).toContain("medior");
    expect(all).toContain("senior");
  });

  it("isLevelForRole validates correctly", () => {
    expect(isLevelForRole("junior", "developer")).toBe(true);
    expect(isLevelForRole("medior", "architect")).toBe(false);
  });

  it("roleForLevel finds the role", () => {
    // junior exists in multiple roles, should return the first match
    const role = roleForLevel("junior");
    expect(role).toBeTruthy();
    expect(isValidRole(role!)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Selectors — models
// ---------------------------------------------------------------------------

describe("role selectors — models", () => {
  it("getDefaultModel returns model string", () => {
    const model = getDefaultModel("developer", "junior");
    expect(model).toBe("openai-codex/gpt-5.3-codex-spark");
  });

  it("getDefaultModel returns undefined for unknown level", () => {
    expect(getDefaultModel("developer", "expert")).toBeUndefined();
  });

  it("getAllDefaultModels returns nested structure", () => {
    const all = getAllDefaultModels();
    expect(all.developer).toBeDefined();
    expect(all.developer.junior).toBe("openai-codex/gpt-5.3-codex-spark");
    expect(all.tester).toBeDefined();
    expect(all.reviewer).toBeDefined();
    expect(all.architect).toBeDefined();
  });

  it("resolveModel uses registry default when no config", () => {
    const model = resolveModel("developer", "junior");
    expect(model).toBe("openai-codex/gpt-5.3-codex-spark");
  });

  it("resolveModel uses resolved config when available", () => {
    const resolved = {
      levels: ["junior", "medior", "senior"],
      defaultLevel: "medior",
      models: { junior: "custom/model-x", medior: "custom/model-y", senior: "custom/model-z" },
      emoji: {},
      completionResults: ["done"],
      enabled: true,
      levelMaxWorkers: { junior: 2, medior: 2, senior: 2 },
    };
    expect(resolveModel("developer", "junior", resolved)).toBe("custom/model-x");
  });

  it("resolveModel passes through unknown level as model ID", () => {
    expect(resolveModel("developer", "some-custom-model")).toBe("some-custom-model");
  });
});

// ---------------------------------------------------------------------------
// Selectors — emoji
// ---------------------------------------------------------------------------

describe("role selectors — emoji", () => {
  it("getEmoji returns level-specific emoji", () => {
    expect(getEmoji("developer", "senior")).toBe("\u{1F9E0}");
  });

  it("getEmoji returns undefined for unknown level", () => {
    expect(getEmoji("developer", "expert")).toBeUndefined();
  });

  it("getFallbackEmoji returns role fallback", () => {
    expect(getFallbackEmoji("developer")).toBe("\u{1F527}");
    expect(getFallbackEmoji("unknown")).toBe("\u{1F4CB}");
  });
});

// ---------------------------------------------------------------------------
// Selectors — completion
// ---------------------------------------------------------------------------

describe("role selectors — completion", () => {
  it("developer has done and blocked", () => {
    expect(getCompletionResults("developer")).toEqual(["done", "blocked"]);
  });

  it("tester has pass, fail, refine, blocked", () => {
    expect(getCompletionResults("tester")).toEqual(["pass", "fail", "refine", "blocked"]);
  });

  it("reviewer has approve, reject, blocked", () => {
    expect(getCompletionResults("reviewer")).toEqual(["approve", "reject", "blocked"]);
  });

  it("isValidResult checks correctly", () => {
    expect(isValidResult("developer", "done")).toBe(true);
    expect(isValidResult("developer", "approve")).toBe(false);
    expect(isValidResult("tester", "pass")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Selectors — session keys
// ---------------------------------------------------------------------------

describe("role selectors — session keys", () => {
  it("pattern matches all role session keys", () => {
    const pattern = getSessionKeyRolePattern();
    expect(pattern).toContain("developer");
    expect(pattern).toContain("tester");
    expect(pattern).toContain("architect");
    expect(pattern).toContain("reviewer");
  });
});

// ---------------------------------------------------------------------------
// Selectors — notifications
// ---------------------------------------------------------------------------

describe("role selectors — notifications", () => {
  it("all roles have onStart enabled", () => {
    for (const role of getAllRoleIds()) {
      expect(isNotificationEnabled(role, "onStart")).toBe(true);
    }
  });

  it("all roles have onComplete enabled", () => {
    for (const role of getAllRoleIds()) {
      expect(isNotificationEnabled(role, "onComplete")).toBe(true);
    }
  });

  it("unknown role defaults to true", () => {
    expect(isNotificationEnabled("unknown", "onStart")).toBe(true);
  });
});
