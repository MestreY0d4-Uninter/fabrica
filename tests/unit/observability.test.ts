import { Writable } from "node:stream";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { withCorrelationContext } from "../../lib/observability/context.js";
import { createFabricaLogger } from "../../lib/observability/logger.js";
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
});
