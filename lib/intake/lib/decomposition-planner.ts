import type { DeliveryTarget, Spec, Triage } from "../types.js";

type CapabilityArea =
  | "auth"
  | "api"
  | "data"
  | "worker"
  | "notifications"
  | "frontend"
  | "qa"
  | "integration"
  | "core";

export type DecompositionChildDraft = {
  title: string;
  description: string;
  objective: string;
  scopeItems: string[];
  acceptanceCriteria: string[];
  definitionOfDone: string[];
  recommendedLevel: "junior" | "medior" | "senior";
  estimatedEffort: "small" | "medium" | "large";
  dependencyHints: string[];
  dependencyIndexes: number[];
  capabilityArea: CapabilityArea;
  parallelizable: boolean;
};

type PlannedChild = {
  capabilityArea: CapabilityArea;
  scopeItems: string[];
};

const CAPABILITY_PATTERNS: Array<{ area: CapabilityArea; label: string; regex: RegExp }> = [
  { area: "auth", label: "Authentication & Access", regex: /\b(auth|oauth|jwt|login|register|session|permission|rbac|role)\b/i },
  { area: "worker", label: "Background Jobs & Automation", regex: /\b(worker|background|queue|job|scheduler|reminder|async|cron)\b/i },
  { area: "notifications", label: "Notifications & Delivery", regex: /\b(notification|notify|email|sms|webhook|alert|message)\b/i },
  { area: "frontend", label: "Frontend & UX", regex: /\b(ui|frontend|page|screen|dashboard|view|form)\b/i },
  { area: "data", label: "Data Model & Persistence", regex: /\b(database|schema|model|migration|persist|storage|repository|crud)\b/i },
  { area: "api", label: "API & Application Flow", regex: /\b(api|endpoint|route|http|rest|graphql|handler)\b/i },
  { area: "integration", label: "Integrations & External Services", regex: /\b(integration|provider|third-party|external|sync|import|export)\b/i },
  { area: "qa", label: "QA, Docs & Release Readiness", regex: /\b(test|qa|coverage|document|docs|guide|readme|validation)\b/i },
  { area: "core", label: "Core Workflow", regex: /./i },
];

const AREA_LABEL: Record<CapabilityArea, string> = Object.fromEntries(
  CAPABILITY_PATTERNS.map((entry) => [entry.area, entry.label]),
) as Record<CapabilityArea, string>;

function normalizeLines(items: string[]): string[] {
  return items.map((item) => item.trim()).filter(Boolean);
}

function detectCapabilityArea(text: string, deliveryTarget?: DeliveryTarget): CapabilityArea {
  const normalized = text.trim();
  for (const entry of CAPABILITY_PATTERNS) {
    if (entry.regex.test(normalized)) return entry.area;
  }
  if (deliveryTarget === "api") return "api";
  if (deliveryTarget === "web-ui") return "frontend";
  return "core";
}

function matchesArea(text: string, area: CapabilityArea): boolean {
  const entry = CAPABILITY_PATTERNS.find((candidate) => candidate.area === area);
  return entry ? entry.regex.test(text) : false;
}

function estimateEffort(scopeItems: string[], area: CapabilityArea): "small" | "medium" | "large" {
  if (scopeItems.length >= 3 || ["auth", "worker", "integration"].includes(area)) return "large";
  if (scopeItems.length === 2 || ["api", "data", "frontend", "notifications"].includes(area)) return "medium";
  return "small";
}

function recommendedLevelFor(area: CapabilityArea, estimatedEffort: "small" | "medium" | "large"): "junior" | "medior" | "senior" {
  if (estimatedEffort === "large") return "senior";
  if (["auth", "worker", "integration"].includes(area)) return "senior";
  if (estimatedEffort === "medium") return "medior";
  if (area === "qa") return "junior";
  return "medior";
}

function isFoundationArea(area: CapabilityArea): boolean {
  return area === "auth" || area === "data" || area === "core";
}

