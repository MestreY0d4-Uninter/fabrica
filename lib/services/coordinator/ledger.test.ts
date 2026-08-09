import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CoordinatorLedger } from "./ledger.js";

describe("CoordinatorLedger fault containment", () => {
  async function open() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-coordinator-"));
    const ledger = await CoordinatorLedger.open(path.join(dir, "coordinator.sqlite"));
    return { dir, ledger };
  }

  it("serializes generations and fences stale events after a new lease epoch", async () => {
    const { ledger } = await open();
    try {
      const first = ledger.createRun("run-1", "issue-1");
      const lease = ledger.acquireLease(first.runId, "worker-a", 10_000, first.generation, first.leaseEpoch);
      expect(lease).not.toBeNull();
      expect(ledger.recordBootstrapReady(first.runId, first.generation, "session-1")).toBe(true);
      expect(ledger.acceptRuntime(first.runId, first.generation, lease!.leaseEpoch, "session-1")).toBe(true);
      expect(ledger.appendEvent(first.runId, first.generation, lease!.leaseEpoch, 0, "started", {})).not.toBeNull();
      expect(ledger.appendEvent(first.runId, first.generation, lease!.leaseEpoch, 0, "duplicate", {})).toBeNull();

      expect(ledger.releaseLease(lease!)).toBe(true);
      const second = ledger.createRun("run-2", "issue-1");
      expect(second.generation).toBe(first.generation + 1);
      expect(ledger.appendEvent(first.runId, first.generation, lease!.leaseEpoch, 1, "stale", {})).toBeNull();
    } finally { ledger.close(); }
  });

  it("requires BOOTSTRAP_READY and a live lease before runtime acceptance", async () => {
    const { ledger } = await open();
    try {
      const run = ledger.createRun("run-1", "issue-1");
      expect(ledger.acceptRuntime(run.runId, run.generation, 1, "missing")).toBe(false);
      const lease = ledger.acquireLease(run.runId, "worker-a", 10_000, run.generation, run.leaseEpoch)!;
      expect(ledger.acceptRuntime(run.runId, run.generation, lease.leaseEpoch, "session-1")).toBe(false);
      expect(ledger.recordBootstrapReady(run.runId, run.generation, "session-1")).toBe(true);
      expect(ledger.acceptRuntime(run.runId, run.generation, lease.leaseEpoch, "session-1")).toBe(true);
      expect(ledger.acceptRuntime(run.runId, run.generation, lease.leaseEpoch, "session-1")).toBe(false);
    } finally { ledger.close(); }
  });

  it("requeues expired leases and deduplicates outbox effects", async () => {
    const { ledger } = await open();
    try {
      const run = ledger.createRun("run-1", "issue-1");
      const lease = ledger.acquireLease(run.runId, "worker-a", 1, run.generation, run.leaseEpoch)!;
      expect(ledger.enqueueOutbox(run.runId, "effect-1", { kind: "alert" })).toBe(true);
      expect(ledger.enqueueOutbox(run.runId, "effect-1", { kind: "alert" })).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(ledger.renewLease(lease, 10_000)).toBe(false);
      expect(ledger.recoverExpiredLeases()).toEqual([expect.objectContaining({ runId: run.runId, action: "requeue", reason: "lease_expired" })]);
      expect(ledger.getRun(run.runId)?.status).toBe("requeue");
    } finally { ledger.close(); }
  });

  it("quarantines rather than guessing when recovery cannot prove ownership", async () => {
    const { ledger } = await open();
    try {
      const run = ledger.createRun("run-1", "issue-1");
      expect(ledger.quarantine(run.runId, run.generation, "session_missing_delete_race")).toBe(true);
      expect(ledger.getRun(run.runId)?.status).toBe("quarantined");
      expect(ledger.acquireLease(run.runId, "worker-b", 10_000, run.generation, 0)).toBeNull();
    } finally { ledger.close(); }
  });
});
