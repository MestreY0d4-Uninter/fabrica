import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createActor, transition } from "xstate";
import { lifecycleMachine } from "../../lib/machines/LifecycleMachine.js";
import { getLifecycleService } from "../../lib/machines/lifecycle-service.js";
import { DATA_DIR } from "../../lib/setup/constants.js";

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("LifecycleMachine", () => {
  it("handles boot success and boot failure", () => {
    const actor = createActor(lifecycleMachine, { input: undefined });
    actor.start();
    actor.send({ type: "BOOT_OK" });
    let snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe("ready");

    const failedActor = createActor(lifecycleMachine, { input: undefined });
    failedActor.start();
    failedActor.send({ type: "BOOT_FAILED", error: "boom" });
    snapshot = failedActor.getSnapshot();
    expect(snapshot.value).toBe("error");
  });

  it("returns from processing to ready and supports graceful shutdown", () => {
    let snapshot = lifecycleMachine.resolveState({
      value: "ready",
      context: {
        lastDeliveryId: null,
        lastRunId: null,
        lastIssueId: null,
        lastSessionKey: null,
        lastError: null,
        retryCount: 0,
        updatedAt: new Date().toISOString(),
      },
    });
    [snapshot] = transition(lifecycleMachine, snapshot, { type: "WEBHOOK_RECEIVED", deliveryId: "d-1" });
    expect(snapshot.value).toEqual({ processing: "webhook" });
    [snapshot] = transition(lifecycleMachine, snapshot, { type: "PROCESSING_DONE" });
    expect(snapshot.value).toBe("ready");
    [snapshot] = transition(lifecycleMachine, snapshot, { type: "SHUTDOWN_SIGNAL" });
    expect(snapshot.value).toBe("draining");
    [snapshot] = transition(lifecycleMachine, snapshot, { type: "DRAIN_COMPLETE" });
    expect(snapshot.value).toBe("stopped");
  });

  it("persists lifecycle snapshots through the service wrapper", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-lifecycle-"));
    const service = await getLifecycleService(tempDir);

    await service.track("webhook", { deliveryId: "delivery-1" }, async () => undefined);

    const snapshotFile = path.join(tempDir, DATA_DIR, "runtime", "lifecycle.json");
    const raw = await fs.readFile(snapshotFile, "utf-8");
    const parsed = JSON.parse(raw) as { value: unknown; context: { lastDeliveryId?: string | null } };
    expect(parsed.value).toBe("ready");
    expect(parsed.context.lastDeliveryId).toBe("delivery-1");
  });
});
