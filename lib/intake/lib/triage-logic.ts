/**
 * Triage decision logic — effort, priority, DoR validation.
 * Pure logic port from triage.sh.
 */
import type {
  IdeaType,
  DeliveryTarget,
  TriagePriority,
  TriageEffort,
  TriageComplexity,
  TriageCoupling,
  TriageParallelizability,
  TriageQualityCriticality,
} from "../types.js";

export type TriageMatrix = {
  version: string;
  priority_rules_v2: Array<{
    when: { type?: string; effort?: string; min_risk_count?: number; max_risk_count?: number };
    priority: TriagePriority;
    label: string;
  }>;
  effort_rules: Record<string, { max_files: number; max_acs: number; label: string }>;
  auto_labels: Record<string, string>;
  target_state_by_type: Record<string, string>;
  dispatch_label?: string;
};

export type TriageInput = {
  type: IdeaType;
  deliveryTarget: DeliveryTarget;
  acCount: number;
  scopeCount: number;
  dodCount: number;
  filesChanged: number;
  totalRisks: number;
  objective: string;
  rawIdea: string;
  acText: string;
  scopeText: string;
  dodText: string;
  oosText: string;
  authSignal: boolean;
};

export type TriageDecision = {
  priority: TriagePriority;
  priorityLabel: string;
  effort: TriageEffort;
  effortLabel: string;
  complexity: TriageComplexity;
  coupling: TriageCoupling;
  parallelizability: TriageParallelizability;
  qualityCriticality: TriageQualityCriticality;
  riskProfile: string[];
  typeLabel: string;
  targetState: string;
  dispatchLabel: string | null;
  level: string;
  readyForDispatch: boolean;
  errors: string[];
  specQualityBlock?: boolean;
};

/**
 * Detect signals in rawIdea that indicate a multi-subsystem or complex request.
 * Used to floor the effort estimate when the LLM-generated spec is too thin.
 */
export function detectRawIdeaComplexity(rawIdea: string): { floor: TriageEffort | null; signals: string[] } {
  const text = rawIdea.toLowerCase();
  const signals: string[] = [];

  // Multi-subsystem indicators
  const subsystemPatterns: Array<[RegExp, string]> = [
    [/\b(worker|background.?job|background process|background service|background worker|queue|celery|bull|sidekiq|task.?runner|scheduler|job processor)\b/i, "background-worker"],
    [/\b(websocket|server.?sent|sse|real.?time|realtime|socket\.io|push.?notif)\b/i, "realtime"],
    [/\b(auth|oauth|jwt|login|register|session|user.?account|signup|role-based access|rbac|permission[s]?)\b/i, "auth"],
    [/\b(notif|notification[s]?|alert[s]?|email|sms|webhook|subscription|subscribe|reminder[s]?|escalation[s]?)\b/i, "notifications"],
    [/\b(database|banco|db|postgres|mysql|mongodb|redis|sqlite|orm|audit history|audit log|activity history)\b/i, "database"],
    [/\b(api\s+rest|rest\s+api|endpoint|rota|route|graphql|grpc)\b/i, "api-layer"],
    [/\b(docker|kubernetes|k8s|deploy|ci|cd|pipeline)\b/i, "infra"],
    [/\b(dashboard|frontend|interface|ui|tela|p[aá]gina|admin view|admin panel|admin console)\b/i, "frontend"],
  ];

  for (const [regex, label] of subsystemPatterns) {
    if (regex.test(text)) signals.push(label);
  }

  // Floor logic: 3+ subsystems = medium floor, 4+ = large floor
  let floor: TriageEffort | null = null;
  if (signals.length >= 4) floor = "large";
  else if (signals.length >= 3) floor = "medium";
  else if (signals.length >= 2) floor = "medium";

  return { floor, signals };
}

