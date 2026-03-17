/**
 * Triage decision logic — effort, priority, DoR validation.
 * Pure logic port from triage.sh.
 */
import type { IdeaType, DeliveryTarget, TriagePriority, TriageEffort } from "../types.js";

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
  oosText: string;
  authSignal: boolean;
};

export type TriageDecision = {
  priority: TriagePriority;
  priorityLabel: string;
  effort: TriageEffort;
  effortLabel: string;
  typeLabel: string;
  targetState: string;
  dispatchLabel: string | null;
  level: string;
  readyForDispatch: boolean;
  errors: string[];
  specQualityBlock?: boolean;
};

/** Calculate effort from files changed and AC count. */
export function calculateEffort(filesChanged: number, acCount: number): TriageEffort {
  if (filesChanged <= 3 && acCount <= 3) return "small";
  if (filesChanged <= 10 && acCount <= 7) return "medium";
  if (filesChanged <= 25 && acCount <= 15) return "large";
  return "xlarge";
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

  // Auth gate
  let authSignal = input.authSignal;
  if (!authSignal) {
    const signalText = `${input.rawIdea} ${input.objective}`.toLowerCase();
    authSignal = AUTH_REGEX.test(signalText);
  }

  if (authSignal) {
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

/** Run full triage logic. */
export function runTriageLogic(input: TriageInput, matrix: TriageMatrix): TriageDecision {
  const effort = calculateEffort(input.filesChanged, input.acCount);
  const { priority, label: priorityLabel } = calculatePriority(input.type, effort, input.totalRisks, matrix);

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
    dod: input.scopeText ?? "",
  });
  const specQualityBlock = specQualityErrors.length > 0;

  return {
    priority, priorityLabel, effort, effortLabel,
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
