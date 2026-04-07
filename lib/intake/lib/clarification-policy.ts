export type BootstrapClarificationKind = "stack" | "stack_and_name" | "name" | "scope";

export type ClarificationDecision = {
  ask: boolean;
  kind?: BootstrapClarificationKind;
  reason?: string;
};

export function detectScopeClarificationNeed(rawIdea: string, stackHint: string | null | undefined): ClarificationDecision {
  const text = rawIdea.toLowerCase();

  if (/\b(livre|free.?choice|your.?call|pode.?escolher|voc[eê].?decide|qualquer)\b/i.test(text)) {
    return { ask: false };
  }

  const subsystems = [
    /\bauth\b|\blogin\b|\bregister\b|\bjwt\b|\boauth\b/,
    /\bpayment\b|\bbilling\b|\bsubscription\b/,
    /\bemail\b|\bnotification\b|\balert\b|\bsms\b/,
    /\badmin\b|\bdashboard\b|\breport\b/,
    /\bqueue\b|\bworker\b|\bcron\b|\bjob\b/,
    /\bdatabase\b|\bmigration\b|\bschema\b/,
    /\bapi\b|\bwebhook\b|\bintegration\b|\bexternal service\b/,
  ].filter((regex) => regex.test(text)).length;

  const missingKeyTechChoice = !stackHint || (!/postgres|mysql|sqlite|mongodb/i.test(text) || !/jwt|oauth|session|rbac/i.test(text));
  if (subsystems >= 3 && missingKeyTechChoice) {
    return { ask: true, kind: "scope", reason: "scope_ambiguity_across_multiple_subsystems" };
  }

  return { ask: false };
}

export function decideBootstrapClarification(opts: {
  projectName?: string | null;
  stackHint?: string | null;
  scopeAmbiguous?: boolean;
}): ClarificationDecision {
  if (opts.scopeAmbiguous) {
    return { ask: true, kind: "scope", reason: "scope_ambiguity_requires_structuring" };
  }
  if (!opts.stackHint && !opts.projectName) {
    return { ask: true, kind: "stack_and_name", reason: "missing_stack_and_name" };
  }
  if (!opts.stackHint) {
    return { ask: true, kind: "stack", reason: "missing_stack" };
  }
  if (!opts.projectName) {
    return { ask: true, kind: "name", reason: "missing_project_name" };
  }
  return { ask: false };
}
