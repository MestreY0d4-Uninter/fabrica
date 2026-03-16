/**
 * Step 12: Triage — prioritize, validate DoR, dispatch to workflow.
 */
import type { PipelineStep, GenesisPayload, Triage } from "../types.js";
import type { StateLabel } from "../../providers/provider.js";
import { runTriageLogic, type TriageMatrix } from "../lib/triage-logic.js";
import { loadConfig } from "../../config/index.js";

import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);

let cachedMatrix: TriageMatrix | null = null;

function loadMatrix(): TriageMatrix {
  if (cachedMatrix) return cachedMatrix;
  cachedMatrix = _require("../configs/triage-matrix.json") as TriageMatrix;
  return cachedMatrix;
}

export const triageStep: PipelineStep = {
  name: "triage",

  shouldRun: (payload) => !!payload.issues?.length && !payload.dry_run,

  async execute(payload, ctx): Promise<GenesisPayload> {
    const matrix = loadMatrix();
    const spec = payload.spec!;
    const impact = payload.impact;
    const issue = payload.issues![0];

    ctx.log(`Running triage for issue #${issue.number}`);

    const decision = runTriageLogic({
      type: spec.type,
      deliveryTarget: spec.delivery_target,
      acCount: spec.acceptance_criteria.length,
      scopeCount: spec.scope_v1.length,
      dodCount: spec.definition_of_done.length,
      filesChanged: impact?.estimated_files_changed ?? 3,
      totalRisks: (impact?.risk_areas?.length ?? 0) + (payload.security?.spec_security_notes?.length ?? 0),
      objective: spec.objective,
      rawIdea: payload.raw_idea,
      acText: spec.acceptance_criteria.join(" "),
      scopeText: spec.scope_v1.join(" "),
      oosText: spec.out_of_scope.join(" "),
      authSignal: payload.metadata?.auth_gate?.signal ?? false,
    }, matrix);

    const repoUrl = payload.scaffold?.repo_url ?? payload.metadata?.repo_url ?? "";
    const repoPath =
      payload.provisioning?.repo_local
      ?? payload.scaffold?.repo_local
      ?? payload.metadata?.repo_path
      ?? payload.project_map?.root
      ?? undefined;
    const projectSlug =
      payload.metadata?.project_slug
      ?? payload.scaffold?.project_slug
      ?? payload.project_map?.project_slug;
    const resolvedConfig = projectSlug ? await loadConfig(ctx.workspaceDir, projectSlug).catch(() => null) : null;
    const initialLabel = resolvedConfig?.workflow.states[resolvedConfig.workflow.initial]?.label ?? "Planning";

    const allLabels = [decision.priorityLabel, decision.effortLabel];
    if (decision.typeLabel) allLabels.push(decision.typeLabel);
    if (!decision.readyForDispatch) allLabels.push("needs-human");
    const uniqueLabels = Array.from(new Set(allLabels.filter(Boolean)));

    if (ctx.createIssueProvider && repoPath) {
      try {
        const { provider } = await ctx.createIssueProvider({
          repoPath,
          projectSlug,
        });
        for (const label of uniqueLabels) {
          await provider.addLabel(issue.number, label);
        }

        if (decision.readyForDispatch) {
          await provider.transitionLabel(issue.number, initialLabel as StateLabel, decision.targetState as StateLabel);
          const dispatchLabels: string[] = [];
          if (decision.targetState === "To Do" && decision.dispatchLabel) {
            dispatchLabels.push(decision.dispatchLabel);
            dispatchLabels.push(`developer:${decision.level}`);
          } else if (decision.targetState === "To Do") {
            dispatchLabels.push(`developer:${decision.level}`);
          }
          for (const label of Array.from(new Set(dispatchLabels.filter(Boolean)))) {
            await provider.addLabel(issue.number, label);
          }
        }
      } catch {
        decision.errors.push(decision.readyForDispatch ? "planning_to_target_failed" : "apply_labels_failed");
      }
    } else if (repoUrl) {
      const match = repoUrl.match(/github\.com[/:]([^/]+\/[^/.]+)/);
      const ownerRepo = match?.[1] ?? repoUrl;
      try {
        await ctx.runCommand("gh", [
          "issue", "edit", String(issue.number),
          "--repo", ownerRepo,
          "--add-label", uniqueLabels.join(","),
        ], { timeout: 15000 });
      } catch {
        decision.errors.push("apply_labels_failed");
      }

      if (decision.readyForDispatch) {
        const transLabels = [decision.targetState];
        if (decision.targetState === "To Do" && decision.dispatchLabel) {
          transLabels.push(decision.dispatchLabel);
          transLabels.push(`developer:${decision.level}`);
        } else if (decision.targetState === "To Do") {
          transLabels.push(`developer:${decision.level}`);
        }

        try {
          await ctx.runCommand("gh", [
            "issue", "edit", String(issue.number),
            "--repo", ownerRepo,
            "--remove-label", initialLabel,
            "--add-label", transLabels.join(","),
          ], { timeout: 15000 });
        } catch {
          decision.errors.push("planning_to_target_failed");
        }
      }
    }

    const triage: Triage = {
      priority: decision.priority,
      effort: decision.effort,
      target_state: decision.targetState,
      project_slug: payload.scaffold?.project_slug ?? null,
      project_channel_id: null,
      labels_applied: uniqueLabels,
      issue_number: issue.number,
      ready_for_dispatch: decision.readyForDispatch && decision.errors.length === 0,
      errors: decision.errors,
    };

    ctx.log(`Triage: ${triage.priority}, effort=${triage.effort}, ready=${triage.ready_for_dispatch}`);

    return {
      ...payload,
      step: "triage",
      triage,
    };
  },
};
