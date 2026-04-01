import { afterEach, describe, expect, it, vi } from "vitest";

function makeLogger() {
  const logger = {
    child: vi.fn(() => logger),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

function makeApi(overrides: Record<string, unknown> = {}) {
  return {
    config: {},
    logger: makeLogger(),
    pluginConfig: {},
    registerCli: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerService: vi.fn(),
    registerTool: vi.fn(),
    registerHook: vi.fn(),
    on: vi.fn(),
    runtime: {
      config: {
        loadConfig: vi.fn(() => ({
          agents: {
            defaults: {
              workspace: "/tmp/fabrica-workspace",
            },
          },
        })),
      },
      system: {
        runCommandWithTimeout: vi.fn(),
      },
    },
    ...overrides,
  } as any;
}

describe("plugin registration logging calibration", () => {
  const originalArgv = process.argv.slice();

  afterEach(() => {
    process.argv = originalArgv.slice();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("keeps the plugin startup banner off info level in CLI mode", async () => {
    process.argv = ["node", "openclaw", "configure"];

    const logger = makeLogger();

    vi.resetModules();
    vi.doMock("../../lib/observability/bootstrap.js", () => ({}));
    vi.doMock("../../lib/observability/logger.js", () => ({
      getLogger: vi.fn(() => logger),
      getRootLogger: vi.fn(() => logger),
    }));

    try {
      const plugin = (await import("../../index.js")).default;
      plugin.register(makeApi({ logger }));

      expect(logger.info).not.toHaveBeenCalledWith(
        expect.stringContaining("Fabrica plugin registered"),
      );
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining("Fabrica plugin registered"),
      );
    } finally {
      vi.doUnmock("../../lib/observability/bootstrap.js");
      vi.doUnmock("../../lib/observability/logger.js");
      vi.resetModules();
    }
  }, 15000);

  it("keeps polling-only webhook notices off info and warn level in CLI mode", async () => {
    process.argv = ["node", "openclaw", "configure"];

    const logger = makeLogger();
    const registerHttpRoute = vi.fn();

    const { registerGitHubWebhookRoute } = await import("../../lib/github/register-webhook-route.js");

    registerGitHubWebhookRoute(
      {
        registerHttpRoute,
        logger,
      } as any,
      {
        pluginConfig: {
          providers: {
            github: {},
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
      } as any,
    );

    expect(registerHttpRoute).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("running in polling-only mode"),
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("running in polling-only mode"),
    );
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("running in polling-only mode"),
    );
  });

  it("preserves gateway info logging for plugin registration and webhook route setup", async () => {
    process.argv = ["node", "openclaw", "gateway", "--port", "18789"];
    vi.stubEnv("FABRICA_GITHUB_WEBHOOK_SECRET", "supersecret");

    const logger = makeLogger();
    const registerHttpRoute = vi.fn();

    const { registerGitHubWebhookRoute } = await import("../../lib/github/register-webhook-route.js");

    registerGitHubWebhookRoute(
      {
        registerHttpRoute,
        logger,
      } as any,
      {
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
      } as any,
    );

    expect(registerHttpRoute).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("GitHub webhook route registered"),
    );
  });
});
