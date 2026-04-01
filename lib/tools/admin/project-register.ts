/**
 * project_register — Register a new project with Fabrica.
 *
 * Atomically: validates repo, detects GitHub/GitLab provider, creates all 8 state labels (idempotent),
 * adds project entry to projects.json, and logs the event.
 *
 * Replaces the manual steps of running glab/gh label create + editing projects.json.
 */
import { jsonResult } from "../../runtime/plugin-sdk-compat.js";
import type { ToolContext } from "../../types.js";
import type { PluginContext } from "../../context.js";
import fs from "node:fs/promises";
import path from "node:path";
import {
  readProjects,
  writeProjects,
  emptyRoleWorkerState,
  acquireLock,
  releaseLock,
} from "../../projects/index.js";
import { resolveRepoPath } from "../../projects/index.js";
import { createProvider } from "../../providers/index.js";
import { log as auditLog } from "../../audit.js";
import { getAllRoleIds } from "../../roles/index.js";
import { getRoleLabels, OPERATIONAL_LABELS } from "../../workflow/index.js";
import { loadConfig } from "../../config/index.js";
import { DATA_DIR } from "../../setup/constants.js";
import { createProjectForumTopic } from "../../telegram/topic-service.js";
import { readFabricaTelegramConfig } from "../../telegram/config.js";
import { buildRouteRef, routeMatchesChannel, type RouteRef } from "../../projects/index.js";
import { buildForumTopicArtifactId } from "../../intake/lib/artifact-ids.js";
import type { PipelineArtifact } from "../../intake/types.js";

/**
 * Scaffold project directory with prompts/ folder and a README explaining overrides.
 * Returns true if files were created, false if they already existed.
 */
async function scaffoldPromptFiles(workspaceDir: string, projectName: string): Promise<boolean> {
  const projectDir = path.join(workspaceDir, DATA_DIR, "projects", projectName);
  const promptsDir = path.join(projectDir, "prompts");
  await fs.mkdir(promptsDir, { recursive: true });

  const readmePath = path.join(projectDir, "README.md");
  try {
    await fs.access(readmePath);
    return false;
  } catch {
    const roles = getAllRoleIds().join(", ");
    await fs.writeFile(readmePath, `# Project Overrides

This directory holds project-specific configuration that overrides the workspace defaults.

## Prompt Overrides

To override default worker instructions, create \`prompts/<role>.md\`:

Available roles: ${roles}

Example: \`prompts/developer.md\` overrides the default developer instructions for this project only.
Files here take priority over the workspace defaults in \`fabrica/prompts/\`.

## Workflow Overrides

To override the default workflow configuration, create \`workflow.yaml\` in this directory.

Only include the keys you want to override — everything else inherits from the workspace-level \`fabrica/workflow.yaml\`. The three-layer system is:

1. **Built-in defaults** (code)
2. **Workspace** — \`fabrica/workflow.yaml\`
3. **Project** — \`fabrica/projects/${projectName}/workflow.yaml\` (this directory)

Example — use a different review policy for this project:

\`\`\`yaml
workflow:
  reviewPolicy: agent
\`\`\`

Example — override model for senior developer:

\`\`\`yaml
roles:
  developer:
    models:
      senior: claude-sonnet-4-5-20250514
\`\`\`

Call \`workflow_guide\` for the full config reference.
`, "utf-8");
    return true;
  }
}

function getProjectDir(workspaceDir: string, projectName: string): string {
  return path.join(workspaceDir, DATA_DIR, "projects", projectName);
}

function getProjectWorkflowPath(workspaceDir: string, projectName: string): string {
  return path.join(getProjectDir(workspaceDir, projectName), "workflow.yaml");
}

function getProjectReadmePath(workspaceDir: string, projectName: string): string {
  return path.join(getProjectDir(workspaceDir, projectName), "README.md");
}

async function ensureAutonomousWorkflowOverride(
  workspaceDir: string,
  projectName: string,
  reviewPolicy = "agent",
): Promise<boolean> {
  const projectDir = getProjectDir(workspaceDir, projectName);
  const workflowPath = getProjectWorkflowPath(workspaceDir, projectName);
  await fs.mkdir(projectDir, { recursive: true });

  try {
    await fs.access(workflowPath);
    return false;
  } catch {
    await fs.writeFile(workflowPath, `workflow:\n  reviewPolicy: ${reviewPolicy}\n`, "utf-8");
    return true;
  }
}

