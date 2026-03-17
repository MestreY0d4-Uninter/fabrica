import {
  SpanStatusCode,
  context as otelContext,
  trace,
  type Attributes,
  type Span,
} from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ConsoleSpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { correlationContextToAttributes, type CorrelationContext, withCorrelationContext } from "./context.js";
import { getRootLogger } from "./logger.js";
import { isExplicitCliTelemetryEnabled, isGatewayServerProcess } from "../runtime-mode.js";

const logger = getRootLogger().child({ component: "telemetry" });
const tracer = trace.getTracer("fabrica");

let sdkStarted = false;

function shouldBootstrapTelemetry(): boolean {
  if (process.env.OTEL_SDK_DISABLED === "true") return false;
  if (isExplicitCliTelemetryEnabled()) return true;
  return isGatewayServerProcess();
}

function sanitizeAttributes(
  attrs: Record<string, unknown>,
): Attributes {
  const entries = Object.entries(attrs).filter(([, value]) =>
    value !== undefined && value !== null && (typeof value === "string" || typeof value === "number" || typeof value === "boolean"),
  );
  return Object.fromEntries(entries) as Attributes;
}

function createSpanExporter() {
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    return new OTLPTraceExporter({
      url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    });
  }
  return new ConsoleSpanExporter();
}

export function bootstrapTelemetry(): void {
  if (sdkStarted || !shouldBootstrapTelemetry()) return;

  try {
    const sdk = new NodeSDK({
      spanProcessors: [new SimpleSpanProcessor(createSpanExporter())],
      instrumentations: [getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
      })],
    });
    void sdk.start();
    sdkStarted = true;
    logger.info("OpenTelemetry SDK started");
  } catch (error) {
    logger.warn({ err: error }, "OpenTelemetry SDK failed to start");
  }
}

export function recordSpanError(span: Span, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  span.recordException(error instanceof Error ? error : new Error(message));
  span.setStatus({ code: SpanStatusCode.ERROR, message });
}

export async function withTelemetrySpan<T>(
  name: string,
  attrs: Partial<CorrelationContext> & Record<string, unknown>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const correlation = correlationContextToAttributes(attrs);
  return withCorrelationContext(attrs, () =>
    tracer.startActiveSpan(name, { attributes: sanitizeAttributes({ ...correlation, ...attrs }) }, async (span) => {
      try {
        return await fn(span);
      } catch (error) {
        recordSpanError(span, error);
        throw error;
      } finally {
        span.end();
      }
    }));
}

export function getCurrentTraceIds(): { traceId?: string; spanId?: string } {
  const span = trace.getSpan(otelContext.active());
  const spanContext = span?.spanContext();
  return {
    traceId: spanContext?.traceId,
    spanId: spanContext?.spanId,
  };
}
