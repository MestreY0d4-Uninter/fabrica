/**
 * observability/tracer.ts — OTel tracer singleton and withTelemetrySpan helper.
 *
 * Provides a simpler 2-argument variant of withTelemetrySpan for tick lifecycle
 * instrumentation (no correlation context or attribute bag needed at call sites).
 */
import { trace, context, SpanStatusCode } from "@opentelemetry/api";

const TRACER_NAME = "fabrica.heartbeat";

/** Run fn inside a new span, setting error status on exception. */
export async function withTelemetrySpan<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  const span = tracer.startSpan(name);
  return context.with(trace.setSpan(context.active(), span), async () => {
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}
