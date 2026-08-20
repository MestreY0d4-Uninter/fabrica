import path from "node:path";
import { CoordinatorLedger } from "./ledger.js";

export async function openWorkspaceCoordinatorLedger(workspaceDir: string): Promise<CoordinatorLedger> {
  return CoordinatorLedger.open(path.join(workspaceDir, ".fabrica", "coordinator.sqlite"));
}
