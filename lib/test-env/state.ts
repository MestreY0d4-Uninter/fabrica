import type { CanonicalStack } from "../intake/types.js";
import type { Project, ProjectEnvironmentState } from "../projects/types.js";
import { resolveStackEnvironmentContract } from "./contracts.js";

export function resolveEnvironmentContractVersion(stack: CanonicalStack): string {
  return resolveStackEnvironmentContract(stack).version;
}

export function getProjectEnvironmentState(
  project: Project,
  stack: CanonicalStack,
): ProjectEnvironmentState {
  const version = resolveEnvironmentContractVersion(stack);
  const current = project.environment;

  if (!current || current.stack !== stack || current.contractVersion !== version) {
    return {
      status: "pending",
      stack,
      contractVersion: version,
      provisioningStartedAt: null,
      lastProvisionedAt: null,
      lastProvisionError: null,
      nextProvisionRetryAt: null,
    };
  }

  return {
    ...current,
    stack,
    contractVersion: version,
    provisioningStartedAt: current.provisioningStartedAt ?? null,
    lastProvisionedAt: current.lastProvisionedAt ?? null,
    lastProvisionError: current.lastProvisionError ?? null,
    nextProvisionRetryAt: current.nextProvisionRetryAt ?? null,
  };
}
