import { afterEach, describe, expect, it, vi } from "vitest";
import { writePluginConfig } from "../../lib/setup/config.js";

afterEach(() => {
  delete process.env.FABRICA_PROJECTS_CHANNEL_ID;
  delete process.env.FABRICA_PROJECTS_CHANNEL_ACCOUNT_ID;
  delete process.env.TELEGRAM_CHAT_ID;
});

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
    expect(config.plugins.entries.fabrica.config.telegram.bootstrapDmEnabled).toBe(true);
  });

  it("hydrates telegram forum defaults from environment when setup writes plugin config", async () => {
    process.env.FABRICA_PROJECTS_CHANNEL_ID = "-1003709213169";
    process.env.FABRICA_PROJECTS_CHANNEL_ACCOUNT_ID = "telegram-account-1";
    process.env.TELEGRAM_CHAT_ID = "-100999999";

    const written: any[] = [];
    const runtime = {
      config: {
        loadConfig: () => ({
          plugins: {
            allow: [],
            entries: {
              fabrica: {
                config: {},
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

    const config = written[0];
    expect(config.plugins.entries.fabrica.config.telegram).toEqual(expect.objectContaining({
      bootstrapDmEnabled: true,
      projectsForumChatId: "-1003709213169",
      projectsForumAccountId: "telegram-account-1",
      opsChatId: "-100999999",
    }));
  });
});