/** Calculate effort from files changed and AC count, floored by rawIdea complexity signals. */
export function calculateEffort(filesChanged: number, acCount: number, rawIdea?: string): TriageEffort {
  let effort: TriageEffort;
  if (filesChanged <= 3 && acCount <= 3) effort = "small";
  else if (filesChanged <= 10 && acCount <= 7) effort = "medium";
  else if (filesChanged <= 25 && acCount <= 15) effort = "large";
  else effort = "xlarge";

  // Apply complexity floor from rawIdea signals to prevent under-triage of complex prompts
  // when the LLM-generated spec is thin.
  if (rawIdea) {
    const { floor } = detectRawIdeaComplexity(rawIdea);
    if (floor) {
      const ORDER: TriageEffort[] = ["small", "medium", "large", "xlarge"];
      if (ORDER.indexOf(floor) > ORDER.indexOf(effort)) {
        effort = floor;
      }
    }
  }

  return effort;
}

/** Calculate priority using the v2 rules matrix. */
export function calculatePriority(
  type: IdeaType,
  effort: TriageEffort,
  totalRisks: number,
  matrix: TriageMatrix,
): { priority: TriagePriority; label: string } {
  for (const rule of matrix.priority_rules_v2) {
    const w = rule.when;
    if (w.type && w.type !== type) continue;
    if (w.effort && w.effort !== effort) continue;
    if (w.min_risk_count != null && totalRisks < w.min_risk_count) continue;
    if (w.max_risk_count != null && totalRisks > w.max_risk_count) continue;
    return { priority: rule.priority, label: rule.label };
  }

  // Fallback (same as bash)
  if (type === "bugfix" && totalRisks > 2) return { priority: "P0", label: "priority:critical" };
  if (type === "bugfix") return { priority: "P1", label: "priority:high" };
  if (type === "infra") return { priority: "P2", label: "priority:medium" };
  if (type === "feature" && effort === "small") return { priority: "P2", label: "priority:medium" };
  return { priority: "P3", label: "priority:normal" };
}

const AUTH_REGEX = /\b(login|autentic|senha|perfil|permiss|acesso|rbac|admin)\b/i;

/** Run Definition of Ready (DoR) validation checks. */
export function validateDoR(input: TriageInput): string[] {
  const errors: string[] = [];

  if (!input.objective.trim()) errors.push("dor_missing_objective");
  if (input.scopeCount < 1) errors.push("dor_missing_scope");
  if (input.acCount < 1) errors.push("dor_missing_acceptance_criteria");
  if (input.dodCount < 1) errors.push("dor_missing_definition_of_done");

  // Delivery-target-specific evidence
  const combined = `${input.acText} ${input.scopeText}`;

  if (input.deliveryTarget === "web-ui") {
    if (!/\b(tela|p[aá]gina|ui|interface|dashboard|fluxo)\b/i.test(combined)) {
      errors.push("dor_web_ui_missing_ui_evidence");
    }
  }
  if (input.deliveryTarget === "api") {
    if (!/\b(api|endpoint|rota|route|http|rest)\b/i.test(combined)) {
      errors.push("dor_api_missing_endpoint_evidence");
    }
  }
  if (input.deliveryTarget === "hybrid") {
    if (!/\b(tela|p[aá]gina|ui|interface|dashboard|fluxo)\b/i.test(combined)) {
      errors.push("dor_hybrid_missing_ui_evidence");
    }
    if (!/\b(api|endpoint|rota|route|http|rest)\b/i.test(combined)) {
      errors.push("dor_hybrid_missing_api_evidence");
    }
  }

  // Auth gate: detect auth intent from rawIdea OR objective (not just spec-derived texts).
  // This prevents the gate from being bypassed when the LLM spec minimises auth details.
  let authSignal = input.authSignal;
  if (!authSignal) {
    const signalText = `${input.rawIdea} ${input.objective}`.toLowerCase();
    authSignal = AUTH_REGEX.test(signalText);
  }

  if (authSignal) {
    // Evidence must exist in the GENERATED spec (ACs + scope + objective), not rawIdea.
    // rawIdea is used only for signal detection — if the LLM spec didn't capture auth,
    // that IS the problem we want to flag.
    const evidenceText = `${input.acText} ${input.scopeText} ${input.objective}`.toLowerCase();
    if (!AUTH_REGEX.test(evidenceText)) {
      errors.push("dor_auth_requirements_missing");
    }
    if (AUTH_REGEX.test(input.oosText.toLowerCase()) && !AUTH_REGEX.test(input.acText.toLowerCase())) {
      errors.push("dor_auth_moved_to_out_of_scope_without_acceptance");
    }
  }

  return errors;
}

