import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chooseEffectiveModel, resolveEffectiveModelForGateway } from "../../lib/roles/model-fetcher.js";

describe("chooseEffectiveModel", () => {
  it("keeps the requested model when it is available", () => {
    const result = chooseEffectiveModel("openai-codex/gpt-5.3-codex", [
      "openai-codex/gpt-5.3-codex",
      "anthropic/claude-sonnet-4.5",
    ]);

    expect(result.effective).toBe("openai-codex/gpt-5.3-codex");
    expect(result.downgraded).toBe(false);
  });

  it("downgrades to an allowed model from the same provider first", () => {
    const result = chooseEffectiveModel("openai-codex/gpt-5.4", [
      "openai-codex/gpt-5.3-codex",
      "anthropic/claude-sonnet-4.5",
    ]);

    expect(result.effective).toBe("openai-codex/gpt-5.3-codex");
    expect(result.downgraded).toBe(true);
    expect(result.reason).toBe("same_provider_fallback");
  });

  it("falls back to the first available model when the provider is unavailable", () => {
    const result = chooseEffectiveModel("openai-codex/gpt-5.4", [
      "anthropic/claude-sonnet-4.5",
      "openai/gpt-5-mini",
    ]);

    expect(result.effective).toBe("anthropic/claude-sonnet-4.5");
    expect(result.downgraded).toBe(true);
    expect(result.reason).toBe("first_available_fallback");
  });
});

describe("resolveEffectiveModelForGateway", () => {
  const originalOpenClawHome = process.env.OPENCLAW_HOME;
  let tempOpenClawHome: string | null = null;

  afterEach(async () => {
    if (originalOpenClawHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = originalOpenClawHome;
    if (tempOpenClawHome) {
      await fs.rm(tempOpenClawHome, { recursive: true, force: true });
      tempOpenClawHome = null;
    }
  });

  it("falls back to the configured gateway allowlist when model discovery is unavailable", async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-openclaw-home-"));
    tempOpenClawHome = codexHome;
    process.env.OPENCLAW_HOME = codexHome;
    await fs.writeFile(
      path.join(codexHome, "openclaw.json"),
      JSON.stringify({
        agents: {
          defaults: {
            model: {
              primary: "openai-codex/gpt-5.3-codex",
              fallbacks: ["github-copilot/claude-sonnet-4.6"],
            },
            models: {
              "openai-codex/gpt-5.3-codex": {},
              "github-copilot/claude-sonnet-4.6": {},
            },
          },
        },
      }),
      "utf-8",
    );

    const resolution = await resolveEffectiveModelForGateway(
      "openai-codex/gpt-5.4",
      async () => {
        throw new Error("openclaw unavailable");
      },
    );

    expect(resolution.effective).toBe("openai-codex/gpt-5.3-codex");
    expect(resolution.downgraded).toBe(true);
  });
});
