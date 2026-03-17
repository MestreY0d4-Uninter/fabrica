import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { GitHubEventStore } from "./event-store.js";
import { githubEventRecordSchema, type GitHubEventMetadata, type GitHubEventRecord } from "./types.js";
import { withCorrelationContext } from "../observability/context.js";
import { withTelemetrySpan } from "../observability/telemetry.js";

const webhookHeadersSchema = z.object({
  deliveryId: z.string().min(1),
  eventName: z.string().min(1),
  signature256: z.string().regex(/^sha256=/, "GitHub webhook signature must use sha256"),
});

const pullRequestPayloadSchema = z.object({
  installation: z.object({ id: z.number().int().positive() }).optional(),
  repository: z.object({ id: z.number().int().positive() }).optional(),
  pull_request: z.object({
    number: z.number().int().positive(),
    head: z.object({ sha: z.string().min(1) }),
  }).optional(),
});

export type IncomingGitHubWebhook = z.infer<typeof webhookHeadersSchema> & {
  body: string;
  receivedAt?: string;
};

export type WebhookAcceptance = {
  accepted: boolean;
  duplicate: boolean;
  record?: GitHubEventRecord;
  reason?: string;
};

export function verifyGitHubWebhookSignature(secret: string, body: string, signature256: string): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const actualBuffer = Buffer.from(signature256);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

export function extractGitHubEventMetadata(payload: unknown): GitHubEventMetadata {
  const parsed = pullRequestPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      installationId: null,
      repositoryId: null,
      prNumber: null,
      headSha: null,
    };
  }

  return {
    installationId: parsed.data.installation?.id ?? null,
    repositoryId: parsed.data.repository?.id ?? null,
    prNumber: parsed.data.pull_request?.number ?? null,
    headSha: parsed.data.pull_request?.head.sha ?? null,
  };
}

async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export async function receiveGitHubWebhook(
  store: GitHubEventStore,
  secret: string,
  input: IncomingGitHubWebhook,
): Promise<WebhookAcceptance> {
  const headers = webhookHeadersSchema.parse(input);
  if (!verifyGitHubWebhookSignature(secret, input.body, headers.signature256)) {
    return {
      accepted: false,
      duplicate: false,
      reason: "invalid_signature",
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(input.body);
  } catch {
    return {
      accepted: false,
      duplicate: false,
      reason: "invalid_json",
    };
  }

  const metadata = extractGitHubEventMetadata(payload);
  const record = githubEventRecordSchema.parse({
    deliveryId: headers.deliveryId,
    eventName: headers.eventName,
    action: typeof (payload as { action?: unknown }).action === "string"
      ? (payload as { action: string }).action
      : null,
    ...metadata,
    receivedAt: input.receivedAt ?? new Date().toISOString(),
    processedAt: null,
    status: "pending",
    payload,
    error: null,
  });

  const saved = await store.saveReceived(record);
  return {
    accepted: true,
    duplicate: saved.duplicate,
    record: saved.record,
  };
}

export function createGitHubWebhookHandler(params: {
  workspaceDir: string;
  secret: string;
  store: GitHubEventStore;
  onAccepted?: (record: GitHubEventRecord) => Promise<void> | void;
  logger?: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void; child?: (bindings: Record<string, unknown>) => any };
}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const { secret, store, onAccepted, logger } = params;
  return async (req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return true;
    }

    const deliveryId = req.headers["x-github-delivery"];
    const eventName = req.headers["x-github-event"];
    const signature256 = req.headers["x-hub-signature-256"];
    if (typeof deliveryId !== "string" || typeof eventName !== "string" || typeof signature256 !== "string") {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: false, reason: "missing_headers" }));
      return true;
    }

    const body = await readRawBody(req);
    const acceptance = await withCorrelationContext(
      {
        deliveryId,
        phase: "github-webhook",
      },
      () => withTelemetrySpan("fabrica.webhook.receive", {
        deliveryId,
        phase: "github-webhook",
        eventName,
      }, async () => receiveGitHubWebhook(store, secret, {
        deliveryId,
        eventName,
        signature256,
        body,
      })),
    );
    const requestLogger = typeof logger?.child === "function"
      ? logger.child({ deliveryId, eventName, phase: "github-webhook" })
      : logger;

    if (!acceptance.accepted) {
      requestLogger?.warn?.(`Rejected GitHub webhook delivery (${acceptance.reason ?? "unknown_error"})`);
      res.statusCode = acceptance.reason === "invalid_signature" ? 401 : 400;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: false, reason: acceptance.reason ?? "invalid_request" }));
      return true;
    }

    requestLogger?.info?.(
      acceptance.duplicate ? "Ignored duplicate GitHub webhook delivery" : "Accepted GitHub webhook delivery",
    );
    res.statusCode = acceptance.duplicate ? 200 : 202;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({
      ok: true,
      duplicate: acceptance.duplicate,
      deliveryId,
      eventName,
    }));
    if (!acceptance.duplicate && acceptance.record && onAccepted) {
      void Promise.resolve(onAccepted(acceptance.record)).catch((error) => {
        requestLogger?.warn?.(`GitHub webhook background processing failed: ${(error as Error).message}`);
      });
    }
    return true;
  };
}
