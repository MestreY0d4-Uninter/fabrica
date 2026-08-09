import { CoordinatorLedger, type CoordinatorLease, type CoordinatorRun } from "./ledger.js";
import { openWorkspaceCoordinatorLedger } from "./index.js";

export type DispatchCoordinator = {
  ledger: CoordinatorLedger;
  run: CoordinatorRun;
  lease: CoordinatorLease;
};

export async function beginDispatchCoordinator(workspaceDir: string, runId: string, issueId: number, owner: string): Promise<DispatchCoordinator | null> {
  try {
    const ledger = await openWorkspaceCoordinatorLedger(workspaceDir);
    const run = ledger.createRun(runId, String(issueId));
    const lease = ledger.acquireLease(run.runId, owner, 5 * 60_000, run.generation, run.leaseEpoch);
    if (!lease) { ledger.close(); return null; }
    return { ledger, run, lease };
  } catch { return null; }
}

export function registerDispatchSession(coordinator: DispatchCoordinator, sessionKey: string): boolean {
  return coordinator.ledger.registerSession(coordinator.run.runId, coordinator.run.generation, sessionKey);
}

export async function acceptDispatchRuntime(coordinator: DispatchCoordinator, sessionKey: string, attempts = 8, delayMs = 100): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (coordinator.ledger.acceptRuntimeForSession(sessionKey)) return true;
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}