function filterRelevantItems(items: string[], scopeItems: string[], area: CapabilityArea): string[] {
  const normalized = normalizeLines(items);
  if (normalized.length === 0) return [];
  const scopeText = scopeItems.join(" ");
  const matches = normalized.filter((item) => matchesArea(item, area) || scopeItems.some((scopeItem) => item.includes(scopeItem)) || item.includes(scopeText));
  if (matches.length > 0) return matches;
  return normalized.slice(0, Math.min(normalized.length, Math.max(2, scopeItems.length)));
}

function buildObjective(parentObjective: string, area: CapabilityArea, scopeItems: string[]): string {
  const label = AREA_LABEL[area];
  const primaryScope = scopeItems[0] ?? parentObjective;
  return `Deliver the ${label.toLowerCase()} slice of the parent initiative by completing ${primaryScope.toLowerCase()}.`;
}

function buildDependencyIndexes(area: CapabilityArea, priorAreas: CapabilityArea[]): number[] {
  const indexes: number[] = [];
  priorAreas.forEach((priorArea, index) => {
    if (isFoundationArea(priorArea) && !isFoundationArea(area)) indexes.push(index);
    if (area !== "auth" && priorArea === "auth") indexes.push(index);
    if (["api", "frontend", "worker", "notifications"].includes(area) && priorArea === "data") indexes.push(index);
    if (["worker", "notifications", "integration"].includes(area) && priorArea === "api") indexes.push(index);
  });
  return Array.from(new Set(indexes));
}

function buildDependencyHints(area: CapabilityArea, priorAreas: CapabilityArea[], allAreas: CapabilityArea[]): string[] {
  const hints: string[] = [];
  if (area !== "auth" && allAreas.includes("auth")) hints.push("Coordinate with the authentication/access child before changing protected flows.");
  if (["worker", "notifications", "integration"].includes(area) && allAreas.includes("api")) {
    hints.push("Align payload contracts and triggering conditions with the API/application-flow child.");
  }
  if (["api", "frontend", "worker", "notifications"].includes(area) && allAreas.includes("data")) {
    hints.push("Reuse the canonical data model/migration decisions from the persistence child.");
  }
  if (priorAreas.some(isFoundationArea) && !isFoundationArea(area)) {
    hints.push("Start after foundational contracts are stable, but keep implementation isolated enough for a separate PR.");
  }
  return Array.from(new Set(hints));
}

function buildPlannedChildren(spec: Spec, effort: Triage["effort"]): PlannedChild[] {
  const scopeItems = normalizeLines(spec.scope_v1);
  const maxChildren = effort === "xlarge" ? 4 : 3;
  const orderedAreas: CapabilityArea[] = [];
  const areaToItems = new Map<CapabilityArea, string[]>();

  for (const item of scopeItems) {
    const area = detectCapabilityArea(item, spec.delivery_target);
    if (!areaToItems.has(area)) {
      areaToItems.set(area, []);
      orderedAreas.push(area);
    }
    areaToItems.get(area)!.push(item);
  }

  let planned = orderedAreas.map((area) => ({ capabilityArea: area, scopeItems: areaToItems.get(area) ?? [] }));

  if (planned.length > maxChildren) {
    const kept = planned.slice(0, maxChildren - 1);
    const merged = planned.slice(maxChildren - 1).flatMap((entry) => entry.scopeItems);
    kept.push({ capabilityArea: planned[maxChildren - 1]?.capabilityArea ?? "core", scopeItems: merged });
    planned = kept;
  }

  if (planned.length === 1 && scopeItems.length >= 4) {
    const midpoint = Math.ceil(scopeItems.length / 2);
    planned = [
      { capabilityArea: planned[0]?.capabilityArea ?? "core", scopeItems: scopeItems.slice(0, midpoint) },
      { capabilityArea: planned[0]?.capabilityArea ?? "core", scopeItems: scopeItems.slice(midpoint) },
    ];
  }

  return planned.filter((entry) => entry.scopeItems.length > 0);
}

