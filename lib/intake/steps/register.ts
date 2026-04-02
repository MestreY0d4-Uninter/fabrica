/**
 * Step 7b: Register scaffolded project.
 * Creates labels, projects.json entry and prompts via the TS-native project
 * registration path. The shell fallback is no longer part of the intake
 * control plane.
 */
import type { PipelineStep, GenesisPayload } from "../types.js";
import { log as auditLog } from "../../audit.js";
import { normalizeStackHint } from "../lib/stack-detection.js";
import { adaptStepRunCommand, registerProject } from "../../tools/admin/project-register.js";
import type { FabricaConfig } from "../../config/types.js";

export const registerStep: PipelineStep = {
  name: "register",

  shouldRun: (payload) =>
    (payload.provisioning?.ready === true || payload.scaffold?.created === true) &&
    !payload.dry_run &&
    Boolean(payload.metadata.channel_id),

  async execute(payload, ctx): Promise<GenesisPayload> {
    const name = payload.metadata.project_name
      ?? payload.provisioning?.repo_local?.split("/").filter(Boolean).at(-1)
      ?? payload.scaffold?.project_slug
      ?? payload.spec?.title;
    const repo = payload.provisioning?.repo_local
      ?? payload.scaffold?.repo_local
      ?? payload.metadata.repo_path
      ?? payload.scaffold?.repo_url
      ?? payload.metadata.repo_url;
    const channelId = payload.metadata.channel_id;
    const baseBranch = payload.provisioning?.default_branch ?? "main";
    const fail = (message: string): never => {
      ctx.log(`Register failed: ${message}`);
      throw new Error(message);
    };
    const resolvedName = name ?? fail("Missing project name or repository target for registration");
    const resolvedRepo = repo ?? fail("Missing project name or repository target for registration");
    const resolvedChannelId = channelId ?? fail("Missing channel binding for project registration");
    const createProjectTopic = payload.metadata.source === "telegram-dm-bootstrap";
    const resolvedStack = payload.metadata.stack_hint
      ? normalizeStackHint(payload.metadata.stack_hint) || null
      : null;

    try {
      const programmaticSources = ["telegram-dm-bootstrap", "genesis-trigger-script"];
      const projectWorkflowConfig: FabricaConfig | undefined =
        programmaticSources.includes(payload.metadata.source ?? "")
          ? { workflow: { reviewPolicy: "agent" } }
          : undefined;
      const output = await registerProject({
        workspaceDir: ctx.workspaceDir,
        route: {
          channel: "telegram",
          channelId: resolvedChannelId,
          messageThreadId: payload.metadata.message_thread_id,
        },
        name: resolvedName,
        repo: resolvedRepo,
        runCommand: adaptStepRunCommand(ctx.runCommand),
        runtime: ctx.runtime,
        config: ctx.config as any,
        pluginConfig: ctx.pluginConfig,
        baseBranch,
        deployBranch: baseBranch,
        createProjectTopic,
        stack: resolvedStack,
        projectWorkflowConfig,
      });
      if (
        programmaticSources.includes(payload.metadata.source ?? "") &&
        output.activeWorkflow.reviewPolicy !== "agent"
      ) {
        throw new Error(
          `Programmatic source "${payload.metadata.source}" registration resolved reviewPolicy="${output.activeWorkflow.reviewPolicy}" instead of "agent"`,
        );
      }

      ctx.log(`Project registered: ${output.success}`);
      if (output.success) {
        await auditLog(ctx.workspaceDir, "project_registered", {
          sessionId: payload.session_id,
          projectSlug: output.projectSlug ?? payload.metadata.project_slug ?? payload.scaffold?.project_slug ?? null,
          repoUrl: output.repoRemote ?? payload.provisioning?.repo_url ?? payload.scaffold?.repo_url ?? null,
          channelId: output.channelId ?? null,
          messageThreadId: output.messageThreadId ?? payload.metadata.message_thread_id ?? null,
        });
      }

      return {
        ...payload,
        step: "register",
        metadata: {
          ...payload.metadata,
          project_registered: output.success,
          project_topic_created: createProjectTopic && output.success && output.messageThreadId != null,
          project_slug: output.projectSlug ?? payload.metadata.project_slug,
          repo_path: resolvedRepo,
          channel_id: output.channelId,
          message_thread_id: output.messageThreadId ?? payload.metadata.message_thread_id,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log(`Register failed: ${message}`);
      throw err instanceof Error ? err : new Error(message);
    }
  },
};
