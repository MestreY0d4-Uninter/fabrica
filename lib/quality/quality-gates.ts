import type { FidelityDeliverable, TriageQualityCriticality } from "../intake/types.js";

export type QualityGateArchetype = Exclude<FidelityDeliverable, "unknown"> | "unknown";

export type QualityGatePolicy = {
  archetype: QualityGateArchetype;
  requiredEvidence: string[];
  requiredChecks: string[];
  autoRejectConditions: string[];
  qualityCriticalityFloor: TriageQualityCriticality;
};

const BASE_POLICIES: Record<QualityGateArchetype, QualityGatePolicy> = {
  api: {
    archetype: "api",
    requiredEvidence: ["request-level verification", "acceptance criteria traceability"],
    requiredChecks: ["startup/build", "endpoint validation", "error-handling review"],
    autoRejectConditions: ["missing input validation", "missing auth review on sensitive flows", "no meaningful API evidence"],
    qualityCriticalityFloor: "medium",
  },
  "web-ui": {
    archetype: "web-ui",
    requiredEvidence: ["primary flow verification", "loading/error behavior"],
    requiredChecks: ["build/render", "interaction smoke", "a11y sanity"],
    autoRejectConditions: ["missing primary flow evidence", "missing loading/error handling"],
    qualityCriticalityFloor: "medium",
  },
  cli: {
    archetype: "cli",
    requiredEvidence: ["command smoke", "help output", "exit-code behavior"],
    requiredChecks: ["binary/script execution", "argv validation"],
    autoRejectConditions: ["missing help output", "wrong exit-code behavior", "no command evidence"],
    qualityCriticalityFloor: "low",
  },
  library: {
    archetype: "library",
    requiredEvidence: ["public API tests", "usage validation"],
    requiredChecks: ["build/install", "public export verification"],
    autoRejectConditions: ["no public API evidence", "broken exports"],
    qualityCriticalityFloor: "low",
  },
  automation: {
    archetype: "automation",
    requiredEvidence: ["main flow verification", "failure-path evidence"],
    requiredChecks: ["timeout/retry review", "idempotency review when applicable"],
    autoRejectConditions: ["unsafe retries", "no failure-path evidence"],
    qualityCriticalityFloor: "medium",
  },
  hybrid: {
    archetype: "hybrid",
    requiredEvidence: ["API and UI flow evidence", "integration behavior"],
    requiredChecks: ["build", "API smoke", "UI smoke"],
    autoRejectConditions: ["missing UI evidence", "missing API evidence"],
    qualityCriticalityFloor: "medium",
  },
  unknown: {
    archetype: "unknown",
    requiredEvidence: ["basic behavioral evidence"],
    requiredChecks: ["build or execution smoke"],
    autoRejectConditions: ["no runnable evidence"],
    qualityCriticalityFloor: "low",
  },
};

export function resolveQualityGatePolicy(opts: {
  deliverable?: QualityGateArchetype | null;
  qualityCriticality?: TriageQualityCriticality | null;
}): QualityGatePolicy {
  const archetype = opts.deliverable ?? "unknown";
  const base = BASE_POLICIES[archetype] ?? BASE_POLICIES.unknown;
  const ORDER: TriageQualityCriticality[] = ["low", "medium", "high"];
  const qualityCriticalityFloor = opts.qualityCriticality
    ? (ORDER.indexOf(opts.qualityCriticality) > ORDER.indexOf(base.qualityCriticalityFloor)
        ? opts.qualityCriticality
        : base.qualityCriticalityFloor)
    : base.qualityCriticalityFloor;
  return {
    ...base,
    qualityCriticalityFloor,
  };
}