function buildDescription(opts: {
  issueNumber: number;
  parentObjective: string;
  child: DecompositionChildDraft;
  outOfScope: string[];
  constraints?: string;
  risks: string[];
}): string {
  const { issueNumber, child, outOfScope, constraints, risks } = opts;
  return [
    "## Objective",
    child.objective,
    "",
    "## Parent Issue",
    `Parent issue: #${issueNumber}`,
    "",
    "## Capability Area",
    `- ${AREA_LABEL[child.capabilityArea]}`,
    "",
    "## Execution Profile",
    `- Recommended level: ${child.recommendedLevel}`,
    `- Estimated effort: ${child.estimatedEffort}`,
    `- Parallelizable: ${child.parallelizable ? "yes" : "no"}`,
    ...child.dependencyHints.map((hint) => `- Dependency hint: ${hint}`),
    "",
    "## Scope",
    ...child.scopeItems.map((item) => `- ${item}`),
    "",
    "## Acceptance Criteria",
    ...child.acceptanceCriteria.map((item) => `- ${item}`),
    "",
    "## Definition of Done",
    ...child.definitionOfDone.map((item) => `- ${item}`),
    ...(outOfScope.length > 0 ? ["", "## Out of Scope", ...outOfScope.map((item) => `- ${item}`)] : []),
    ...(constraints?.trim() ? ["", "## Constraints", constraints.trim()] : []),
    ...(risks.length > 0 ? ["", "## Risks / Coordination Notes", ...risks.map((item) => `- ${item}`)] : []),
  ].join("\n");
}

export function buildDecompositionChildDrafts(spec: Spec, issueNumber: number, effort: Triage["effort"]): DecompositionChildDraft[] {
  const plannedChildren = buildPlannedChildren(spec, effort);
  const allAreas = plannedChildren.map((entry) => entry.capabilityArea);
  const areaCounts = new Map<CapabilityArea, number>();

  return plannedChildren.map((plannedChild, index) => {
    const estimatedEffort = estimateEffort(plannedChild.scopeItems, plannedChild.capabilityArea);
    const recommendedLevel = recommendedLevelFor(plannedChild.capabilityArea, estimatedEffort);
    const priorAreas = plannedChildren.slice(0, index).map((entry) => entry.capabilityArea);
    const dependencyIndexes = buildDependencyIndexes(plannedChild.capabilityArea, priorAreas);
    const dependencyHints = buildDependencyHints(plannedChild.capabilityArea, priorAreas, allAreas);
    const parallelizable = dependencyIndexes.length === 0 && !isFoundationArea(plannedChild.capabilityArea);
    const acceptanceCriteria = filterRelevantItems(spec.acceptance_criteria, plannedChild.scopeItems, plannedChild.capabilityArea);
    const definitionOfDone = filterRelevantItems(spec.definition_of_done, plannedChild.scopeItems, plannedChild.capabilityArea);
    const occurrence = (areaCounts.get(plannedChild.capabilityArea) ?? 0) + 1;
    areaCounts.set(plannedChild.capabilityArea, occurrence);
    const titleSuffix = occurrence > 1 ? ` ${occurrence}` : "";
    const title = `${spec.title} — ${AREA_LABEL[plannedChild.capabilityArea]}${titleSuffix}`;
    const child: DecompositionChildDraft = {
      title,
      objective: buildObjective(spec.objective, plannedChild.capabilityArea, plannedChild.scopeItems),
      scopeItems: plannedChild.scopeItems,
      acceptanceCriteria,
      definitionOfDone,
      recommendedLevel,
      estimatedEffort,
      dependencyHints,
      dependencyIndexes,
      capabilityArea: plannedChild.capabilityArea,
      parallelizable,
      description: "",
    };
    child.description = buildDescription({
      issueNumber,
      parentObjective: spec.objective,
      child,
      outOfScope: normalizeLines(spec.out_of_scope),
      constraints: spec.constraints,
      risks: normalizeLines(spec.risks),
    });
    return child;
  });
}