async function hasProjectWorkflowOverride(
  workspaceDir: string,
  projectName: string,
): Promise<boolean> {
  const workflowPath = getProjectWorkflowPath(workspaceDir, projectName);
  try {
    await fs.access(workflowPath);
    return true;
  } catch {
    return false;
  }
}

async function pruneEmptyProjectDirs(workspaceDir: string, projectName: string): Promise<void> {
  const stopDir = path.join(workspaceDir, DATA_DIR, "projects");
  const candidateDirs = [
    path.join(getProjectDir(workspaceDir, projectName), "prompts"),
    getProjectDir(workspaceDir, projectName),
  ];

  for (const dir of candidateDirs) {
    if (!dir.startsWith(stopDir)) continue;
    try {
      await fs.rmdir(dir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY") {
        throw error;
      }
    }
  }
}

async function cleanupLocalRegisterResidue(
  workspaceDir: string,
  projectName: string,
  opts: { removeWorkflowOverride: boolean; removePromptReadme: boolean },
): Promise<void> {
  if (opts.removeWorkflowOverride) {
    await fs.rm(getProjectWorkflowPath(workspaceDir, projectName), { force: true });
  }
  if (opts.removePromptReadme) {
    await fs.rm(getProjectReadmePath(workspaceDir, projectName), { force: true });
  }
  await pruneEmptyProjectDirs(workspaceDir, projectName);
}

function cloneProjectData<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function applyAutonomousReviewPolicy<T extends { workflow: { reviewPolicy: string } }>(
  config: T,
  reviewPolicy: string,
): T {
  return {
    ...config,
    workflow: {
      ...config.workflow,
      reviewPolicy,
    },
  };
}

function appendCleanupContext(error: unknown, details: string[]): Error {
  const err = error instanceof Error ? error : new Error(String(error));
  if (details.length === 0) {
    return err;
  }
  err.message = `${err.message} (cleanup: ${details.join("; ")})`;
  return err;
}

function normalizeRepoIdentity(value?: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\.git$/i, "").toLowerCase();
}

export type ProjectRegisterParams = {
  workspaceDir: string;
  route: RouteRef;
  name: string;
  repo: string;
  runCommand: PluginContext["runCommand"];
  runtime?: PluginContext["runtime"];
  config?: PluginContext["config"];
  pluginConfig?: PluginContext["pluginConfig"];
  channel?: string;
  groupName?: string;
  baseBranch: string;
  deployBranch?: string;
  deployUrl?: string;
  createProjectTopic?: boolean;
  projectWorkflowConfig?: {
    workflow?: {
      reviewPolicy?: string;
    };
  };
};

export type ProjectRegisterResult = {
  success: boolean;
  project: string;
  projectSlug: string;
  channelId: string;
  messageThreadId?: number | null;
  repo: string;
  repoRemote: string | null;
  baseBranch: string;
  deployBranch: string;
  labelsCreated: number;
  promptsScaffolded: boolean;
  workflowOverrideCreated: boolean;
  isNewProject: boolean;
  activeWorkflow: {
    reviewPolicy: string;
    testPhase: boolean;
    hint: string;
  };
  announcement: string;
};

type StepRunCommand = (cmd: string, args: string[], opts?: { timeout?: number; cwd?: string }) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export function adaptStepRunCommand(runCommand: StepRunCommand): PluginContext["runCommand"] {
  return async (argv, optionsOrTimeout) => {
    const [cmd, ...args] = argv;
    const timeoutMs = typeof optionsOrTimeout === "number" ? optionsOrTimeout : optionsOrTimeout?.timeoutMs;
    const cwd = typeof optionsOrTimeout === "object" ? optionsOrTimeout?.cwd : undefined;
    const result = await runCommand(cmd ?? "", args, { timeout: timeoutMs, cwd });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.exitCode,
      signal: null,
      killed: false,
      termination: "exit",
    };
  };
}

