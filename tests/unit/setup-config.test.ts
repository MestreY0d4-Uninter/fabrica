import { describe, expect, it, vi } from "vitest";
import { writePluginConfig } from "../../lib/setup/config.js";

describe("writePluginConfig", () => {
  it("enables fabrica and cleans up legacy models config", async () => {
    const written: any[] = [];
    const runtime = {
      config: {
        loadConfig: () => ({
          plugins: {
            allow: [],
            entries: {
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
    expect(config.plugins.allow).toContain("fabrica");
  });
});
