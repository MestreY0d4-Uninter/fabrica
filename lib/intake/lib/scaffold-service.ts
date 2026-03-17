import path from "node:path";
import { z } from "zod";
import type {
  CanonicalStack,
  DeliveryTarget,
  GenesisPayload,
  Scaffold,
  ScaffoldPlan,
  StepContext,
} from "../types.js";
import { runGenesisScript } from "./runtime-paths.js";
import { supportsGreenfieldScaffold } from "../../test-env/bootstrap.js";
import {
  detectStackFromDeliveryTarget,
  detectStackFromText,
  normalizeStackHint,
} from "./stack-detection.js";
import {
  deriveRepoName,
  normalizeIntakeText as normalizeText,
  parseOwnerRepo,
  sanitizeRepoName,
} from "./repo-target.js";

const scaffoldPlanSchema = z.object({
  version: z.literal(1),
  owner: z.string().min(1),
  repo_name: z.string().min(3),
  repo_url: z.string().url(),
  repo_local: z.string().min(1),
  project_slug: z.string().min(3),
  stack: z.enum(["nextjs", "node-cli", "express", "fastapi", "flask", "django", "python-cli", "go", "java"]),
  objective: z.string().min(1),
  delivery_target: z.enum(["web-ui", "api", "cli", "hybrid", "unknown"]),
  repo_target_source: z.string().min(1),
}) satisfies z.ZodType<ScaffoldPlan>;

const scaffoldOutputSchema = z.object({
  scaffold: z.object({
    created: z.boolean(),
    reason: z.string().optional(),
    stack: z.enum(["nextjs", "node-cli", "express", "fastapi", "flask", "django", "python-cli", "go", "java"]).optional(),
    repo_url: z.string().optional(),
    repo_local: z.string().optional(),
    project_slug: z.string().optional(),
    files_created: z.array(z.string()).optional(),
  }),
});

type ScaffoldExecutionResult = {
  plannedPayload: GenesisPayload;
  stdout: string;
  stderr: string;
  exitCode: number;
};

function resolveDeliveryTarget(payload: GenesisPayload): DeliveryTarget {
  return payload.spec?.delivery_target
    ?? payload.classification?.delivery_target
    ?? payload.metadata.delivery_target
    ?? "unknown";
}

function resolveStack(payload: GenesisPayload, deliveryTarget: DeliveryTarget): CanonicalStack {
  const hinted = normalizeStackHint(payload.metadata.stack_hint ?? "");
  if (hinted) return hinted;

  const spec = payload.spec;
  if (spec) {
    const text = [spec.title, spec.objective, ...spec.scope_v1, ...spec.acceptance_criteria].join(" ");
    const detected = detectStackFromText(text);
    if (detected) return detected;
  }

  return detectStackFromDeliveryTarget(deliveryTarget);
}

function assertGreenfieldStackSupported(stack: CanonicalStack): void {
  if (!supportsGreenfieldScaffold(stack)) {
    throw new Error(
      `Greenfield scaffold for stack "${stack}" is not supported yet. Supported stacks: nextjs, node-cli, express, fastapi, flask, django, python-cli.`,
    );
  }
}

async function resolveGitHubOwner(ctx: StepContext): Promise<string> {
  const result = await ctx.runCommand("gh", ["api", "user", "-q", ".login"], { timeout: 10_000 });
  const owner = result.stdout.trim();
  if (result.exitCode !== 0 || !owner) {
    throw new Error("Could not resolve GitHub owner via gh api user. Authenticate gh or provide an explicit repo target.");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(owner)) {
    throw new Error(`Resolved invalid GitHub owner "${owner}"`);
  }
  return owner;
}

export async function buildScaffoldPlan(
  payload: GenesisPayload,
  ctx: StepContext,
): Promise<ScaffoldPlan> {
  const explicitOwnerRepo = parseOwnerRepo(payload.metadata.repo_url);
  const deliveryTarget = resolveDeliveryTarget(payload);
  const stack = resolveStack(payload, deliveryTarget);
  assertGreenfieldStackSupported(stack);
  const { repoName, source } = deriveRepoName(payload, explicitOwnerRepo?.repo ?? null);
  const owner = explicitOwnerRepo?.owner ?? await resolveGitHubOwner(ctx);
  const projectSlug = sanitizeRepoName(payload.metadata.project_slug ?? repoName) || repoName;
  const repoUrl = explicitOwnerRepo
    ? `https://github.com/${explicitOwnerRepo.owner}/${explicitOwnerRepo.repo}`
    : `https://github.com/${owner}/${repoName}`;
  const repoLocal = normalizeText(payload.metadata.repo_path) ?? path.join(ctx.homeDir, "git", owner, repoName);
  const objective = normalizeText(payload.spec?.objective) ?? normalizeText(payload.raw_idea) ?? "Auto-scaffolded project";

  return scaffoldPlanSchema.parse({
    version: 1,
    owner,
    repo_name: explicitOwnerRepo?.repo ?? repoName,
    repo_url: repoUrl,
    repo_local: repoLocal,
    project_slug: projectSlug,
    stack,
    objective,
    delivery_target: deliveryTarget,
    repo_target_source: explicitOwnerRepo ? "metadata.repo_url" : source,
  });
}

export async function executeScaffoldPlan(
  payload: GenesisPayload,
  ctx: StepContext,
  plan: ScaffoldPlan,
  timeout = 120_000,
): Promise<ScaffoldExecutionResult> {
  const plannedPayload: GenesisPayload = {
    ...payload,
    metadata: {
      ...payload.metadata,
      stack_hint: plan.stack,
      repo_url: plan.repo_url,
      repo_path: plan.repo_local,
      project_slug: plan.project_slug,
      project_name: payload.metadata.project_name ?? plan.project_slug,
      repo_target_source: plan.repo_target_source,
      scaffold_plan: plan,
    },
  };

  const result = await runGenesisScript(ctx, "scaffold-project.sh", plannedPayload, timeout);
  if (result.exitCode === 0) {
    const parsed = parseScaffoldOutput(result.stdout);
    if (parsed.created && parsed.stack !== plan.stack) {
      throw new Error(
        `Scaffold materialized stack "${parsed.stack ?? "unknown"}" but the planned stack was "${plan.stack}".`,
      );
    }
  }
  return {
    plannedPayload,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}

export function parseScaffoldOutput(stdout: string): Scaffold {
  const parsed = scaffoldOutputSchema.parse(JSON.parse(stdout));
  return parsed.scaffold;
}
