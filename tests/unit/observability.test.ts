import { Writable } from "node:stream";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { withCorrelationContext } from "../../lib/observability/context.js";
import { createFabricaLogger } from "../../lib/observability/logger.js";
import { registerGitHubWebhookRoute } from "../../lib/github/register-webhook-route.js";
import { withTelemetrySpan } from "../../lib/observability/telemetry.js";

const exporter = new InMemorySpanExporter();

beforeAll(() => {
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
});

afterEach(() => {
  exporter.reset();
});

describe("observability", () => {
  it("injects correlation IDs and redacts sensitive fields in logs", async () => {
    const entries: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        entries.push(chunk.toString());
        callback();
      },
    });
    const logger = createFabricaLogger(stream as any);

    await withCorrelationContext(
      {
        runId: "run-123",
        deliveryId: "delivery-123",
        issueId: 42,
        prNumber: 7,
        headSha: "abc123",
      },
      async () => {
        logger.info(
          {
            token: "top-secret",
            authorization: "Bearer hello",
          },
          "structured-log",
        );
      },
    );

    expect(entries).toHaveLength(1);
    const payload = JSON.parse(entries[0]!);
    expect(payload.runId).toBe("run-123");
    expect(payload.deliveryId).toBe("delivery-123");
    expect(payload.issueId).toBe(42);
    expect(payload.prNumber).toBe(7);
    expect(payload.headSha).toBe("abc123");
    expect(payload.executionId).toBe("run-123");
    expect(payload.token).toBe("[REDACTED]");
    expect(payload.authorization).toBe("[REDACTED]");
  });

  it("emits spans with correlation attributes", async () => {
    await withTelemetrySpan("fabrica.webhook.receive", {
      deliveryId: "delivery-otel",
      runId: "run-otel",
      issueId: "42",
      prNumber: 3,
      headSha: "deadbeef",
      phase: "github-webhook",
    }, async (span) => {
      expect(span.spanContext().traceId).toBeTruthy();
      expect(span.spanContext().spanId).toBeTruthy();
    });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("fabrica.webhook.receive");
    expect(spans[0]?.attributes.deliveryId).toBe("delivery-otel");
    expect(spans[0]?.attributes.runId).toBe("run-otel");
    expect(spans[0]?.attributes.issueId).toBe("42");
    expect(spans[0]?.attributes.prNumber).toBe(3);
    expect(spans[0]?.attributes.headSha).toBe("deadbeef");
  });

  it("keeps GitHub webhook route registration out of normal CLI info output", () => {
    const originalArgv = process.argv.slice();
    process.argv = ["node", "openclaw", "plugins", "doctor"];
    vi.stubEnv("FABRICA_GITHUB_WEBHOOK_SECRET", "supersecret");

    const registerHttpRoute = vi.fn();
    const childLogger = {
      child: vi.fn(() => childLogger),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const logger = {
      child: vi.fn(() => childLogger),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    try {
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
      expect(childLogger.info).not.toHaveBeenCalledWith(
        expect.stringContaining("GitHub webhook route registered"),
      );
      expect(childLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining("GitHub webhook route registered"),
      );
    } finally {
      process.argv = originalArgv;
      vi.unstubAllEnvs();
    }
  });

  it("keeps the plugin registration banner out of normal CLI info output", async () => {
    const originalArgv = process.argv.slice();
    process.argv = ["node", "openclaw", "plugins", "doctor"];

    const pluginInfo = vi.fn();
    const fakeLogger = {
      child: vi.fn().mockReturnThis(),
      debug: vi.fn(),
      error: vi.fn(),
      info: pluginInfo,
      warn: vi.fn(),
    };

    try {
      vi.resetModules();
      vi.doMock("../../lib/observability/bootstrap.js", () => ({
        bootstrapTelemetry: vi.fn(),
      }));
      vi.doMock("../../lib/observability/logger.js", async () => {
        const actual = await vi.importActual<typeof import("../../lib/observability/logger.js")>(
          "../../lib/observability/logger.js",
        );
        return {
          ...actual,
          getLogger: vi.fn(() => fakeLogger),
          getRootLogger: vi.fn(() => fakeLogger),
        };
      });
      vi.doMock("../../lib/github/register-webhook-route.js", () => ({
        registerGitHubWebhookRoute: vi.fn(),
      }));

      const plugin = (await import("../../index.js")).default;
      const api = {
        config: {},
        logger: fakeLogger,
        on: vi.fn(),
        pluginConfig: {},
        registerCli: vi.fn(),
        registerHttpRoute: vi.fn(),
        registerService: vi.fn(),
        registerTool: vi.fn(),
        registerHook: vi.fn(),
        runtime: {
          config: {
            loadConfig: vi.fn(() => ({
              agents: {
                list: [],
              },
            })),
          },
          system: {
            runCommandWithTimeout: vi.fn(),
          },
        },
      } as any;

      plugin.register(api);

      expect(pluginInfo).not.toHaveBeenCalledWith(
        expect.stringContaining("Fabrica plugin registered"),
      );
    } finally {
      process.argv = originalArgv;
      vi.resetModules();
    }
  });
});