export async function registerProject(params: ProjectRegisterParams): Promise<ProjectRegisterResult> {
  const {
    workspaceDir,
    route,
    name,
    repo,
    runCommand,
    runtime,
    config,
    pluginConfig,
    channel = "telegram",
    groupName = `Project: ${name}`,
    baseBranch,
    deployBranch = baseBranch,
    deployUrl = "",
    createProjectTopic = false,
    projectWorkflowConfig,
  } = params;

  const slug = name.toLowerCase().replace(/\s+/g, "-");
  const expectedReviewPolicy = projectWorkflowConfig?.workflow?.reviewPolicy ?? "agent";
  const initialRoute = buildRouteRef({
    channel: route.channel ?? (channel as RouteRef["channel"]),
    channelId: route.channelId,
    messageThreadId: route.messageThreadId ?? undefined,
    accountId: route.accountId,
  });
  let createdArtifacts: PipelineArtifact[] = [];
  let projectsPersisted = false;
  let registrationCompleted = false;
  let workflowOverrideCreated = false;
  let promptsCreated = false;
  let originalData: Awaited<ReturnType<typeof readProjects>> | null = null;
  await acquireLock(workspaceDir);
  try {
    const data = await readProjects(workspaceDir);
    originalData = cloneProjectData(data);
    const existing = data.projects[slug];
    const autonomousProject = createProjectTopic;
    let targetRoute = initialRoute;

    if (existing) {
      if (createProjectTopic) {
        throw new Error(
          `Autonomous DM bootstrap cannot reuse existing project slug "${slug}". Resolve the existing project administratively before retrying bootstrap.`,
        );
      }
      const channelExists = existing.channels.some((ch) => routeMatchesChannel(targetRoute, ch));
      if (channelExists) {
        throw new Error(
        `Route ${targetRoute.channelId}${targetRoute.messageThreadId ? `:${targetRoute.messageThreadId}` : ""} is already registered for project "${name}".`,
        );
      }
    }

    const repoPath = resolveRepoPath(repo);
    const { provider, type: providerType } = await createProvider({
      repo,
      runCommand,
      pluginConfig: pluginConfig ?? undefined,
      provider: existing?.provider,
      providerProfile: existing?.providerProfile,
    });

    const healthy = await provider.healthCheck();
    if (!healthy) {
      const cliName = providerType === "github" ? "gh" : "glab";
      const cliInstallUrl = providerType === "github"
        ? "https://cli.github.com"
        : "https://gitlab.com/gitlab-org/cli";
      throw new Error(
        `${providerType.toUpperCase()} health check failed for ${repoPath}. ` +
        `Detected provider: ${providerType}. ` +
        `Ensure '${cliName}' CLI is installed, authenticated (${cliName} auth status), ` +
        `and the repo has a ${providerType.toUpperCase()} remote. ` +
        `Install ${cliName} from: ${cliInstallUrl}`,
      );
    }

    let repoRemote: string | undefined;
    try {
      repoRemote = await provider.resolveRepositoryRemote() ?? undefined;
    } catch {
      repoRemote = undefined;
    }

    if (existing) {
      const sameRepoPath = resolveRepoPath(existing.repo) === repoPath;
      const sameRepoRemote =
        normalizeRepoIdentity(existing.repoRemote) != null &&
        normalizeRepoIdentity(existing.repoRemote) === normalizeRepoIdentity(repoRemote);
      if (!sameRepoPath && !sameRepoRemote) {
        throw new Error(
          `Project slug "${slug}" already points to a different repository. Existing repo="${existing.repo}" remote="${existing.repoRemote ?? "unknown"}"; incoming repo="${repoPath}" remote="${repoRemote ?? "unknown"}".`,
        );
      }
    }

    await provider.ensureAllStateLabels();

    const resolvedConfigBase = await loadConfig(workspaceDir, slug);
    const resolvedConfig = autonomousProject
      ? applyAutonomousReviewPolicy(resolvedConfigBase, expectedReviewPolicy)
      : resolvedConfigBase;
    const roleLabels = getRoleLabels(resolvedConfig.roles);
    for (const { name: labelName, color } of roleLabels) {
      await provider.ensureLabel(labelName, color);
    }
    for (const { name: labelName, color } of OPERATIONAL_LABELS) {
      await provider.ensureLabel(labelName, color);
    }

    if (createProjectTopic) {
    if (!runtime || !config) {
      throw new Error("Runtime and config are required to create a Telegram project topic");
    }
    if (initialRoute.channel !== "telegram") {
      throw new Error("Telegram project topic creation is only supported for telegram routes");
    }
    const telegramConfig = readFabricaTelegramConfig(pluginConfig as Record<string, unknown> | undefined);
    const projectsForumChatId = telegramConfig.projectsForumChatId;
    if (!projectsForumChatId) {
      throw new Error("Fabrica telegram.projectsForumChatId is required for DM bootstrap topic creation");
    }
    const createdTopic = await createProjectForumTopic({
      runtime,
      config,
    }, {
      chatId: projectsForumChatId,
      name,
      accountId: telegramConfig.projectsForumAccountId ?? initialRoute.accountId ?? undefined,
    });
    if (createdTopic.isFallback || createdTopic.topicId === 1) {
      throw new Error("DM bootstrap requires a dedicated Telegram topic; refusing to register against the General topic");
    }
    createdArtifacts = [{
      type: "forum_topic",
      id: buildForumTopicArtifactId(createdTopic.chatId, createdTopic.topicId),
    }];
    targetRoute = buildRouteRef({
      channel: "telegram",
      channelId: createdTopic.chatId,
      messageThreadId: createdTopic.topicId,
      accountId: telegramConfig.projectsForumAccountId ?? initialRoute.accountId ?? undefined,
    });
    if (targetRoute.messageThreadId === undefined) {
      throw new Error("DM bootstrap registration requires a Telegram topic association");
    }
    }

    if (existing) {
    existing.channels.push({
      channelId: targetRoute.channelId,
      channel: targetRoute.channel,
      name: `channel-${existing.channels.length + 1}`,
      events: ["*"],
      accountId: targetRoute.accountId ?? undefined,
      messageThreadId: targetRoute.messageThreadId ?? undefined,
    });
    if (repoRemote && !existing.repoRemote) existing.repoRemote = repoRemote;
    } else {
    const workers: Record<string, import("../../projects/index.js").RoleWorkerState> = {};
    for (const role of getAllRoleIds()) {
      const levelMaxWorkers = resolvedConfig.roles[role]?.levelMaxWorkers ?? {};
      workers[role] = emptyRoleWorkerState(levelMaxWorkers);
    }

    data.projects[slug] = {
      slug,
      name,
      repo,
      repoRemote,
      groupName,
      deployUrl,
      baseBranch,
      deployBranch,
      channels: [{
        channelId: targetRoute.channelId,
        channel: targetRoute.channel,
        name: "primary",
        events: ["*"],
        accountId: targetRoute.accountId ?? undefined,
        messageThreadId: targetRoute.messageThreadId ?? undefined,
      }],
      provider: providerType,
      workers,
    };
    }

    await writeProjects(workspaceDir, data);
    projectsPersisted = true;

    if (autonomousProject) {
      workflowOverrideCreated = await ensureAutonomousWorkflowOverride(
        workspaceDir,
        slug,
        expectedReviewPolicy,
      );
      const hasWorkflowOverride = await hasProjectWorkflowOverride(workspaceDir, slug);
      const persistedConfig = await loadConfig(workspaceDir, slug);
      if (!hasWorkflowOverride) {
        throw new Error(`Autonomous DM bootstrap requires a materialized workflow override for "${slug}"`);
      }
      if (persistedConfig.workflow.reviewPolicy !== expectedReviewPolicy) {
        throw new Error(
          `Autonomous DM bootstrap resolved reviewPolicy="${persistedConfig.workflow.reviewPolicy}" for "${slug}", expected "${expectedReviewPolicy}"`,
        );
      }
    }

    promptsCreated = await scaffoldPromptFiles(workspaceDir, slug);

    await auditLog(workspaceDir, "project_register", {
      project: name,
      projectSlug: slug,
      channelId: targetRoute.channelId,
      messageThreadId: targetRoute.messageThreadId ?? null,
      repo,
      repoRemote: repoRemote || null,
      baseBranch,
      deployBranch,
      deployUrl: deployUrl || null,
      isNewProject: !existing,
      workflowOverrideCreated,
      reviewPolicy: resolvedConfig.workflow.reviewPolicy ?? "human",
    });

    const action = existing ? "Channel added to existing project" : `Project "${name}" created`;
    const promptsNote = promptsCreated ? " Prompt files scaffolded." : "";
    registrationCompleted = true;
    return {
      success: true,
      project: name,
      projectSlug: slug,
      channelId: targetRoute.channelId,
      messageThreadId: targetRoute.messageThreadId ?? null,
      repo,
      repoRemote: repoRemote ?? null,
      baseBranch,
      deployBranch,
      labelsCreated: 10,
      promptsScaffolded: promptsCreated,
      workflowOverrideCreated,
      isNewProject: !existing,
      activeWorkflow: {
        reviewPolicy: resolvedConfig.workflow.reviewPolicy ?? "human",
        testPhase: Object.values(resolvedConfig.workflow.states).some(
          (s) => s.role === "tester" && (s.type === "queue" || s.type === "active"),
        ),
        hint: "The user can change the review policy or enable the test phase — call workflow_guide for the full reference.",
      },
      announcement: `${action}. Labels ensured.${promptsNote} Ready for tasks.`,
    };
  } catch (err) {
    let failure = err;
    if (projectsPersisted && !registrationCompleted && originalData) {
      const cleanupDetails: string[] = [];
      try {
        await writeProjects(workspaceDir, cloneProjectData(originalData));
      } catch (rollbackError) {
        cleanupDetails.push(`projects rollback failed: ${String(rollbackError)}`);
      }
      try {
        await cleanupLocalRegisterResidue(workspaceDir, slug, {
          removeWorkflowOverride: workflowOverrideCreated,
          removePromptReadme: promptsCreated,
        });
      } catch (cleanupError) {
        cleanupDetails.push(`local residue cleanup failed: ${String(cleanupError)}`);
      }
      failure = appendCleanupContext(failure, cleanupDetails);
    }
    if (createdArtifacts.length > 0) {
      throw attachArtifactsToError(failure, createdArtifacts);
    }
    throw failure;
  } finally {
    await releaseLock(workspaceDir);
  }
}

