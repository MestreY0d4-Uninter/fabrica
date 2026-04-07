import type { FidelityDeliverable, TriageQualityCriticality } from "../intake/types.js";

export type StackPolicyArchetype = Exclude<FidelityDeliverable, "unknown"> | "unknown";

export type StackPolicy = {
  archetype: StackPolicyArchetype;
  stack: string | null;
  preferredLibraries: string[];
  discouragedPatterns: string[];
  requiredChecks: string[];
  recommendedTestStyle: string[];
  performanceFocus: string[];
  securityFocus: string[];
  maintainabilityFocus: string[];
  qualityCriticalityFloor: TriageQualityCriticality;
};

const BASE_POLICIES: Record<StackPolicyArchetype, Omit<StackPolicy, "stack">> = {
  api: {
    archetype: "api",
    preferredLibraries: ["schema validation", "structured logging", "typed request/response contracts"],
    discouragedPatterns: ["controllers with business logic", "missing input validation", "silent exception swallowing"],
    requiredChecks: ["startup/build", "request-level tests", "error handling review"],
    recommendedTestStyle: ["unit", "integration", "request-smoke"],
    performanceFocus: ["query efficiency", "async boundaries", "avoid blocking I/O in hot paths"],
    securityFocus: ["auth/authz review", "input validation", "secret handling"],
    maintainabilityFocus: ["clear domain boundaries", "small handlers", "shared validation primitives"],
    qualityCriticalityFloor: "medium",
  },
  "web-ui": {
    archetype: "web-ui",
    preferredLibraries: ["component testing", "form/input validation", "accessible primitives"],
    discouragedPatterns: ["global state without need", "missing loading states", "client/server boundary confusion"],
    requiredChecks: ["build/render", "primary flow smoke", "error/loading coverage"],
    recommendedTestStyle: ["component", "interaction", "smoke-e2e"],
    performanceFocus: ["avoid wasteful rerenders", "fetch discipline", "bundle awareness"],
    securityFocus: ["secret boundary review", "unsafe HTML review"],
    maintainabilityFocus: ["component responsibility", "predictable state ownership", "clear routing boundaries"],
    qualityCriticalityFloor: "medium",
  },
  cli: {
    archetype: "cli",
    preferredLibraries: ["argument parsing", "clear help output", "deterministic command structure"],
    discouragedPatterns: ["opaque error output", "missing exit codes", "unsafe shell invocation"],
    requiredChecks: ["help command", "command smoke tests", "exit code validation"],
    recommendedTestStyle: ["argv parsing", "stdout/stderr assertions", "command smoke"],
    performanceFocus: ["fast startup", "bounded file scanning", "efficient terminal output"],
    securityFocus: ["path handling", "shell escaping", "safe destructive operations"],
    maintainabilityFocus: ["small command handlers", "reusable core logic", "clear UX contract"],
    qualityCriticalityFloor: "low",
  },
  library: {
    archetype: "library",
    preferredLibraries: ["stable public API", "type-safe exports", "minimal dependency surface"],
    discouragedPatterns: ["leaky abstractions", "unstable exports", "overloaded public API"],
    requiredChecks: ["install/build", "public API tests", "basic docs/examples"],
    recommendedTestStyle: ["public API unit tests", "usage examples"],
    performanceFocus: ["avoid unnecessary allocations", "respect hot path ergonomics"],
    securityFocus: ["safe defaults", "avoid unsafe execution primitives"],
    maintainabilityFocus: ["cohesive exports", "backward compatibility awareness", "narrow API surface"],
    qualityCriticalityFloor: "low",
  },
  automation: {
    archetype: "automation",
    preferredLibraries: ["retry/backoff helpers", "structured logs", "queue/job primitives"],
    discouragedPatterns: ["non-idempotent retries", "missing timeouts", "side-effectful orchestration code"],
    requiredChecks: ["main flow smoke", "failure-path validation", "timeout/retry review"],
    recommendedTestStyle: ["flow tests", "failure simulation", "retry semantics"],
    performanceFocus: ["bounded retries", "queue throughput awareness", "avoid duplicated work"],
    securityFocus: ["credential handling", "external call safety"],
    maintainabilityFocus: ["separate orchestration from business logic", "idempotent units"],
    qualityCriticalityFloor: "medium",
  },
  hybrid: {
    archetype: "hybrid",
    preferredLibraries: ["clear API/UI contracts", "shared validation", "structured integration boundaries"],
    discouragedPatterns: ["tight UI/backend coupling", "duplicated validation logic"],
    requiredChecks: ["build", "primary end-to-end flow", "API and UI smoke tests"],
    recommendedTestStyle: ["integration", "component", "smoke-e2e"],
    performanceFocus: ["network boundary efficiency", "avoid duplicated fetch/work"],
    securityFocus: ["client/server boundary review", "auth flow review"],
    maintainabilityFocus: ["clean contracts", "shared schema discipline"],
    qualityCriticalityFloor: "medium",
  },
  unknown: {
    archetype: "unknown",
    preferredLibraries: ["mature ecosystem defaults", "minimal dependency set"],
    discouragedPatterns: ["invented infrastructure", "unnecessary abstraction"],
    requiredChecks: ["build or execution smoke", "basic tests"],
    recommendedTestStyle: ["unit", "smoke"],
    performanceFocus: ["avoid obvious inefficiency"],
    securityFocus: ["safe defaults"],
    maintainabilityFocus: ["simple structure", "clear names"],
    qualityCriticalityFloor: "low",
  },
};

export function resolveStackPolicy(opts: {
  deliverable?: StackPolicyArchetype | null;
  stackHint?: string | null;
  qualityCriticality?: TriageQualityCriticality | null;
}): StackPolicy {
  const archetype = opts.deliverable ?? "unknown";
  const base = BASE_POLICIES[archetype] ?? BASE_POLICIES.unknown;
  const stack = opts.stackHint?.trim() || null;
  const ORDER: TriageQualityCriticality[] = ["low", "medium", "high"];
  const qualityCriticalityFloor = opts.qualityCriticality
    ? (ORDER.indexOf(opts.qualityCriticality) > ORDER.indexOf(base.qualityCriticalityFloor)
        ? opts.qualityCriticality
        : base.qualityCriticalityFloor)
    : base.qualityCriticalityFloor;

  const stackSpecificLibraries = stack === "fastapi"
    ? ["pydantic schemas", "pytest", "dependency-injected routers"]
    : stack === "express"
      ? ["request validation", "supertest", "structured error middleware"]
      : stack === "nextjs"
        ? ["component testing", "server/client boundary discipline"]
        : stack === "python-cli"
          ? ["argparse/typer discipline", "pytest command tests"]
          : stack === "node-cli"
            ? ["commander/yargs discipline", "stdout/exit-code tests"]
            : [];

  return {
    ...base,
    stack,
    preferredLibraries: [...base.preferredLibraries, ...stackSpecificLibraries],
    qualityCriticalityFloor,
  };
}
