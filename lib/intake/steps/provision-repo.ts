import type { GenesisPayload, PipelineStep } from "../types.js";
import { buildScaffoldPlan } from "../lib/scaffold-service.js";
import { ensureRepositoryProvisioning } from "../lib/repository-provision-service.js";

export const provisionRepoStep: PipelineStep = {
  name: "provision-repo",

  shouldRun: (payload) => !payload.dry_run && (
    payload.project_map?.is_greenfield === true ||
    payload.impact?.is_greenfield === true ||
    payload.project_map?.remote_only === true ||
    !!payload.metadata.repo_path
  ),

  async execute(payload, ctx): Promise<GenesisPayload> {
    const isGreenfield = payload.project_map?.is_greenfield === true || payload.impact?.is_greenfield === true;
    const plan = isGreenfield
      ? (payload.metadata.scaffold_plan ?? await buildScaffoldPlan(payload, ctx))
      : null;
    if (plan) {
      ctx.log(`Provisioning repository ${plan.owner}/${plan.repo_name}`);
    } else {
      ctx.log("Ensuring existing repository target is locally usable");
    }

    const provisioning = await ensureRepositoryProvisioning(payload, ctx);
    if (provisioning.ready !== true) {
      throw new Error(`Repository provisioning failed: ${provisioning.reason ?? "unknown_reason"}`);
    }

    return {
      ...payload,
      step: "provision-repo",
      provisioning,
      metadata: {
        ...payload.metadata,
        scaffold_plan: plan ?? payload.metadata.scaffold_plan ?? null,
        repo_url: provisioning.repo_url ?? payload.metadata.repo_url ?? null,
        repo_path: provisioning.repo_local ?? payload.metadata.repo_path ?? null,
        project_slug: plan?.project_slug ?? payload.metadata.project_slug ?? null,
        project_name: payload.metadata.project_name ?? plan?.project_slug ?? null,
        stack_hint: payload.metadata.stack_hint ?? plan?.stack ?? null,
        repo_target_source: plan?.repo_target_source ?? payload.metadata.repo_target_source ?? null,
        repo_provisioned: provisioning.ready === true,
      },
    };
  },
};
