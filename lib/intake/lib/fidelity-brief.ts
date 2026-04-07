import type { DeliveryTarget, FidelityBrief, FidelityConfidence, FidelityDeliverable, PipelineMetadata, Spec } from "../types.js";

const HARD_CONSTRAINT_PATTERNS: Array<{ regex: RegExp; value: string }> = [
  { regex: /\bmust use ([a-z0-9.+#_-]+)/i, value: "explicit_stack_requirement" },
  { regex: /\buse ([a-z0-9.+#_-]+)\b/i, value: "explicit_technology_requirement" },
  { regex: /\bwithout ([a-z0-9.+#_-]+)/i, value: "explicit_technology_exclusion" },
  { regex: /\bself-host(?:ed)?\b/i, value: "self_hosted" },
  { regex: /\boffline\b/i, value: "offline_capable" },
  { regex: /\bopen source\b/i, value: "open_source_only" },
];

const SOFT_PREFERENCE_PATTERNS: Array<{ regex: RegExp; value: string }> = [
  { regex: /\bprefer\b/i, value: "explicit_preference" },
  { regex: /\bclean (?:architecture|code)\b/i, value: "clean_code_preference" },
  { regex: /\bmodern\b/i, value: "modern_stack_preference" },
  { regex: /\bsimple\b/i, value: "simplicity_preference" },
];

const QUALITY_EXPECTATION_PATTERNS: Array<{ regex: RegExp; value: string }> = [
  { regex: /\bproduction[- ]ready\b/i, value: "production_ready" },
  { regex: /\bhigh[- ]performance\b|\bperformant\b/i, value: "performance" },
  { regex: /\bsecure\b|\bsecurity\b/i, value: "security" },
  { regex: /\bscalable\b|\bscale\b/i, value: "scalability" },
  { regex: /\bmaintainable\b|\bclean code\b/i, value: "maintainability" },
  { regex: /\bwell[- ]tested\b|\bhigh[- ]quality\b/i, value: "high_quality" },
];

const RISK_SIGNAL_PATTERNS: Array<{ regex: RegExp; value: string }> = [
  { regex: /\bauth\b|\blogin\b|\boauth\b|\bjwt\b|\brbac\b|\bpermission/i, value: "auth_security_sensitive" },
  { regex: /\bpayment\b|\bbilling\b|\bsubscription/i, value: "payment_sensitive" },
  { regex: /\bmigration\b|\bschema\b|\bdatabase\b/i, value: "data_model_change" },
  { regex: /\bworker\b|\bqueue\b|\bcron\b|\bbackground job\b/i, value: "async_orchestration" },
  { regex: /\bintegration\b|\bwebhook\b|\bthird-party\b|\bexternal service\b/i, value: "external_integration" },
  { regex: /\bperformance\b|\bhigh traffic\b|\blow latency\b/i, value: "performance_sensitive" },
];

const EXPLICIT_NON_GOAL_PATTERNS: Array<{ regex: RegExp; value: string }> = [
  { regex: /\bdo not add ([^.\n]+)/i, value: "no_extra_features" },
  { regex: /\bout of scope\b/i, value: "explicit_out_of_scope" },
  { regex: /\bnot required\b/i, value: "explicit_not_required" },
];

function unique(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value && value.trim()))));
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function inferDeliverable(rawIdea: string, spec: Spec | undefined, metadata: PipelineMetadata | undefined): FidelityDeliverable {
  const target = spec?.delivery_target ?? metadata?.delivery_target;
  if (target && target !== "unknown") return target;
  const text = rawIdea.toLowerCase();
  if (/\bcli\b|\bcommand line\b/.test(text)) return "cli";
  if (/\bapi\b|\bendpoint\b|\brest\b|\bgraphql\b/.test(text)) return "api";
  if (/\bweb app\b|\bfrontend\b|\bui\b|\bdashboard\b|\bpage\b/.test(text)) return "web-ui";
  if (/\blibrary\b|\bsdk\b|\bpackage\b/.test(text)) return "library";
  if (/\bautomation\b|\bworker\b|\bjob\b|\bbot\b/.test(text)) return "automation";
  return "unknown";
}

function inferPrimaryObjective(rawIdea: string, spec?: Spec): string {
  if (spec?.objective?.trim()) return normalizeText(spec.objective);
  const sentence = rawIdea.split(/(?<=[.!?])\s+/)[0] ?? rawIdea;
  return normalizeText(sentence);
}

function collectMatches(text: string, patterns: Array<{ regex: RegExp; value: string }>): string[] {
  return unique(patterns.map((pattern) => (pattern.regex.test(text) ? pattern.value : null)));
}

function deriveAmbiguityFlags(rawIdea: string, deliverable: FidelityDeliverable, requestedStack?: string | null, inferredStack?: string | null, spec?: Spec): string[] {
  const flags: string[] = [];
  if (deliverable === "unknown") flags.push("ambiguous_deliverable");
  if (!requestedStack && !inferredStack && /\bbuild|create|make\b/i.test(rawIdea) && deliverable !== "unknown") {
    flags.push("missing_stack_preference");
  }
  if (!spec?.scope_v1?.length) flags.push("missing_structured_scope");
  if (spec && spec.acceptance_criteria.length === 0) flags.push("missing_acceptance_criteria");
  return unique(flags);
}

function deriveConfidence(ambiguityFlags: string[], spec?: Spec, metadata?: PipelineMetadata): FidelityConfidence {
  if (metadata?.stack_confidence === "high" && ambiguityFlags.length === 0 && (spec?.acceptance_criteria.length ?? 0) >= 2) {
    return "high";
  }
  if (ambiguityFlags.some((flag) => flag === "ambiguous_deliverable" || flag === "missing_structured_scope")) {
    return "low";
  }
  return "medium";
}

export function buildFidelityBrief(opts: {
  rawIdea: string;
  spec?: Spec;
  metadata?: PipelineMetadata;
}): FidelityBrief {
  const rawIdea = normalizeText(opts.rawIdea);
  const spec = opts.spec;
  const metadata = opts.metadata;
  const combinedText = [
    rawIdea,
    spec?.objective,
    spec?.constraints,
    ...(spec?.scope_v1 ?? []),
    ...(spec?.out_of_scope ?? []),
    ...(spec?.acceptance_criteria ?? []),
    ...(spec?.definition_of_done ?? []),
    ...(spec?.risks ?? []),
  ].filter(Boolean).join("\n");

  const requestedDeliverable = inferDeliverable(rawIdea, spec, metadata);
  const requestedStack = metadata?.stack_hint ?? null;
  const inferredStack = requestedStack ?? null;
  const hardConstraints = collectMatches(combinedText, HARD_CONSTRAINT_PATTERNS);
  const softPreferences = collectMatches(combinedText, SOFT_PREFERENCE_PATTERNS);
  const explicitNonGoals = unique([
    ...collectMatches(combinedText, EXPLICIT_NON_GOAL_PATTERNS),
    ...(spec?.out_of_scope ?? []).map((item) => normalizeText(item)),
  ]);
  const qualityExpectations = collectMatches(combinedText, QUALITY_EXPECTATION_PATTERNS);
  const riskSignals = collectMatches(combinedText, RISK_SIGNAL_PATTERNS);
  const ambiguityFlags = deriveAmbiguityFlags(rawIdea, requestedDeliverable, requestedStack, inferredStack, spec);
  const confidence = deriveConfidence(ambiguityFlags, spec, metadata);

  return {
    primary_objective: inferPrimaryObjective(rawIdea, spec),
    requested_deliverable: requestedDeliverable,
    requested_stack: requestedStack,
    inferred_stack: inferredStack,
    hard_constraints: hardConstraints,
    soft_preferences: softPreferences,
    explicit_non_goals: explicitNonGoals,
    quality_expectations: qualityExpectations,
    ambiguity_flags: ambiguityFlags,
    risk_signals: riskSignals,
    confidence,
  };
}