function attachArtifactsToError(error: unknown, artifacts: PipelineArtifact[]): Error {
  const err = error instanceof Error ? error : new Error(String(error));
  const existing = Array.isArray((err as Error & { artifacts?: unknown[] }).artifacts)
    ? ((err as Error & { artifacts?: unknown[] }).artifacts as unknown[])
    : [];
  const merged = [...existing, ...artifacts].filter((artifact, index, array) => {
    if (
      !artifact ||
      typeof artifact !== "object" ||
      typeof (artifact as { type?: unknown }).type !== "string" ||
      typeof (artifact as { id?: unknown }).id !== "string"
    ) {
      return false;
    }
    const current = `${(artifact as { type: string }).type}:${(artifact as { id: string }).id}`;
    return index === array.findIndex((candidate) => {
      if (
        !candidate ||
        typeof candidate !== "object" ||
        typeof (candidate as { type?: unknown }).type !== "string" ||
        typeof (candidate as { id?: unknown }).id !== "string"
      ) {
        return false;
      }
      return current === `${(candidate as { type: string }).type}:${(candidate as { id: string }).id}`;
    });
  });
  (err as Error & { artifacts?: unknown[] }).artifacts = merged;
  return err;
}

export function createProjectRegisterTool(ctx: PluginContext) {
  return (toolCtx: ToolContext) => ({
    name: "project_register",
    label: "Project Register",
    description: `Register a new project with Fabrica. Creates state labels, adds to projects.json. One-time setup per project.`,
    parameters: {
      type: "object",
      required: ["channelId", "name", "repo", "baseBranch"],
      properties: {
        channelId: {
          type: "string",
          description: "Channel ID — the chat/group ID where this project is managed (e.g. Telegram group ID)",
        },
        messageThreadId: {
          type: "number",
          description: "Optional Telegram topic ID when linking the project to a specific forum topic.",
        },
        name: {
          type: "string",
          description: "Short project name (e.g. 'my-webapp')",
        },
        repo: {
          type: "string",
          description: "Path to git repo (e.g. '~/git/my-project')",
        },
        channel: {
          type: "string",
          description: "Channel type (e.g. 'telegram', 'whatsapp'). Defaults to 'telegram'.",
        },
        groupName: {
          type: "string",
          description: "Group display name (optional - defaults to 'Project: {name}')",
        },
        baseBranch: {
          type: "string",
          description: "Base branch for development (e.g. 'development', 'main')",
        },
        deployBranch: {
          type: "string",
          description: "Branch that triggers deployment. Defaults to baseBranch.",
        },
        deployUrl: {
          type: "string",
          description: "Deployment URL for the project",
        },
      },
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const workspaceDir = toolCtx.workspaceDir;

      if (!workspaceDir) {
        throw new Error("No workspace directory available in tool context");
      }
      const result = await registerProject({
        workspaceDir,
        route: {
          channel: ((params.channel as string) ?? "telegram") as RouteRef["channel"],
          channelId: params.channelId as string,
          messageThreadId: typeof params.messageThreadId === "number" ? params.messageThreadId : undefined,
          accountId: toolCtx.agentAccountId,
        },
        name: params.name as string,
        repo: params.repo as string,
        runCommand: ctx.runCommand,
        runtime: ctx.runtime,
        config: ctx.config,
        pluginConfig: ctx.pluginConfig,
        channel: (params.channel as string) ?? "telegram",
        groupName: params.groupName as string | undefined,
        baseBranch: params.baseBranch as string,
        deployBranch: params.deployBranch as string | undefined,
        deployUrl: params.deployUrl as string | undefined,
      });

      return jsonResult(result);
    },
  });
}
