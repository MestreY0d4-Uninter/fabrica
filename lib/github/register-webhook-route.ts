import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginContext } from "../context.js";
import { createGitHubStores } from "./store-factory.js";
import { createGitHubWebhookHandler } from "./webhook.js";
import { processPendingGitHubEventsForWorkspace } from "./process-events.js";
import { getLifecycleService } from "../machines/lifecycle-service.js";
import { isGatewayServerProcess } from "../runtime-mode.js";
import { resolveGitHubWebhookSecret } from "./config-credentials.js";

type GitHubWebhookPluginConfig = {
  providers?: {
    github?: {
      webhookPath?: string;
      webhookSecretEnv?: string;
      webhookMode?: "required" | "optional" | "disabled";
    };
  };
};

function getDefaultWorkspaceDir(ctx: PluginContext): string | undefined {
  try {
    const config = ctx.runtime.config.loadConfig();
    return (config as any).agents?.defaults?.workspace ?? undefined;
  } catch {
    return undefined;
  }
}

function getWebhookConfig(pluginConfig: Record<string, unknown> | undefined): {
  webhookPath?: string;
  webhookSecretEnv?: string;
} {
  return ((pluginConfig as GitHubWebhookPluginConfig | undefined)?.providers?.github ?? {});
}

export function getWebhookMode(pluginConfig: Record<string, unknown> | undefined): "required" | "optional" | "disabled" {
  return (pluginConfig as GitHubWebhookPluginConfig | undefined)?.providers?.github?.webhookMode ?? "optional";
}

export function registerGitHubWebhookRoute(api: OpenClawPluginApi, ctx: PluginContext): void {
  const logger = ctx.logger ?? api.logger;
  const routeLogger = "child" in logger ? logger.child({ phase: "github-route" }) : logger;

  // Check webhookMode first — "disabled" exits immediately
  const mode = getWebhookMode(ctx.pluginConfig);
  if (mode === "disabled") {
    routeLogger.info?.("GitHub webhook route disabled by configuration (webhookMode: disabled)");
    return;
  }

  const { webhookPath = "/plugins/fabrica/github/webhook", webhookSecretEnv } = getWebhookConfig(ctx.pluginConfig);
  const secret = resolveGitHubWebhookSecret(ctx.pluginConfig);

  if (!secret) {
    if (mode === "required") {
      // Throw to fail startup — operator explicitly requires webhook
      throw new Error(
        webhookSecretEnv
          ? `GitHub webhook secret is required but unresolved (env ${webhookSecretEnv} not available)`
          : "GitHub webhook secret is required but not configured (set webhookMode to 'optional' to allow polling-only)",
      );
    }
    // mode === "optional" (default): log and return gracefully
    const message = webhookSecretEnv
      ? `GitHub webhook route not registered: webhook secret is unresolved (legacy env ${webhookSecretEnv} not available)`
      : "GitHub webhook route not registered: running in polling-only mode (set providers.github.webhookSecret to enable webhooks)";
    if (isGatewayServerProcess()) {
      routeLogger.warn?.(message);
    } else {
      routeLogger.debug?.(message) ?? routeLogger.info?.(message);
    }
    return;
  }

  const workspaceDir = getDefaultWorkspaceDir(ctx);
  if (!workspaceDir) {
    routeLogger.warn?.("GitHub webhook route not registered: no default workspace configured");
    return;
  }

  const drainState = new Map<string, { running: boolean; rerun: boolean }>();
  const scheduleDrain = (workspaceDir: string) => {
    const state = drainState.get(workspaceDir);
    if (state?.running) {
      state.rerun = true;
      return;
    }
    drainState.set(workspaceDir, { running: true, rerun: false });
    setTimeout(async () => {
      try {
        while (true) {
          const current = drainState.get(workspaceDir);
          if (!current) break;
          current.rerun = false;
          await processPendingGitHubEventsForWorkspace({
            workspaceDir,
            pluginConfig: ctx.pluginConfig,
            logger: "child" in routeLogger ? routeLogger.child({ workspaceDir, phase: "github-drain" }) : routeLogger,
          });
          if (!current.rerun) break;
        }
      } catch (error) {
        routeLogger.warn?.(
          `GitHub webhook queue drain failed for ${workspaceDir}: ${(error as Error).message}`,
        );
      } finally {
        drainState.delete(workspaceDir);
      }
    }, 0);
  };

  api.registerHttpRoute({
    path: webhookPath,
    // GitHub must reach this endpoint without the gateway token; request
    // authenticity is enforced by the webhook signature inside the handler.
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      const lifecycle = await getLifecycleService(workspaceDir, logger);
      return lifecycle.track("webhook", {
        deliveryId: typeof req.headers["x-github-delivery"] === "string" ? req.headers["x-github-delivery"] : null,
      }, async () => {
        const { eventStore, backend } = await createGitHubStores(workspaceDir, {
          logger: "child" in routeLogger ? routeLogger.child({ workspaceDir, phase: "github-store" }) : routeLogger,
        });
        const handled = await createGitHubWebhookHandler({
          workspaceDir,
          secret,
          store: eventStore,
          onAccepted: async () => {
            scheduleDrain(workspaceDir);
          },
          logger: "child" in routeLogger ? routeLogger.child({ workspaceDir, phase: "github-webhook" }) : routeLogger,
        })(req, res);
        if ("child" in routeLogger) {
          routeLogger.child({ workspaceDir, backend }).info("GitHub webhook route resolved store backend");
        }

        if (!handled && !res.headersSent) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Not Found");
        }
        return true;
      });
    },
  });

  if ("child" in routeLogger) {
    const registrationLogger = routeLogger.child({ webhookPath: path.posix.normalize(webhookPath), workspaceDir });
    if (isGatewayServerProcess()) {
      registrationLogger.info("GitHub webhook route registered");
    } else {
      registrationLogger.debug?.("GitHub webhook route registered");
    }
  }
}
