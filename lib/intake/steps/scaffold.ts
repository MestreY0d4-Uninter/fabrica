/**
 * Step 7: Scaffold greenfield project.
 * The plan is resolved in TS; the shell only executes host-level repo/bootstrap work.
 */
import fsNode from "node:fs/promises";
import path from "node:path";
import type { PipelineStep, GenesisPayload } from "../types.js";
import {
  buildScaffoldPlan,
  executeScaffoldPlan,
  parseScaffoldOutput,
} from "../lib/scaffold-service.js";
import { ensureProjectTestEnvironment, supportsGreenfieldScaffold } from "../../test-env/bootstrap.js";
import { generateQaContract } from "../../quality/qa-contracts.js";

export const scaffoldStep: PipelineStep = {
  name: "scaffold",

  shouldRun: (payload) => payload.impact?.is_greenfield === true && !payload.dry_run,

  async execute(payload, ctx): Promise<GenesisPayload> {
    ctx.log("Greenfield project — running scaffold");
    const plan = payload.metadata.scaffold_plan ?? await buildScaffoldPlan(payload, ctx);
    ctx.log(`Scaffold plan: stack=${plan.stack}, target=${plan.owner}/${plan.repo_name}`);

    const result = await executeScaffoldPlan(payload, ctx, plan, 120000);

    if (result.exitCode !== 0) {
      ctx.log(`Scaffold failed: ${result.stderr}`);
      return {
        ...result.plannedPayload,
        step: "scaffold",
        scaffold: { created: false, reason: "script_failed" },
      };
    }

    try {
      const scaffold = parseScaffoldOutput(result.stdout);
      if (scaffold.created && scaffold.repo_local && scaffold.stack && supportsGreenfieldScaffold(scaffold.stack)) {
        const bootstrap = await ensureProjectTestEnvironment({
          repoPath: scaffold.repo_local,
          stack: scaffold.stack,
          mode: "scaffold",
          runCommand: ctx.runCommand,
        });
        if (!bootstrap.ready) {
          ctx.log(`Scaffold bootstrap failed: ${bootstrap.reason ?? "unknown reason"}`);
          return {
            ...result.plannedPayload,
            step: "scaffold",
            scaffold: { created: false, reason: bootstrap.reason ?? "bootstrap_failed" },
          };
        }
        ctx.log(
          bootstrap.skipped
            ? `Scaffold bootstrap already current (${bootstrap.packageManager})`
            : `Scaffold bootstrap completed (${bootstrap.packageManager})`,
        );
        // Overwrite qa.sh with TypeScript-generated content (replaces shell placeholder)
        if (payload.spec) {
          try {
            const contract = generateQaContract({
              spec: payload.spec,
              stack: scaffold.stack,
              acceptanceCriteria: payload.spec.acceptance_criteria,
            });
            const qaPath = path.join(scaffold.repo_local, "scripts", "qa.sh");
            await fsNode.mkdir(path.dirname(qaPath), { recursive: true });
            await fsNode.writeFile(qaPath, contract.script_content, { mode: 0o755 });
          } catch (err) {
            ctx.log(`Warning: could not write qa.sh: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      return {
        ...result.plannedPayload,
        step: "scaffold",
        provisioning: payload.provisioning,
        scaffold,
      };
    } catch (error) {
      ctx.log(`Could not parse scaffold output: ${error instanceof Error ? error.message : String(error)}`);
      return {
        ...result.plannedPayload,
        step: "scaffold",
        scaffold: { created: false, reason: "parse_error" },
      };
    }
  },
};

/**
 * Non-greenfield passthrough — marks scaffold as skipped.
 */
export const scaffoldPassthroughStep: PipelineStep = {
  name: "scaffold-passthrough",

  shouldRun: (payload) => !payload.impact?.is_greenfield || !!payload.dry_run,

  async execute(payload): Promise<GenesisPayload> {
    return {
      ...payload,
      step: "scaffold",
      scaffold: { created: false, reason: payload.dry_run ? "dry_run" : "not_greenfield" },
    };
  },
};
