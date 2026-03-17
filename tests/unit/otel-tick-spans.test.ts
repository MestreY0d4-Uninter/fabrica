import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { withTelemetrySpan } from "../../lib/observability/tracer.js";

describe("tick OTel spans", () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();
  });

  afterEach(async () => {
    await provider.shutdown();
    exporter.reset();
  });

  it("creates nested spans: tick → project → pass", async () => {
    await withTelemetrySpan("heartbeat.tick", async () => {
      await withTelemetrySpan("heartbeat.project.test-proj", async () => {
        await withTelemetrySpan("heartbeat.pass.health", async () => {});
        await withTelemetrySpan("heartbeat.pass.review", async () => {});
      });
    });

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThanOrEqual(4);

    const tickSpan = spans.find((s) => s.name === "heartbeat.tick");
    const projectSpan = spans.find((s) => s.name === "heartbeat.project.test-proj");
    const healthSpan = spans.find((s) => s.name === "heartbeat.pass.health");

    expect(tickSpan).toBeDefined();
    expect(projectSpan).toBeDefined();
    expect(healthSpan).toBeDefined();

    // Verify parent-child relationship (SDK v2 uses parentSpanContext.spanId)
    const projectParentId = (projectSpan as any).parentSpanContext?.spanId ?? (projectSpan as any).parentSpanId;
    const healthParentId = (healthSpan as any).parentSpanContext?.spanId ?? (healthSpan as any).parentSpanId;

    expect(projectParentId).toBe(tickSpan!.spanContext().spanId);
    expect(healthParentId).toBe(projectSpan!.spanContext().spanId);
  });
});
