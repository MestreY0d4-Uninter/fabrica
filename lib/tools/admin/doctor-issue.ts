import { jsonResult } from "../../runtime/plugin-sdk-compat.js";
import type { PluginContext } from "../../context.js";
import type { ToolContext } from "../../types.js";
import { requireWorkspaceDir } from "../helpers.js";
import { runIssueDoctor } from "../../setup/doctor-run.js";

export function createDoctorIssueTool(ctx: PluginContext) {
  return (toolCtx: ToolContext) => ({
    name: "doctor_issue",
    label: "Doctor Issue",
    description:
      "Inspect one Fabrica issue/run with convergence metadata, PR context, issue labels, and a recommended next action.",
    parameters: {
      type: "object",
      required: ["projectSlug", "issueId"],
      properties: {
        projectSlug: { type: "string", description: "Project slug (for example: fabrica or my-project)." },
        issueId: { type: "number", description: "Issue number to inspect." },
      },
    },
    async execute(_id: string, params: Record<string, unknown>) {
      const workspaceDir = requireWorkspaceDir(toolCtx);
      const projectSlug = String(params.projectSlug ?? "").trim();
      const issueId = Number(params.issueId);
      if (!projectSlug) throw new Error("projectSlug is required");
      if (!Number.isFinite(issueId)) throw new Error("issueId must be a number");
      const result = await runIssueDoctor({
        workspacePath: workspaceDir,
        projectSlug,
        issueId,
        runCommand: ctx.runCommand,
        pluginConfig: ctx.pluginConfig as Record<string, unknown>,
      });
      return jsonResult(result);
    },
  });
}