/** Determine worker level from effort. */
export function determineLevel(effort: TriageEffort, targetState: string): string {
  let level = "medior";
  if (effort === "small") level = "junior";
  if (effort === "large" || effort === "xlarge") level = "senior";
  if (targetState === "To Research" && level === "medior") level = "junior";
  return level;
}

export function assessComplexity(input: TriageInput): TriageComplexity {
  const broadSignals = detectRawIdeaComplexity(input.rawIdea).signals.length;
  if (input.filesChanged >= 18 || input.acCount >= 8 || broadSignals >= 4 || input.totalRisks >= 4) return "high";
  if (input.filesChanged >= 8 || input.acCount >= 4 || broadSignals >= 2 || input.totalRisks >= 2) return "medium";
  return "low";
}

export function assessCoupling(input: TriageInput): TriageCoupling {
  const text = `${input.rawIdea} ${input.scopeText}`.toLowerCase();
  const crossCuttingSignals = [
    /\bauth\b|\bpermission\b|\brbac\b/,
    /\bmigration\b|\bschema\b|\bdatabase\b/,
    /\bbackground\b|\bworker\b|\bqueue\b|\bcron\b/,
    /\bfrontend\b|\bdashboard\b|\bui\b/,
    /\bintegration\b|\bwebhook\b|\bexternal\b/,
  ].filter((regex) => regex.test(text)).length;
  if (crossCuttingSignals >= 4) return "high";
  if (crossCuttingSignals >= 2) return "medium";
  return "low";
}

export function assessParallelizability(input: TriageInput, coupling: TriageCoupling): TriageParallelizability {
  const text = `${input.rawIdea} ${input.scopeText}`.toLowerCase();
  const capabilitySignals = [
    /\bauth\b/,
    /\bapi\b|\bendpoint\b|\broute\b/,
    /\bfrontend\b|\bdashboard\b|\bui\b/,
    /\bworker\b|\bqueue\b|\bbackground\b/,
    /\bnotification\b|\bemail\b|\bsms\b|\balert\b/,
    /\bdatabase\b|\bmigration\b|\bschema\b/,
  ].filter((regex) => regex.test(text)).length;
  if (coupling === "high") return "low";
  if (capabilitySignals >= 4) return "high";
  if (capabilitySignals >= 2) return "medium";
  return "low";
}

export function assessQualityCriticality(input: TriageInput): TriageQualityCriticality {
  const text = `${input.rawIdea} ${input.objective} ${input.scopeText}`.toLowerCase();
  if (/\bauth\b|\boauth\b|\bjwt\b|\brbac\b|\bpayment\b|\bbilling\b|\bpii\b|\bsecure\b|\bsecurity\b/.test(text)) return "high";
  if (/\bperformance\b|\bscalable\b|\bbackground\b|\bworker\b|\bintegration\b|\bwebhook\b/.test(text)) return "medium";
  return "low";
}

export function buildRiskProfile(input: TriageInput): string[] {
  const text = `${input.rawIdea} ${input.objective} ${input.scopeText}`.toLowerCase();
  const risks = [
    /\bauth\b|\boauth\b|\bjwt\b|\brbac\b/.test(text) ? "auth" : null,
    /\bpayment\b|\bbilling\b|\bsubscription\b/.test(text) ? "payments" : null,
    /\bdatabase\b|\bmigration\b|\bschema\b/.test(text) ? "data_model" : null,
    /\bworker\b|\bqueue\b|\bbackground\b|\bcron\b/.test(text) ? "async_processing" : null,
    /\bintegration\b|\bwebhook\b|\bexternal\b/.test(text) ? "external_integration" : null,
    /\bperformance\b|\blatency\b|\bthroughput\b/.test(text) ? "performance" : null,
  ];
  return Array.from(new Set(risks.filter((risk): risk is string => Boolean(risk))));
}

