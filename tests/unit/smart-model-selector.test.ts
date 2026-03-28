import { describe, it, expect, vi } from "vitest";
import { assignModels } from "../../lib/roles/smart-model-selector.js";

const rc = vi.fn().mockRejectedValue(new Error("no gateway"));

describe("assignModels — tier-based fallback", () => {
  it("resolves tiers for Anthropic-only models when LLM fails", async () => {
    const models = [
      { model: "anthropic/claude-haiku-4-5", provider: "anthropic", authenticated: true },
      { model: "anthropic/claude-sonnet-4-6", provider: "anthropic", authenticated: true },
      { model: "anthropic/claude-opus-4-6", provider: "anthropic", authenticated: true },
    ];
    const result = await assignModels(models, rc);
    expect(result).not.toBeNull();
    // developer junior = fast tier → haiku
    expect(result!.developer.junior).toBe("anthropic/claude-haiku-4-5");
    // developer senior = reasoning tier → opus
    expect(result!.developer.senior).toBe("anthropic/claude-opus-4-6");
  });

  it("falls back to first available when no tier matches", async () => {
    const models = [
      { model: "local/llama-70b", provider: "local", authenticated: true },
    ];
    const result = await assignModels(models, rc);
    expect(result).not.toBeNull();
    expect(result!.developer.junior).toBe("local/llama-70b");
  });
});
