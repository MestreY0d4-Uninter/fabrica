import { describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import { InMemoryGitHubEventStore } from "../../lib/github/event-store.js";
import {
  createGitHubWebhookHandler,
  extractGitHubEventMetadata,
  receiveGitHubWebhook,
  verifyGitHubWebhookSignature,
} from "../../lib/github/webhook.js";

function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("github webhook receiver", () => {
  it("verifies a valid GitHub webhook signature", () => {
    const secret = "test-secret";
    const body = JSON.stringify({ hello: "world" });
    expect(verifyGitHubWebhookSignature(secret, body, sign(secret, body))).toBe(true);
    expect(verifyGitHubWebhookSignature(secret, body, sign("wrong", body))).toBe(false);
  });

  it("extracts canonical PR metadata from webhook payloads", () => {
    const metadata = extractGitHubEventMetadata({
      installation: { id: 101 },
      repository: { id: 202 },
      pull_request: {
        number: 7,
        head: { sha: "abc123" },
      },
    });

    expect(metadata).toEqual({
      installationId: 101,
      repositoryId: 202,
      prNumber: 7,
      headSha: "abc123",
    });
  });

  it("stores a valid webhook as a pending event and deduplicates by delivery id", async () => {
    const secret = "test-secret";
    const store = new InMemoryGitHubEventStore();
    const body = JSON.stringify({
      installation: { id: 101 },
      repository: { id: 202 },
      pull_request: {
        number: 7,
        head: { sha: "abc123" },
      },
    });

    const first = await receiveGitHubWebhook(store, secret, {
      deliveryId: "delivery-1",
      eventName: "pull_request",
      signature256: sign(secret, body),
      body,
    });

    expect(first.accepted).toBe(true);
    expect(first.duplicate).toBe(false);
    expect(first.record?.status).toBe("pending");
    expect(first.record?.installationId).toBe(101);
    expect(first.record?.repositoryId).toBe(202);
    expect(first.record?.prNumber).toBe(7);
    expect(first.record?.headSha).toBe("abc123");

    const second = await receiveGitHubWebhook(store, secret, {
      deliveryId: "delivery-1",
      eventName: "pull_request",
      signature256: sign(secret, body),
      body,
    });

    expect(second.accepted).toBe(true);
    expect(second.duplicate).toBe(true);
  });

  it("rejects invalid signatures and invalid JSON", async () => {
    const store = new InMemoryGitHubEventStore();

    const invalidSignature = await receiveGitHubWebhook(store, "secret", {
      deliveryId: "delivery-2",
      eventName: "pull_request",
      signature256: sign("wrong", "{}"),
      body: "{}",
    });
    expect(invalidSignature).toEqual({
      accepted: false,
      duplicate: false,
      reason: "invalid_signature",
    });

    const invalidJson = await receiveGitHubWebhook(store, "secret", {
      deliveryId: "delivery-3",
      eventName: "pull_request",
      signature256: sign("secret", "{invalid"),
      body: "{invalid",
    });
    expect(invalidJson).toEqual({
      accepted: false,
      duplicate: false,
      reason: "invalid_json",
    });
  });

  it("dispatches accepted webhook deliveries to the immediate processing callback", async () => {
    const secret = "test-secret";
    const store = new InMemoryGitHubEventStore();
    const onAccepted = vi.fn(async () => {});
    const body = JSON.stringify({
      action: "opened",
      installation: { id: 101 },
      repository: { id: 202 },
      pull_request: {
        number: 7,
        head: { sha: "abc123" },
      },
    });

    const req = Readable.from([body]) as any;
    req.method = "POST";
    req.headers = {
      "x-github-delivery": "delivery-hot-1",
      "x-github-event": "pull_request",
      "x-hub-signature-256": sign(secret, body),
    };

    let endedBody = "";
    const res = {
      headersSent: false,
      statusCode: 0,
      headers: {} as Record<string, string>,
      setHeader(name: string, value: string) {
        this.headers[name] = value;
      },
      end(value: string) {
        endedBody = value;
        this.headersSent = true;
      },
    } as any;

    const handled = await createGitHubWebhookHandler({
      workspaceDir: "/tmp/ws",
      secret,
      store,
      onAccepted,
      logger: { info() {}, warn() {}, error() {} },
    })(req, res);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(endedBody)).toMatchObject({ ok: true, duplicate: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(onAccepted.mock.calls[0]?.[0]).toMatchObject({
      deliveryId: "delivery-hot-1",
      eventName: "pull_request",
      prNumber: 7,
    });
  });
});