/** Run full triage logic. */
export function runTriageLogic(input: TriageInput, matrix: TriageMatrix): TriageDecision {
  const effort = calculateEffort(input.filesChanged, input.acCount, input.rawIdea);
  const { priority, label: priorityLabel } = calculatePriority(input.type, effort, input.totalRisks, matrix);
  const complexity = assessComplexity(input);
  const coupling = assessCoupling(input);
  const parallelizability = assessParallelizability(input, coupling);
  const qualityCriticality = assessQualityCriticality(input);
  const riskProfile = buildRiskProfile(input);

  const effortLabel = matrix.effort_rules[effort]?.label ?? `effort:${effort}`;
  const typeLabel = matrix.auto_labels[input.type] ?? "";
  const targetState = matrix.target_state_by_type[input.type] ?? matrix.target_state_by_type.default ?? "To Do";
  const dispatchLabel = matrix.dispatch_label?.trim() ? matrix.dispatch_label.trim() : null;

  const dorErrors = validateDoR(input);
  const readyForDispatch = dorErrors.length === 0;
  const level = determineLevel(effort, targetState);

  // Spec quality gate (F3-5)
  const specQualityErrors = validateSpecQuality({
    objective: input.objective ?? input.rawIdea,
    scopeItems: (input.scopeText ?? "").split("\n").filter((l) => l.trim()),
    acceptanceCriteria: (input.acText ?? "").split("\n").filter((l) => l.trim()),
    dod: input.dodText ?? "",
  });
  const specQualityBlock = specQualityErrors.length > 0;

  return {
    priority, priorityLabel, effort, effortLabel,
    complexity, coupling, parallelizability, qualityCriticality, riskProfile,
    typeLabel, targetState, dispatchLabel, level,
    // errors contains DoR errors only — used for readyForDispatch gate.
    // Spec quality errors are surfaced separately via specQualityBlock.
    readyForDispatch, errors: dorErrors,
    specQualityBlock,
  };
}

// ---------------------------------------------------------------------------
// Spec quality gate (F3-5)
// ---------------------------------------------------------------------------

export type SpecQualityInput = {
  objective: string;
  scopeItems: string[];
  acceptanceCriteria: string[];
  dod: string;
};

/**
 * Action verbs that indicate concrete, verifiable acceptance criteria.
 * Bilingual PT+EN. Extensible via classification-rules.json in future.
 */
const ACTION_VERBS = /\b(deve|retorna|valida|exibe|permite|rejeita|calcula|should|returns|validates|displays|allows|rejects|calculates|aceita|processa|envia|recebe|cria|remove|atualiza|lista)\b/i;

/**
 * Validate spec quality to prevent vibe-coded projects.
 * Returns array of error codes. Empty = spec is good.
 */
export function validateSpecQuality(input: SpecQualityInput): string[] {
  const errors: string[] = [];

  // Objective: > 20 words
  const wordCount = input.objective.trim().split(/\s+/).length;
  if (wordCount < 20) {
    errors.push("spec_objective_too_short");
  }

  // Scope: >= 3 concrete items
  if (input.scopeItems.length < 3) {
    errors.push("spec_scope_insufficient");
  }

  // Acceptance criteria: >= 3 items
  if (input.acceptanceCriteria.length < 3) {
    errors.push("spec_ac_insufficient");
  }

  // Acceptance criteria: must contain action verbs
  const hasActionVerbs = input.acceptanceCriteria.some((ac) => ACTION_VERBS.test(ac));
  if (input.acceptanceCriteria.length >= 3 && !hasActionVerbs) {
    errors.push("spec_ac_no_action_verbs");
  }

  // DoD: must mention "test", "teste", "testes", "testing", "tests"
  if (!/\bteste?s?\b|\btesting\b/i.test(input.dod)) {
    errors.push("spec_dod_no_test_mention");
  }

  return errors;
}
