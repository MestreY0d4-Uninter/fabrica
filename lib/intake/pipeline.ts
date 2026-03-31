/**
 * intake/pipeline.ts — Genesis pipeline orchestrator.
 *
 * Sequences all pipeline steps, handling errors and telemetry.
 * Each step enriches the payload; the orchestrator passes it through.
 */
import type { GenesisPayload, PipelineArtifact, PipelineStep, StepContext } from "./types.js";
import { cleanupArtifacts } from "./lib/artifact-cleanup.js";
import { buildForumTopicArtifactId } from "./lib/artifact-ids.js";
import { log as auditLog } from "../audit.js";
import { receiveStep } from "./steps/receive.js";
import { classifyStep } from "./steps/classify.js";
import { researchStep } from "./steps/research.js";
import { interviewStep } from "./steps/interview.js";
import { conductInterviewStep } from "./steps/conduct-interview.js";
import { generateSpecStep } from "./steps/generate-spec.js";
import { mapProjectStep } from "./steps/map-project.js";
import { impactStep } from "./steps/impact.js";
import { scaffoldStep, scaffoldPassthroughStep } from "./steps/scaffold.js";
import { provisionRepoStep } from "./steps/provision-repo.js";
import { registerStep } from "./steps/register.js";
import { qaContractStep } from "./steps/qa-contract.js";
import { securityReviewStep } from "./steps/security-review.js";
import { createTaskStep } from "./steps/create-task.js";
import { triageStep } from "./steps/triage.js";

/**
 * All pipeline steps in execution order.
 * Steps are skipped if shouldRun returns false.
 */
const PIPELINE_STEPS: PipelineStep[] = [
  receiveStep,
  classifyStep,
  researchStep,
  interviewStep,
  conductInterviewStep,
  generateSpecStep,
  mapProjectStep,
  impactStep,
  qaContractStep,
  provisionRepoStep,
  scaffoldStep,
  scaffoldPassthroughStep,
  registerStep,
  securityReviewStep,
  createTaskStep,
  triageStep,
];

export type PipelineResult = {
  success: boolean;
  payload: GenesisPayload;
  steps_executed: string[];
  steps_skipped: string[];
  error?: string;
  duration_ms: number;
  /**
   * Artifacts created during the pipeline (e.g. GitHub repo, forum topic).
   * Populated from the final payload so callers can detect partial-success / orphaned state.
   */
  artifacts?: PipelineArtifact[];
};

/**
 * Run the full Genesis pipeline.
 */
export async function runPipeline(
  initialPayload: GenesisPayload,
  ctx: StepContext,
): Promise<PipelineResult> {
  const start = Date.now();
  let payload = { ...initialPayload };
  const stepsExecuted: string[] = [];
  const stepsSkipped: string[] = [];

  for (const step of PIPELINE_STEPS) {
    try {
      if (!step.shouldRun(payload)) {
        stepsSkipped.push(step.name);
        if (payload.dry_run) {
          ctx.log(`[pipeline] step_skipped: ${step.name} (reason: dry_run)`);
        }
        continue;
      }

      ctx.log(`--- Step: ${step.name} ---`);
      const stepStart = Date.now();
      payload = await step.execute(payload, ctx);
      const stepDuration = Date.now() - stepStart;
      stepsExecuted.push(step.name);
      ctx.log(`Step ${step.name} completed in ${stepDuration}ms`);
    } catch (err: unknown) {
      ctx.log(`Step ${step.name} FAILED: ${String(err)}`);
      const failureArtifacts = mergeArtifacts(deriveArtifacts(payload), extractErrorArtifacts(err));
      if (failureArtifacts.length > 0) {
        const cleanupResults = await cleanupArtifacts(failureArtifacts, {
          log: ctx.log,
          dryRun: initialPayload.dry_run ?? false,
        });
        const needsManual = cleanupResults.filter((r) => r.action === "needs_manual_cleanup");
        if (needsManual.length > 0) {
          ctx.log(`[pipeline] ${needsManual.length} artifact(s) need manual cleanup after failure`);
          await auditLog(ctx.workspaceDir, "pipeline_orphaned_artifacts", {
            session_id: initialPayload.session_id,
            artifacts: needsManual.map((r) => ({ type: r.artifact.type, id: r.artifact.id })),
            error: String(err),
          });
        }
      }
      return {
        success: false,
        payload,
        steps_executed: stepsExecuted,
        steps_skipped: stepsSkipped,
        error: `Step ${step.name} failed: ${String(err)}`,
        duration_ms: Date.now() - start,
        artifacts: failureArtifacts,
      };
    }
  }

  return {
    success: true,
    payload,
    steps_executed: stepsExecuted,
    steps_skipped: stepsSkipped,
    duration_ms: Date.now() - start,
    artifacts: deriveArtifacts(payload),
  };
}

/**
 * Derive created artifacts from the pipeline payload.
 * Used to detect partial-success scenarios (e.g. repo created but project not registered).
 */
function deriveArtifacts(payload: GenesisPayload): PipelineArtifact[] {
  const artifacts: PipelineArtifact[] = [];
  if (payload.provisioning?.created && payload.provisioning?.repo_url) {
    const provider = payload.provisioning.provider === "gitlab" ? "gitlab_repo" : "github_repo";
    artifacts.push({ type: provider, id: payload.provisioning.repo_url });
  }
  if (
    payload.metadata.project_topic_created === true &&
    payload.metadata.channel_id &&
    payload.metadata.message_thread_id != null
  ) {
    artifacts.push({
      type: "forum_topic",
      id: buildForumTopicArtifactId(payload.metadata.channel_id, payload.metadata.message_thread_id),
    });
  }
  if (payload.issues?.length) {
    for (const issue of payload.issues) {
      artifacts.push({ type: "github_issue", id: String(issue.number) });
    }
  }
  return artifacts;
}

function extractErrorArtifacts(err: unknown): PipelineArtifact[] {
  const artifacts = (err as { artifacts?: unknown })?.artifacts;
  if (!Array.isArray(artifacts)) {
    return [];
  }
  return artifacts.filter(isPipelineArtifact);
}

function isPipelineArtifact(value: unknown): value is PipelineArtifact {
  if (!value || typeof value !== "object") {
    return false;
  }
  const artifact = value as { type?: unknown; id?: unknown };
  return (
    typeof artifact.id === "string" &&
    (artifact.type === "github_repo" ||
      artifact.type === "gitlab_repo" ||
      artifact.type === "forum_topic" ||
      artifact.type === "github_issue")
  );
}

function mergeArtifacts(primary: PipelineArtifact[], secondary: PipelineArtifact[]): PipelineArtifact[] {
  const merged: PipelineArtifact[] = [];
  const seen = new Set<string>();
  for (const artifact of [...primary, ...secondary]) {
    const key = `${artifact.type}:${artifact.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(artifact);
  }
  return merged;
}
