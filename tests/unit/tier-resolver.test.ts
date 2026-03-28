import { describe, it, expect } from "vitest";
import { resolveModelForTier, KNOWN_MODEL_TIERS } from "../../lib/roles/tier-resolver.js";

const openaiModels = [
  { model: "openai-codex/gpt-5.3-codex-spark", provider: "openai-codex" },
  { model: "openai-codex/gpt-5.3-codex", provider: "openai-codex" },
  { model: "openai-codex/gpt-5.4", provider: "openai-codex" },
];

const anthropicModels = [
  { model: "anthropic/claude-haiku-4-5", provider: "anthropic" },
  { model: "anthropic/claude-sonnet-4-6", provider: "anthropic" },
  { model: "anthropic/claude-opus-4-6", provider: "anthropic" },
];

describe("resolveModelForTier", () => {
  it("resolves fast → spark for OpenAI-only", () => {
    expect(resolveModelForTier("fast", openaiModels)).toBe("openai-codex/gpt-5.3-codex-spark");
  });
  it("resolves balanced → codex for OpenAI-only", () => {
    expect(resolveModelForTier("balanced", openaiModels)).toBe("openai-codex/gpt-5.3-codex");
  });
  it("resolves reasoning → gpt-5.4 for OpenAI-only", () => {
    expect(resolveModelForTier("reasoning", openaiModels)).toBe("openai-codex/gpt-5.4");
  });
  it("resolves fast → haiku for Anthropic-only", () => {
    expect(resolveModelForTier("fast", anthropicModels)).toBe("anthropic/claude-haiku-4-5");
  });
  it("resolves balanced → sonnet for Anthropic-only", () => {
    expect(resolveModelForTier("balanced", anthropicModels)).toBe("anthropic/claude-sonnet-4-6");
  });
  it("resolves reasoning → opus for Anthropic-only", () => {
    expect(resolveModelForTier("reasoning", anthropicModels)).toBe("anthropic/claude-opus-4-6");
  });
  it("returns undefined when no model matches tier", () => {
    const unknownModels = [{ model: "local/llama-70b", provider: "local" }];
    expect(resolveModelForTier("fast", unknownModels)).toBeUndefined();
  });
  it("uses regex fallback for unknown models", () => {
    const futureModels = [{ model: "google/gemini-3.0-flash-lite", provider: "google" }];
    expect(resolveModelForTier("fast", futureModels)).toBe("google/gemini-3.0-flash-lite");
  });
  it("known map takes priority over regex match", () => {
    // spark contains "spark" (regex fast) and "codex" (regex balanced)
    // known map resolves spark as "fast" and codex as "balanced"
    const models = [
      { model: "openai-codex/gpt-5.3-codex-spark", provider: "openai-codex" },
      { model: "openai-codex/gpt-5.3-codex", provider: "openai-codex" },
    ];
    expect(resolveModelForTier("fast", models)).toBe("openai-codex/gpt-5.3-codex-spark");
    expect(resolveModelForTier("balanced", models)).toBe("openai-codex/gpt-5.3-codex");
  });
});

describe("KNOWN_MODEL_TIERS", () => {
  it("maps all key models to correct tiers", () => {
    expect(KNOWN_MODEL_TIERS["openai-codex/gpt-5.3-codex-spark"]).toBe("fast");
    expect(KNOWN_MODEL_TIERS["openai-codex/gpt-5.3-codex"]).toBe("balanced");
    expect(KNOWN_MODEL_TIERS["openai-codex/gpt-5.4"]).toBe("reasoning");
    expect(KNOWN_MODEL_TIERS["anthropic/claude-haiku-4-5"]).toBe("fast");
    expect(KNOWN_MODEL_TIERS["anthropic/claude-sonnet-4-5"]).toBe("balanced");
    expect(KNOWN_MODEL_TIERS["anthropic/claude-sonnet-4-6"]).toBe("balanced");
    expect(KNOWN_MODEL_TIERS["anthropic/claude-opus-4-6"]).toBe("reasoning");
  });
});
