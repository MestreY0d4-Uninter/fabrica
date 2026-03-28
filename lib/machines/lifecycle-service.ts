import fs from "node:fs/promises";
import path from "node:path";
import { createActor } from "xstate";
import { DATA_DIR } from "../setup/constants.js";
import { ensureWorkspaceMigrated } from "../setup/migrate-layout.js";
import { lifecycleMachine, type LifecycleMachineContext, type LifecycleMachineEvent } from "./LifecycleMachine.js";

type LifecycleLogger = {
  info?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  child?(bindings: Record<string, unknown>): LifecycleLogger;
};

export type LifecycleService = {
  send(event: LifecycleMachineEvent): Promise<void>;
  track<T>(
    kind: "webhook" | "heartbeat" | "recovery",
    event: LifecycleTrackEvent,
    fn: () => Promise<T>,
  ): Promise<T>;
  snapshot(): { value: unknown; context: LifecycleMachineContext };
};

type LifecycleTrackEvent = {
  deliveryId?: string | null;
  runId?: string | null;
  issueId?: string | null;
  sessionKey?: string | null;
};

const services = new Map<string, Promise<LifecycleService>>();

async function lifecycleSnapshotPath(workspaceDir: string): Promise<string> {
  await ensureWorkspaceMigrated(workspaceDir);
  return path.join(workspaceDir, DATA_DIR, "runtime", "lifecycle.json");
}

async function persistSnapshot(
  workspaceDir: string,
  actor: ReturnType<typeof createActor<typeof lifecycleMachine>>,
): Promise<void> {
  const filePath = await lifecycleSnapshotPath(workspaceDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const snapshot = actor.getSnapshot();
  await fs.writeFile(filePath, JSON.stringify({
    value: snapshot.value,
    context: snapshot.context,
    updatedAt: snapshot.context.updatedAt,
  }, null, 2) + "\n", "utf-8");
}

async function createLifecycleService(workspaceDir: string, logger?: LifecycleLogger): Promise<LifecycleService> {
  const actor = createActor(lifecycleMachine, { input: undefined });
  actor.start();
  actor.send({ type: "BOOT_OK" });
  await persistSnapshot(workspaceDir, actor);

  const send = async (event: LifecycleMachineEvent): Promise<void> => {
    actor.send(event);
    await persistSnapshot(workspaceDir, actor);
    const lifecycleLogger = typeof logger?.child === "function"
      ? logger.child({ state: actor.getSnapshot().value, event: event.type, phase: "lifecycle" })
      : logger;
    lifecycleLogger?.info?.("Lifecycle machine transition");
  };

  const track = async <T>(
    kind: "webhook" | "heartbeat" | "recovery",
    event: LifecycleTrackEvent,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const startEvent: LifecycleMachineEvent =
      kind === "webhook"
        ? { type: "WEBHOOK_RECEIVED", deliveryId: event.deliveryId ?? null }
        : kind === "recovery"
          ? {
              type: "RECOVERY_NEEDED",
              runId: event.runId ?? null,
              issueId: event.issueId ?? null,
              sessionKey: event.sessionKey ?? null,
            }
          : {
              type: "HEARTBEAT_TICK",
              runId: event.runId ?? null,
              issueId: event.issueId ?? null,
              sessionKey: event.sessionKey ?? null,
            };

    await send(startEvent);
    try {
      const result = await fn();
      await send({
        type: "PROCESSING_DONE",
        runId: event.runId ?? null,
        issueId: event.issueId ?? null,
        sessionKey: event.sessionKey ?? null,
      });
      return result;
    } catch (error) {
      await send({
        type: "PROCESSING_FAILED",
        error: (error as Error).message,
        runId: event.runId ?? null,
        issueId: event.issueId ?? null,
        sessionKey: event.sessionKey ?? null,
      });
      await send({ type: "ERROR_RECOVERED" });
      const lifecycleLogger = typeof logger?.child === "function"
        ? logger.child({ kind, phase: "lifecycle" })
        : logger;
      lifecycleLogger?.warn?.(`Lifecycle machine observed processing failure: ${(error as Error).message}`);
      throw error;
    }
  };

  return {
    send,
    track,
    snapshot() {
      const snapshot = actor.getSnapshot();
      return {
        value: snapshot.value,
        context: snapshot.context,
      };
    },
  };
}

export async function getLifecycleService(
  workspaceDir: string,
  logger?: LifecycleLogger,
): Promise<LifecycleService> {
  const existing = services.get(workspaceDir);
  if (existing) return existing;
  const created = createLifecycleService(workspaceDir, logger);
  services.set(workspaceDir, created);
  return created;
}
