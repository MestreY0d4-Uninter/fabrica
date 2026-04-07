import type { FidelityDeliverable, TriageQualityCriticality } from "../intake/types.js";

export type DonePolicyArchetype = Exclude<FidelityDeliverable, "unknown"> | "unknown";

export type DonePolicy = {
  archetype: DonePolicyArchetype;
  requiredArtifacts: string[];
  requiredEvidence: string[];
  behavioralChecks: string[];
  disqualifyingConditions: string[];
  qualityCriticalityFloor: TriageQualityCriticality;
};

const BASE_POLICIES: Record<DonePolicyArchetype, DonePolicy> = {
  api: {
    archetype: "api",
    requiredArtifacts: ["implemented endpoint surface", "runtime contract"],
    requiredEvidence: ["API behavior evidence", "acceptance criteria coverage"],
    behavioralChecks: ["startup works", "error paths handled", "validation enforced"],
    disqualifyingConditions: ["missing endpoint evidence", "missing validation on exposed boundaries"],
    qualityCriticalityFloor: "medium",
  },
  "web-ui": {
    archetype: "web-ui",
    requiredArtifacts: ["main user flow", "UI states"],
    requiredEvidence: ["interaction evidence", "loading/error evidence"],
    behavioralChecks: ["main flow works", "render path stable"],
    disqualifyingConditions: ["missing main flow evidence", "broken loading/error handling"],
    qualityCriticalityFloor: "medium",
  },
  cli: {
    archetype: "cli",
    requiredArtifacts: ["command entrypoint", "help contract"],
    requiredEvidence: ["command execution evidence", "exit-code evidence"],
    behavioralChecks: ["help works", "main command succeeds", "invalid args fail cleanly"],
    disqualifyingConditions: ["missing help", "no command execution evidence"],
    qualityCriticalityFloor: "low",
  },
  library: {
    archetype: "library",
    requiredArtifacts: ["public API surface"],
    requiredEvidence: ["public API tests or examples"],
    behavioralChecks: ["exports resolve", "usage path works"],
    disqualifyingConditions: ["broken exports", "no public API evidence"],
    qualityCriticalityFloor: "low",
  },
  automation: {
    archetype: "automation",
    requiredArtifacts: ["orchestration flow"],
    requiredEvidence: ["main flow evidence", "failure-path evidence"],
    behavioralChecks: ["timeouts are bounded", "retry semantics are safe where needed"],
    disqualifyingConditions: ["unsafe retry behavior", "no failure-path evidence"],
    qualityCriticalityFloor: "medium",
  },
  hybrid: {
    archetype: "hybrid",
    requiredArtifacts: ["API surface", "UI/main interaction flow"],
    requiredEvidence: ["API evidence", "UI evidence"],
    behavioralChecks: ["integrated path works"],
    disqualifyingConditions: ["missing one side of hybrid evidence"],
    qualityCriticalityFloor: "medium",
  },
  unknown: {
    archetype: "unknown",
    requiredArtifacts: ["core deliverable"],
    requiredEvidence: ["basic runnable evidence"],
    behavioralChecks: ["main path works"],
    disqualifyingConditions: ["no evidence of working main path"],
    qualityCriticalityFloor: "low",
  },
};

export function resolveDonePolicy(opts: {
  deliverable?: DonePolicyArchetype | null;
  qualityCriticality?: TriageQualityCriticality | null;
}): DonePolicy {
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
