import { describe, expect, it, vi } from "vitest";
import { registerGitHubWebhookRoute } from "../../lib/github/register-webhook-route.js";

describe("registerGitHubWebhookRoute", () => {
  it("registers the route when webhook config, secret, and workspace are available", () => {
    vi.stubEnv("FABRICA_GITHUB_WEBHOOK_SECRET", "supersecret");

    const registerHttpRoute = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    registerGitHubWebhookRoute({
      registerHttpRoute,
      logger,
    } as any, {
      pluginConfig: {
        providers: {
          github: {
            webhookPath: "/plugins/fabrica/github/webhook",
            webhookSecretEnv: "FABRICA_GITHUB_WEBHOOK_SECRET",
          },
        },
      },
      runtime: {
        config: {
          loadConfig: () => ({
            agents: {
              defaults: {
                workspace: "/tmp/fabrica-workspace",
              },
            },
          }),
        },
      },
    } as any);

    expect(registerHttpRoute).toHaveBeenCalledTimes(1);
    expect(registerHttpRoute.mock.calls[0]?.[0]).toMatchObject({
      path: "/plugins/fabrica/github/webhook",
      auth: "plugin",
      match: "exact",
    });
    vi.unstubAllEnvs();
  });

  it("registers the route when the webhook secret comes from direct plugin config", () => {
    vi.unstubAllEnvs();

    const registerHttpRoute = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    registerGitHubWebhookRoute({
      registerHttpRoute,
      logger,
    } as any, {
      pluginConfig: {
        providers: {
          github: {
            webhookPath: "/plugins/fabrica/github/webhook",
            webhookSecret: "configured-secret",
          },
        },
      },
      runtime: {
        config: {
          loadConfig: () => ({
            agents: {
              defaults: {
                workspace: "/tmp/fabrica-workspace",
              },
            },
          }),
        },
      },
      logger,
    } as any);

    expect(registerHttpRoute).toHaveBeenCalledTimes(1);
  });

  it("skips registration when the secret env is missing", () => {
    vi.unstubAllEnvs();

    const registerHttpRoute = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const originalArgv = process.argv.slice();
    process.argv = ["node", "openclaw", "plugins", "doctor"];

    registerGitHubWebhookRoute({
      registerHttpRoute,
      logger,
    } as any, {
      pluginConfig: {
        providers: {
          github: {
            webhookSecretEnv: "FABRICA_GITHUB_WEBHOOK_SECRET",
          },
        },
      },
      runtime: {
        config: {
          loadConfig: () => ({
            agents: {
              defaults: {
                workspace: "/tmp/fabrica-workspace",
              },
            },
          }),
        },
      },
    } as any);

    expect(registerHttpRoute).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalled();
    process.argv = originalArgv;
  });

  it("warns when the secret env is missing during gateway runtime", () => {
    vi.unstubAllEnvs();

    const registerHttpRoute = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const originalArgv = process.argv.slice();
    process.argv = ["node", "openclaw", "gateway", "--port", "18789"];

    registerGitHubWebhookRoute({
      registerHttpRoute,
      logger,
    } as any, {
      pluginConfig: {
        providers: {
          github: {
            webhookSecretEnv: "FABRICA_GITHUB_WEBHOOK_SECRET",
          },
        },
      },
      runtime: {
        config: {
          loadConfig: () => ({
            agents: {
              defaults: {
                workspace: "/tmp/fabrica-workspace",
              },
            },
          }),
        },
      },
    } as any);

    expect(registerHttpRoute).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
    process.argv = originalArgv;
  });
});
