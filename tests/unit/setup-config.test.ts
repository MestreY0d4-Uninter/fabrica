import { describe, expect, it, vi } from "vitest";
import { writePluginConfig } from "../../lib/setup/config.js";

describe("writePluginConfig", () => {
  it("enables fabrica and removes legacy devclaw config", async () => {
    const written: any[] = [];
    const runtime = {
      config: {
        loadConfig: () => ({
          plugins: {
            allow: ["devclaw"],
            entries: {
              devclaw: {
                enabled: true,
                config: {
                  models: { developer: "openai-codex/gpt-5.3-codex" },
                },
              },
              fabrica: {
                config: {
                  models: { developer: "legacy" },
                },
              },
            },
          },
          agents: {
            defaults: {},
          },
        }),
        writeConfigFile: vi.fn(async (config) => {
          written.push(config);
        }),
      },
    } as any;

    await writePluginConfig(runtime);

    expect(written).toHaveLength(1);
    const config = written[0];
    expect(config.plugins.entries.fabrica.enabled).toBe(true);
    expect(config.plugins.entries.fabrica.config.models).toBeUndefined();
    expect(config.plugins.entries.devclaw).toBeUndefined();
    expect(config.plugins.allow).toContain("fabrica");
    expect(config.plugins.allow).not.toContain("devclaw");
  });
});
