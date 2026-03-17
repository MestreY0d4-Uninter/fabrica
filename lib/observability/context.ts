import { AsyncLocalStorage } from "node:async_hooks";

export type CorrelationContext = {
  executionId?: string;
  sessionKey?: string;
  runId?: string;
  issueId?: string | number;
  prNumber?: number;
  headSha?: string;
  deliveryId?: string;
  checkRunId?: number;
  phase?: string;
};

const storage = new AsyncLocalStorage<CorrelationContext>();

function normalizeContext(ctx: CorrelationContext): CorrelationContext {
  return Object.fromEntries(
    Object.entries(ctx).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  ) as CorrelationContext;
}

export function createExecutionId(ctx: Partial<CorrelationContext>): string | undefined {
  return ctx.executionId
    ?? ctx.runId
    ?? ctx.sessionKey
    ?? ctx.deliveryId
    ?? (ctx.issueId !== undefined && ctx.issueId !== null ? `issue:${ctx.issueId}` : undefined);
}

export function getCorrelationContext(): CorrelationContext {
  return storage.getStore() ?? {};
}

export function withCorrelationContext<T>(ctx: Partial<CorrelationContext>, fn: () => T): T {
  const current = getCorrelationContext();
  const next = normalizeContext({
    ...current,
    ...ctx,
    executionId: createExecutionId({ ...current, ...ctx }),
  });
  return storage.run(next, fn);
}

export function correlationContextToAttributes(
  ctx: Partial<CorrelationContext>,
): Record<string, string | number | boolean> {
  const normalized = normalizeContext({
    ...ctx,
    executionId: createExecutionId(ctx),
  });
  return Object.fromEntries(
    Object.entries(normalized).map(([key, value]) => [key, typeof value === "number" ? value : String(value)]),
  );
}
