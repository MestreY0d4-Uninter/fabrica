/**
 * Step 12: Triage — prioritize, validate DoR, dispatch to workflow.
 */
import type { PipelineStep, GenesisPayload, Triage } from "../types.js";
import type { StateLabel } from "../../providers/provider.js";
import { runTriageLogic, type TriageMatrix } from "../lib/triage-logic.js";
import { buildDecompositionChildDrafts } from "../lib/decomposition-planner.js";
import { buildFidelityBrief } from "../lib/fidelity-brief.js";
import { loadConfig } from "../../config/index.js";
import { upsertTelegramBootstrapSession } from "../../dispatch/telegram-bootstrap-session.js";
import { updateIssueRuntime } from "../../projects/index.js";

import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);

let cachedMatrix: TriageMatrix | null = null;

function shouldAutoDecompose(decision: ReturnType<typeof runTriageLogic>): boolean {
  if (!decision.readyForDispatch || decision.specQualityBlock) return false;
  if (decision.effort === "xlarge") return true;
  if (decision.effort !== "large") return false;
  return decision.parallelizability !== "low" && decision.coupling !== "high";
}

function computeMaxParallelChildren(drafts: Array<{ parallelizable: boolean }>): number {
  const parallelizableCount = drafts.filter((draft) => draft.parallelizable).length;
  return Math.min(4, Math.max(1, parallelizableCount || 1));
}

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

    const fidelityBrief = buildFidelityBrief({
      rawIdea: payload.raw_idea,
      spec,
      metadata: payload.metadata,
    });

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
      acText: spec.acceptance_criteria.join("\n"),
      scopeText: spec.scope_v1.join("\n"),
      dodText: spec.definition_of_done.join("\n"),
      oosText: spec.out_of_scope.join("\n"),
      authSignal: /\b(login|register|jwt|oauth|auth|role-based access|rbac|permission)\b/i.test(`${payload.raw_idea} ${spec.objective}`),
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
    if (!decision.readyForDispatch || decision.specQualityBlock) allLabels.push("needs-human");
    const uniqueLabels = Array.from(new Set(allLabels.filter(Boolean)));

    const decompositionRequested = decision.readyForDispatch && !decision.specQualityBlock && ["large", "xlarge"].includes(decision.effort);
    const shouldDecompose = shouldAutoDecompose(decision);
    const decompositionDrafts = shouldDecompose ? buildDecompositionChildDrafts(spec, issue.number, decision.effort) : [];
    const canDecompose = decompositionDrafts.length >= 2;

    let createdChildIssueNumbers: number[] = [];

    if (ctx.createIssueProvider && repoPath) {
      try {
        const { provider } = await ctx.createIssueProvider({
          repoPath,
          projectSlug,
        });
        for (const label of uniqueLabels) {
          await provider.addLabel(issue.number, label);
        }

        if (decision.specQualityBlock) {
          await provider.addComment(issue.number, [
            "🚫 Spec quality gate blocked automatic dispatch.",
            "",
            "The request needs a stronger objective, more concrete scope items, and verifiable acceptance criteria before creating execution tasks.",
          ].join("\n"));
        } else if (canDecompose) {
          await provider.addLabel(issue.number, "decomposition:parent");
          const childIssues = [] as Array<{ iid: number; title: string; web_url: string }>;
          const createdChildren = [] as Array<{ iid: number; title: string; web_url: string; draft: typeof decompositionDrafts[number] }>;
          for (const draft of decompositionDrafts) {
            const child = await provider.createIssue(draft.title, draft.description, initialLabel as StateLabel);
            childIssues.push({ iid: child.iid, title: child.title, web_url: child.web_url });
            createdChildren.push({ iid: child.iid, title: child.title, web_url: child.web_url, draft });
            createdChildIssueNumbers.push(child.iid);
            for (const label of uniqueLabels) {
              await provider.addLabel(child.iid, label);
            }
            await provider.addLabel(child.iid, "decomposition:child");
            await provider.transitionLabel(child.iid, initialLabel as StateLabel, decision.targetState as StateLabel);
            if (decision.targetState === "To Do" && decision.dispatchLabel) {
              await provider.addLabel(child.iid, decision.dispatchLabel);
            }
            if (decision.targetState === "To Do") {
              await provider.addLabel(child.iid, `developer:${draft.recommendedLevel}`);
            }
          }
          if (projectSlug) {
            for (const child of createdChildren) {
              await updateIssueRuntime(ctx.workspaceDir, projectSlug, child.iid, {
                parentIssueId: issue.number,
                dependencyIssueIds: child.draft.dependencyIndexes.map((index) => createdChildren[index]?.iid).filter((value): value is number => Number.isFinite(value)),
                childReadyForDispatch: decision.targetState === "To Do",
                parallelizable: child.draft.parallelizable,
                recommendedLevel: child.draft.recommendedLevel,
                qualityCriticality: decision.qualityCriticality,
                riskProfile: decision.riskProfile,
                decompositionMode: "none",
                decompositionStatus: null,
              }).catch(() => {});
            }
            await updateIssueRuntime(ctx.workspaceDir, projectSlug, issue.number, {
              childIssueIds: createdChildIssueNumbers,
              maxParallelChildren: computeMaxParallelChildren(decompositionDrafts),
              qualityCriticality: decision.qualityCriticality,
              riskProfile: decision.riskProfile,
              decompositionMode: "parent_child",
              decompositionStatus: "active",
            }).catch(() => {});
          }
          await provider.addComment(issue.number, [
            "## Decomposition Plan",
            ...childIssues.map((child) => `- [ ] #${child.iid} ${child.title}`),
          ].join("\n"));
        } else if (decompositionRequested && shouldDecompose) {
          await provider.addLabel(issue.number, "needs-human");
          await provider.addComment(issue.number, [
            shouldDecompose
              ? "⚠️ Automatic decomposition was requested, but the generated spec did not yield at least two independently scoped child tasks."
              : "⚠️ This request is large, but triage detected high coupling / low parallelizability. Fabrica will keep it as one executable issue unless a human explicitly splits it.",
            "",
            shouldDecompose
              ? "Refine the scope/acceptance criteria or split the plan manually before dispatch."
              : "If you still want multiple child issues, split the plan manually along stable boundaries before dispatch.",
          ].join("\n"));
        } else if (decision.readyForDispatch) {
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
      complexity: decision.complexity,
      coupling: decision.coupling,
      parallelizability: decision.parallelizability,
      quality_criticality: decision.qualityCriticality,
      risk_profile: decision.riskProfile,
      target_state: decision.targetState,
      project_slug: payload.scaffold?.project_slug ?? null,
      project_channel_id: null,
      labels_applied: uniqueLabels,
      issue_number: issue.number,
      ready_for_dispatch: decision.readyForDispatch && decision.errors.length === 0 && !decision.specQualityBlock && !canDecompose,
      errors: [
        ...decision.errors,
        ...(decision.specQualityBlock ? ["spec_quality_block"] : []),
        ...(decompositionRequested && shouldDecompose && !canDecompose ? ["decomposition_needs_human"] : []),
      ],
      decomposition_mode: canDecompose ? "parent_child" : "none",
      child_issue_numbers: createdChildIssueNumbers,
    };

    ctx.log(`Triage: ${triage.priority}, effort=${triage.effort}, ready=${triage.ready_for_dispatch}`);

    const bootstrapConversationId = payload.metadata?.source === "telegram-dm-bootstrap"
      ? payload.metadata?.channel_id
      : null;
    if (bootstrapConversationId) {
      await upsertTelegramBootstrapSession(ctx.workspaceDir, {
        conversationId: String(bootstrapConversationId),
        rawIdea: payload.raw_idea,
        projectName: payload.metadata?.project_name ?? null,
        stackHint: payload.metadata?.stack_hint ?? null,
        repoUrl: payload.provisioning?.repo_url ?? payload.scaffold?.repo_url ?? payload.metadata?.repo_url ?? null,
        repoPath: payload.provisioning?.repo_local ?? payload.scaffold?.repo_local ?? payload.metadata?.repo_path ?? null,
        status: triage.ready_for_dispatch ? "dispatching" : "completed",
        bootstrapStep: triage.ready_for_dispatch ? "project_ticked" : "completed",
        projectSlug: payload.metadata?.project_slug ?? payload.scaffold?.project_slug ?? null,
        issueId: issue.number,
        issueUrl: issue.url,
        projectChannelId: triage.project_channel_id ?? payload.metadata?.channel_id ?? null,
        messageThreadId: payload.metadata?.message_thread_id ?? null,
        triageReadyForDispatch: triage.ready_for_dispatch,
        triageErrors: triage.errors,
      }).catch(() => {});
    }

    const resolvedProjectSlug = payload.metadata?.project_slug ?? payload.scaffold?.project_slug ?? null;
    if (resolvedProjectSlug) {
      await updateIssueRuntime(ctx.workspaceDir, resolvedProjectSlug, issue.number, {
        qualityCriticality: decision.qualityCriticality,
        riskProfile: decision.riskProfile,
      }).catch(() => {});
    }

    return {
      ...payload,
      step: "triage",
      fidelity_brief: fidelityBrief,
      metadata: {
        ...payload.metadata,
        fidelity_brief: fidelityBrief,
      },
      triage,
    };
  },
};
