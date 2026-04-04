import pino, { type Logger as PinoLogger, stdSerializers } from "pino";
import pinoPretty from "pino-pretty";
import { context as otelContext, trace } from "@opentelemetry/api";
import { createExecutionId, getCorrelationContext } from "./context.js";

export type FabricaLogger = PinoLogger;

let prettyFallbackWarned = false;

function warnPrettyFallback(error: unknown) {
  if (prettyFallbackWarned) return;
  prettyFallbackWarned = true;
  const reason = error instanceof Error ? error.message : String(error);
  console.warn(`[fabrica] pretty logging unavailable, falling back to structured logs: ${reason}`);
}

function createDestination(destination?: pino.DestinationStream) {
  if (destination) return destination;
  if (process.env.LOG_PRETTY !== "1") return undefined;

  try {
    return pinoPretty({
      colorize: true,
      translateTime: "SYS:standard",
      ignore: "pid,hostname",
    });
  } catch (error) {
    warnPrettyFallback(error);
    return undefined;
  }
}

export function createFabricaLogger(destination?: pino.DestinationStream): FabricaLogger {
  const resolvedDestination = createDestination(destination);
  return pino({
  name: "fabrica",
  level: process.env.LOG_LEVEL ?? "info",
  serializers: {
    err: stdSerializers.err,
    error: stdSerializers.err,
    req(value: any) {
      if (!value) return value;
      return {
        method: value.method,
        url: value.url,
        headers: value.headers,
      };
    },
    res(value: any) {
      if (!value) return value;
      return {
        statusCode: value.statusCode,
      };
    },
  },
  redact: {
    paths: [
      "authorization",
      "headers.authorization",
      "req.headers.authorization",
      "token",
      "access_token",
      "refresh_token",
      "secret",
      "webhookSecret",
      "privateKey",
    ],
    censor: "[REDACTED]",
  },
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  mixin() {
    const bindings = getCorrelationContext();
    const activeSpan = trace.getSpan(otelContext.active());
    const spanContext = activeSpan?.spanContext();
    return {
      ...bindings,
      executionId: createExecutionId(bindings),
      traceId: spanContext?.traceId,
      spanId: spanContext?.spanId,
    };
  },
  }, resolvedDestination);
}

const rootLogger = createFabricaLogger();

export function getRootLogger(): FabricaLogger {
  return rootLogger;
}

export function getLogger(bindings?: Record<string, unknown>): FabricaLogger {
  return bindings ? rootLogger.child(bindings) : rootLogger;
}
