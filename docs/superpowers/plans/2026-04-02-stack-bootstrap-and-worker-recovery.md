# Stack Bootstrap And Worker Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Fabrica provision stack environments before dispatch, starting with Python, and recover worker sessions that become live-but-silent without pinning issues in `Doing`.

**Architecture:** Promote the existing Python bootstrap logic in `lib/test-env/bootstrap.ts` into a persistent stack-contract gate that runs before `developer` and `tester` dispatch. In parallel, harden worker recovery so transcript/session activity and inconclusive completion are treated as first-class runtime state, with recovery before operational failure.

**Tech Stack:** TypeScript, Vitest, OpenClaw plugin runtime, Fabrica heartbeat/tick pipeline, project state persisted in `projects.json`

---

## File Map

- Modify: `lib/projects/types.ts`
  - Add project-level environment state persisted in `projects.json`.
- Modify: `lib/projects/mutations.ts`
  - Add helpers to update project environment state transactionally.
- Modify: `lib/tools/admin/project-register.ts`
  - Persist the resolved stack on the project record.
- Modify: `lib/dispatch/telegram-bootstrap-hook.ts`
  - Pass the resolved stack into project registration so runtime gating has a durable source of truth.
- Create: `lib/test-env/contracts.ts`
  - Resolve supported stack contracts and contract versions.
- Create: `lib/test-env/state.ts`
  - Normalize project environment state defaults and persistence helpers.
- Create: `lib/test-env/runtime.ts`
  - Orchestrate `ensureEnvironmentReady()` using existing bootstrap functions and persistent state.
- Modify: `lib/test-env/bootstrap.ts`
  - Export the contract-facing Python bootstrap pieces without duplicating the implementation.
- Modify: `lib/services/tick.ts`
  - Block `developer`/`tester` dispatch until the environment is ready.
- Modify: `lib/services/heartbeat/health.ts`
  - Retry environment bootstrap, distinguish environment failure from worker failure, and recover live-but-silent workers.
- Modify: `lib/services/gateway-sessions.ts`
  - Expose transcript freshness helpers used by worker recovery.
- Modify: `lib/services/worker-completion.ts`
  - Track inconclusive completion, attempt recovery, and only requeue after recovery exhaustion.
- Modify: `lib/dispatch/notify.ts`
  - Emit explicit operational-failure timeline events once retries are exhausted.
- Create: `tests/unit/environment-runtime.test.ts`
  - Cover contract resolution, state defaults, and environment persistence.
- Modify: `tests/unit/project-register.test.ts`
  - Cover stack persistence on project registration.
- Modify: `tests/unit/telegram-bootstrap-flow.test.ts`
  - Cover bootstrap-to-registration stack handoff.
- Create: `tests/unit/environment-gate.test.ts`
  - Cover `projectTick()` dispatch blocking and retry scheduling when environment is not ready.
- Modify: `tests/unit/test-env-bootstrap.test.ts`
  - Keep Python bootstrap behavior under the promoted contract.
- Modify: `tests/unit/worker-completion.test.ts`
  - Cover inconclusive completion and recovery exhaustion behavior.
- Modify: `tests/unit/heartbeat-health-session.test.ts`
  - Cover heartbeat decisions for environment state and live-but-silent sessions.
- Modify: `tests/unit/notify.test.ts`
  - Cover new environment/worker failure timeline notifications.
- Modify: `tests/e2e/qa-bootstrap.e2e.test.ts`
  - Prove Python bootstrap happens before worker execution.
- Modify: `tests/e2e/orchestration-smoke.e2e.test.ts`
  - Prove live-but-silent worker recovery no longer pins `Doing`.

### Task 1: Add Persistent Stack-Environment State And Contract Resolution

**Files:**
- Modify: `lib/projects/types.ts`
- Modify: `lib/projects/mutations.ts`
- Modify: `lib/tools/admin/project-register.ts`
- Modify: `lib/dispatch/telegram-bootstrap-hook.ts`
- Create: `lib/test-env/contracts.ts`
- Create: `lib/test-env/state.ts`
- Create: `tests/unit/environment-runtime.test.ts`
- Modify: `tests/unit/project-register.test.ts`
- Modify: `tests/unit/telegram-bootstrap-flow.test.ts`

- [ ] **Step 1: Write the failing unit tests for environment defaults, contract resolution, and stack persistence**

```ts
import { describe, expect, it } from "vitest";
import type { Project } from "../../lib/projects/types.js";
import {
  getProjectEnvironmentState,
  resolveEnvironmentContractVersion,
} from "../../lib/test-env/state.js";
import { resolveStackEnvironmentContract } from "../../lib/test-env/contracts.js";
import { registerProject } from "../../lib/tools/admin/project-register.js";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    slug: "todo-summary",
    name: "todo-summary",
    repo: "MestreY0d4-Uninter/todo-summary",
    groupName: "Test",
    deployUrl: "",
    baseBranch: "main",
    deployBranch: "main",
    channels: [],
    workers: {},
    ...overrides,
  };
}

describe("environment state defaults", () => {
  it("defaults a python project environment to pending with the resolved contract version", () => {
    const state = getProjectEnvironmentState(makeProject(), "python-cli");
    expect(state).toMatchObject({
      status: "pending",
      stack: "python-cli",
      contractVersion: resolveEnvironmentContractVersion("python-cli"),
      lastProvisionError: null,
      nextProvisionRetryAt: null,
    });
  });

  it("keeps a ready state stable when the stored contract version already matches", () => {
    const state = getProjectEnvironmentState(makeProject({
      environment: {
        status: "ready",
        stack: "python-cli",
        contractVersion: resolveEnvironmentContractVersion("python-cli"),
        lastProvisionedAt: "2026-04-02T00:00:00.000Z",
        lastProvisionError: null,
        nextProvisionRetryAt: null,
      },
    }), "python-cli");
    expect(state.status).toBe("ready");
    expect(state.contractVersion).toBe(resolveEnvironmentContractVersion("python-cli"));
  });
});

describe("stack contract resolution", () => {
  it("resolves a Python contract that requires shared toolchain and project environment steps", () => {
    const contract = resolveStackEnvironmentContract("python-cli");
    expect(contract.family).toBe("python");
    expect(contract.version).toBe(resolveEnvironmentContractVersion("python-cli"));
    expect(contract.requiresSharedToolchain).toBe(true);
  });
});

describe("project stack persistence", () => {
  it("stores the stack on project registration so dispatch can resolve the contract later", async () => {
    const result = await registerProject({
      workspaceDir: "/tmp/fabrica-test",
      name: "todo-summary",
      repo: "MestreY0d4-Uninter/todo-summary",
      baseBranch: "main",
      channelId: "telegram:1",
      stack: "python-cli",
    });

    expect(result.project.stack).toBe("python-cli");
  });
});
```

- [ ] **Step 2: Run the new tests to confirm the current code is missing the contract/state layer**

Run: `npm exec vitest run tests/unit/environment-runtime.test.ts tests/unit/project-register.test.ts tests/unit/telegram-bootstrap-flow.test.ts`

Expected: FAIL with module resolution errors for `lib/test-env/contracts.ts` / `lib/test-env/state.ts`, missing `environment` on `Project`, and missing `stack` in the project registration path.

- [ ] **Step 3: Add the new project environment type, contract/state helpers, and durable stack field**

```ts
// lib/projects/types.ts
import type { CanonicalStack } from "../intake/types.js";

export type ProjectEnvironmentStatus = "pending" | "provisioning" | "ready" | "failed";

export type ProjectEnvironmentState = {
  status: ProjectEnvironmentStatus;
  stack: CanonicalStack | null;
  contractVersion: string | null;
  lastProvisionedAt?: string | null;
  lastProvisionError?: string | null;
  nextProvisionRetryAt?: string | null;
};

export type Project = {
  slug: string;
  name: string;
  repo: string;
  groupName: string;
  deployUrl: string;
  baseBranch: string;
  deployBranch: string;
  channels: Channel[];
  workers: Record<string, RoleWorkerState>;
  issueRuntime?: Record<string, IssueRuntimeState>;
  stack?: CanonicalStack | null;
  environment?: ProjectEnvironmentState;
};
```

```ts
// lib/test-env/contracts.ts
import type { CanonicalStack } from "../intake/types.js";
import { familyForStack } from "./bootstrap.js";

export type StackEnvironmentContract = {
  stack: CanonicalStack;
  family: ReturnType<typeof familyForStack>;
  version: string;
  requiresSharedToolchain: boolean;
};

export function resolveStackEnvironmentContract(stack: CanonicalStack): StackEnvironmentContract {
  if (stack === "python-cli" || stack === "fastapi" || stack === "flask" || stack === "django") {
    return {
      stack,
      family: "python",
      version: "python@v1",
      requiresSharedToolchain: true,
    };
  }
  return {
    stack,
    family: familyForStack(stack),
    version: `${familyForStack(stack)}@v1`,
    requiresSharedToolchain: false,
  };
}
```

```ts
// lib/test-env/state.ts
import type { CanonicalStack } from "../intake/types.js";
import type { Project, ProjectEnvironmentState } from "../projects/types.js";
import { resolveStackEnvironmentContract } from "./contracts.js";

export function resolveEnvironmentContractVersion(stack: CanonicalStack): string {
  return resolveStackEnvironmentContract(stack).version;
}

export function getProjectEnvironmentState(
  project: Project,
  stack: CanonicalStack,
): ProjectEnvironmentState {
  const version = resolveEnvironmentContractVersion(stack);
  const current = project.environment;
  if (!current || current.stack !== stack || current.contractVersion !== version) {
    return {
      status: "pending",
      stack,
      contractVersion: version,
      lastProvisionedAt: null,
      lastProvisionError: null,
      nextProvisionRetryAt: null,
    };
  }
  return {
    ...current,
    stack,
    contractVersion: version,
    lastProvisionError: current.lastProvisionError ?? null,
    nextProvisionRetryAt: current.nextProvisionRetryAt ?? null,
  };
}
```

```ts
// lib/projects/mutations.ts
export async function updateProjectEnvironment(
  workspaceDir: string,
  slugOrChannelId: string,
  updates: Partial<ProjectEnvironmentState>,
): Promise<ProjectsData> {
  const { data } = await withProjectsMutation(workspaceDir, (data) => {
    const slug = resolveProjectSlug(data, slugOrChannelId);
    if (!slug) throw new Error(`Project not found for slug or channelId: ${slugOrChannelId}`);
    const project = data.projects[slug]!;
    project.environment = {
      status: "pending",
      stack: project.environment?.stack ?? null,
      contractVersion: project.environment?.contractVersion ?? null,
      lastProvisionedAt: project.environment?.lastProvisionedAt ?? null,
      lastProvisionError: project.environment?.lastProvisionError ?? null,
      nextProvisionRetryAt: project.environment?.nextProvisionRetryAt ?? null,
      ...project.environment,
      ...updates,
    };
  });
  return data;
}
```

```ts
// lib/tools/admin/project-register.ts
type RegisterProjectParams = {
  workspaceDir: string;
  channelId: string;
  name: string;
  repo: string;
  baseBranch: string;
  deployBranch?: string;
  deployUrl?: string;
  groupName?: string;
  stack?: CanonicalStack | null;
};

if (existing) {
  existing.stack = params.stack ?? existing.stack ?? null;
  existing.environment = existing.environment ?? null;
} else {
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
    stack: params.stack ?? null,
    environment: null,
  };
}
```

```ts
// lib/dispatch/telegram-bootstrap-hook.ts
await runtime.tool.call("project_register", {
  channelId,
  name: request.projectName,
  repo,
  baseBranch,
  stack: request.stackHint ?? null,
});
```

- [ ] **Step 4: Run the unit tests again**

Run: `npm exec vitest run tests/unit/environment-runtime.test.ts tests/unit/project-register.test.ts tests/unit/telegram-bootstrap-flow.test.ts`

Expected: PASS with the new environment state tests green and the stack handoff covered in registration/bootstrap tests.

- [ ] **Step 5: Commit the environment state and contract layer**

```bash
git add \
  lib/projects/types.ts \
  lib/projects/mutations.ts \
  lib/tools/admin/project-register.ts \
  lib/dispatch/telegram-bootstrap-hook.ts \
  lib/test-env/contracts.ts \
  lib/test-env/state.ts \
  tests/unit/environment-runtime.test.ts \
  tests/unit/project-register.test.ts \
  tests/unit/telegram-bootstrap-flow.test.ts
git commit -m "feat(env): add persistent stack contract state"
```

### Task 2: Gate Developer And Tester Dispatch On Environment Readiness

**Files:**
- Modify: `lib/test-env/bootstrap.ts`
- Create: `lib/test-env/runtime.ts`
- Modify: `lib/services/tick.ts`
- Create: `tests/unit/environment-gate.test.ts`
- Modify: `tests/unit/test-env-bootstrap.test.ts`

- [ ] **Step 1: Write the failing tests for the pre-dispatch environment gate**

```ts
import { describe, expect, it, vi } from "vitest";
import { projectTick } from "../../lib/services/tick.js";

describe("projectTick environment gate", () => {
  it("blocks developer dispatch while Python environment provisioning is still pending", async () => {
    const ensureEnvironmentReady = vi.fn().mockResolvedValue({
      ready: false,
      state: {
        status: "provisioning",
        stack: "python-cli",
        contractVersion: "python@v1",
        nextProvisionRetryAt: "2026-04-02T12:00:00.000Z",
      },
    });
    const dispatchTask = vi.fn();

    const result = await projectTick({
      workspaceDir: "/tmp/fabrica-test",
      projectSlug: "todo-summary",
      targetRole: "developer",
      runCommand: vi.fn(),
      runtime: {} as never,
      ensureEnvironmentReady,
      dispatchTask,
    });

    expect(dispatchTask).not.toHaveBeenCalled();
    expect(result.skipped).toContainEqual(
      expect.objectContaining({ role: "developer", reason: "environment_not_ready" }),
    );
  });
});
```

- [ ] **Step 2: Run the targeted gate tests and the current Python bootstrap tests**

Run: `npm exec vitest run tests/unit/environment-gate.test.ts tests/unit/test-env-bootstrap.test.ts`

Expected: FAIL because `projectTick()` does not accept `ensureEnvironmentReady` yet and there is no runtime orchestration module.

- [ ] **Step 3: Promote the Python bootstrap into a reusable runtime gate and wire it into `projectTick()`**

```ts
// lib/test-env/runtime.ts
import { log as auditLog } from "../audit.js";
import { updateProjectEnvironment } from "../projects/mutations.js";
import { ensureProjectTestEnvironment } from "./bootstrap.js";
import { resolveStackEnvironmentContract } from "./contracts.js";
import { getProjectEnvironmentState } from "./state.js";

export async function ensureEnvironmentReady(opts: {
  workspaceDir: string;
  projectSlug: string;
  project: Project;
  stack: CanonicalStack;
  runCommand: RunCommand;
}): Promise<{ ready: boolean; state: ProjectEnvironmentState }> {
  const contract = resolveStackEnvironmentContract(opts.stack);
  const current = getProjectEnvironmentState(opts.project, opts.stack);

  await updateProjectEnvironment(opts.workspaceDir, opts.projectSlug, {
    status: "provisioning",
    stack: opts.stack,
    contractVersion: contract.version,
    lastProvisionError: null,
  });
  await auditLog(opts.workspaceDir, "environment_bootstrap_started", {
    projectSlug: opts.projectSlug,
    stack: opts.stack,
    contractVersion: contract.version,
  });

  const result = await ensureProjectTestEnvironment({
    repoPath: resolveRepoPath(opts.project.repo),
    stack: opts.stack,
    mode: "developer",
    runCommand: opts.runCommand,
  });

  if (!result.ready) {
    const nextRetryAt = new Date(Date.now() + 60_000).toISOString();
    await updateProjectEnvironment(opts.workspaceDir, opts.projectSlug, {
      status: "failed",
      stack: opts.stack,
      contractVersion: contract.version,
      lastProvisionError: result.reason ?? "environment_bootstrap_failed",
      nextProvisionRetryAt: nextRetryAt,
    });
    await auditLog(opts.workspaceDir, "environment_bootstrap_retry_scheduled", {
      projectSlug: opts.projectSlug,
      stack: opts.stack,
      nextRetryAt,
      reason: result.reason ?? "environment_bootstrap_failed",
    });
    return {
      ready: false,
      state: getProjectEnvironmentState({ ...opts.project, environment: { ...current, status: "failed", nextProvisionRetryAt: nextRetryAt } }, opts.stack),
    };
  }

  await updateProjectEnvironment(opts.workspaceDir, opts.projectSlug, {
    status: "ready",
    stack: opts.stack,
    contractVersion: contract.version,
    lastProvisionedAt: new Date().toISOString(),
    lastProvisionError: null,
    nextProvisionRetryAt: null,
  });
  await auditLog(opts.workspaceDir, "environment_ready_confirmed", {
    projectSlug: opts.projectSlug,
    stack: opts.stack,
    contractVersion: contract.version,
  });
  return {
    ready: true,
    state: getProjectEnvironmentState({ ...opts.project, environment: { ...current, status: "ready", nextProvisionRetryAt: null } }, opts.stack),
  };
}
```

```ts
// lib/services/tick.ts
export async function projectTick(opts: {
  workspaceDir: string;
  projectSlug: string;
  agentId?: string;
  sessionKey?: string;
  pluginConfig?: Record<string, unknown>;
  dryRun?: boolean;
  maxPickups?: number;
  targetRole?: Role;
  provider?: IssueProvider;
  runtime?: PluginRuntime;
  workflow?: WorkflowConfig;
  instanceName?: string;
  runCommand?: RunCommand;
  ensureEnvironmentReady?: typeof import("../test-env/runtime.js").ensureEnvironmentReady;
  dispatchTask?: typeof import("../dispatch/index.js").dispatchTask;
}): Promise<TickResult> {
  const ensureEnvironment = opts.ensureEnvironmentReady ?? defaultEnsureEnvironmentReady;
  const dispatch = opts.dispatchTask ?? dispatchTask;

  // inside the per-role loop, before dispatch for developer/tester
  if (role === "developer" || role === "tester") {
    const stack = fresh.stack;
    if ((role === "developer" || role === "tester") && !stack) {
      skipped.push({ role, reason: "missing_project_stack" });
      continue;
    }
    const environment = await ensureEnvironment({
      workspaceDir,
      projectSlug,
      project: fresh,
      stack: stack!,
      runCommand: runCommand!,
    });
    if (!environment.ready) {
      skipped.push({ role, reason: "environment_not_ready" });
      await auditLog(workspaceDir, "dispatch_blocked_environment_not_ready", {
        projectSlug,
        role,
        issueId: issue.iid,
        environmentStatus: environment.state.status,
      }).catch(() => {});
      continue;
    }
  }

  await dispatch({
    workspaceDir,
    agentId,
    project: fresh,
    issueId: issue.iid,
    issueTitle: issue.title,
    issueDescription: issue.body ?? "",
    issueUrl: issue.url,
    role,
    level,
    fromLabel: currentLabel,
    toLabel: targetLabel,
    provider,
    runCommand: runCommand!,
    runtime,
  });
}
```

- [ ] **Step 4: Run the focused gate tests again**

Run: `npm exec vitest run tests/unit/environment-gate.test.ts tests/unit/test-env-bootstrap.test.ts`

Expected: PASS with the new gate test green and the existing Python bootstrap assertions still green.

- [ ] **Step 5: Commit the dispatch gate**

```bash
git add \
  lib/test-env/bootstrap.ts \
  lib/test-env/runtime.ts \
  lib/services/tick.ts \
  tests/unit/environment-gate.test.ts \
  tests/unit/test-env-bootstrap.test.ts
git commit -m "feat(dispatch): gate worker pickup on environment readiness"
```

### Task 3: Add Worker Completion Recovery For Live-But-Silent Sessions

**Files:**
- Modify: `lib/services/gateway-sessions.ts`
- Modify: `lib/services/worker-completion.ts`
- Modify: `lib/services/heartbeat/health.ts`
- Modify: `lib/dispatch/notify.ts`
- Modify: `tests/unit/worker-completion.test.ts`
- Modify: `tests/unit/heartbeat-health-session.test.ts`
- Modify: `tests/unit/notify.test.ts`

- [ ] **Step 1: Write the failing tests for inconclusive completion and recovery exhaustion**

```ts
import { describe, expect, it, vi } from "vitest";
import { handleWorkerAgentEnd } from "../../lib/services/worker-completion.js";
import { performHealthPass } from "../../lib/services/heartbeat/passes.js";
import { createTestHarness } from "../../lib/testing/index.js";

describe("worker completion recovery", () => {
  it("marks a session as inconclusive instead of failing immediately when activity exists without a result line", async () => {
    const outcome = await handleWorkerAgentEnd({
      workspaceDir: "/tmp/fabrica-test",
      sessionKey: "fabrica:todo-summary:developer:1",
      messages: [{ role: "assistant", content: [{ type: "text", text: "still working" }] }],
      runtime: { subagent: { getSessionMessages: vi.fn().mockResolvedValue([]) } } as never,
    });

    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toBe("inconclusive_completion");
  });

  it("requeues a live-but-silent developer only after the recovery window is exhausted", async () => {
    const harness = await createTestHarness();
    const result = await performHealthPass(
      harness.workspaceDir,
      harness.project.slug,
      harness.project,
      null,
      harness.provider as never,
      undefined,
      undefined,
      harness.runCommand,
      undefined,
      undefined,
      {
        timeouts: { dispatchConfirmTimeoutMs: 5_000, staleWorkerHours: 2, stallTimeoutMinutes: 10 },
        workflow: harness.workflow as never,
      } as never,
    );

    expect(result.fixes).toContainEqual(
      expect.objectContaining({
        issue: expect.objectContaining({ type: "completion_recovery_exhausted" }),
        fixed: true,
      }),
    );
  });
});
```

- [ ] **Step 2: Run the worker recovery slice**

Run: `npm exec vitest run tests/unit/worker-completion.test.ts tests/unit/heartbeat-health-session.test.ts tests/unit/notify.test.ts`

Expected: FAIL because there is no recovery window or explicit exhausted-failure notification yet.

- [ ] **Step 3: Implement transcript-based recovery and explicit operational failure after exhaustion**

```ts
// lib/services/gateway-sessions.ts
export function getLastObservableTranscriptAt(
  sessionKey: string,
  sessions: SessionLookup,
): number | null {
  const session = sessions.byKey[sessionKey];
  if (!session) return null;
  return session.sessionFileMtime ?? session.updatedAtMs ?? null;
}
```

```ts
// lib/services/worker-completion.ts
const COMPLETION_RECOVERY_WINDOW_MS = 2 * 60 * 1_000;

export async function handleWorkerAgentEnd(opts: WorkerAgentEndOptions): Promise<WorkerCompletionOutcome> {
  const parsed = parseFabricaSessionKey(opts.sessionKey);
  const role = parsed ? asWorkerRole(parsed.role) : null;
  const observation = await resolveWorkerResultFromRuntime(role!, opts.sessionKey, opts.messages, opts.runtime);
  const context = await resolveWorkerSessionContext(opts.sessionKey, opts.workspaceDir);
  if (!observation.result && observation.activityObserved) {
    await updateIssueRuntime(opts.workspaceDir, context.projectSlug, context.issueId, {
      inconclusiveCompletionAt: new Date().toISOString(),
      inconclusiveCompletionReason: "missing_result_line",
    }).catch(() => {});
    await auditLog(opts.workspaceDir, "worker_completion_inconclusive", {
      projectSlug: context.projectSlug,
      issueId: context.issueId,
      sessionKey: opts.sessionKey,
    }).catch(() => {});
    return { applied: false, reason: "inconclusive_completion" };
  }

  if (!observation.result) {
    return { applied: false, reason: "missing_result_line" };
  }

  await updateIssueRuntime(opts.workspaceDir, context.projectSlug, context.issueId, {
    inconclusiveCompletionAt: null,
    inconclusiveCompletionReason: null,
  }).catch(() => {});
  return applyWorkerResult({
    context,
    result: observation.result,
    workspaceDir: opts.workspaceDir,
    runCommand: opts.runCommand,
    runId: opts.runId,
    runtime: opts.runtime,
    pluginConfig: opts.pluginConfig,
    providerOverride: opts.providerOverride,
    validateDeveloperDone: opts.validateDeveloperDone,
  });
}
```

```ts
// lib/services/heartbeat/health.ts
if (issueRuntime?.inconclusiveCompletionAt) {
  const inconclusiveAt = Date.parse(issueRuntime.inconclusiveCompletionAt);
  const lastObservableAt = getLastObservableTranscriptAt(slot.sessionKey!, sessions);
  const stillProgressing = lastObservableAt != null && lastObservableAt > inconclusiveAt;

  if (stillProgressing) {
    await auditLog(workspaceDir, "worker_completion_recovery_started", {
      projectSlug,
      issueId: slot.issueId,
      sessionKey: slot.sessionKey,
    }).catch(() => {});
  } else if (Date.now() - inconclusiveAt > COMPLETION_RECOVERY_WINDOW_MS) {
    await notify({
      workspaceDir,
      projectSlug,
      event: "workerRecoveryExhausted",
      issueId: Number(slot.issueId),
      role,
      detail: "No canonical completion result arrived after observable activity",
      runCommand,
    });
    fixes.push({
      issue: {
        type: "completion_recovery_exhausted",
        severity: "critical",
        project: project.name,
        projectSlug,
        role,
        issueId: slot.issueId,
        sessionKey: slot.sessionKey,
        message: "worker completion recovery exhausted after observable activity",
      },
      fixed: true,
    });
  }
}
```

```ts
// lib/dispatch/notify.ts
case "workerRecoveryExhausted":
  return [
    `⚠️ ${role.toUpperCase()} run exhausted recovery for #${issueId}`,
    detail ?? "No canonical completion result was produced after observable activity",
    "→ TO IMPROVE",
  ].join("\n");
```

- [ ] **Step 4: Re-run the recovery tests**

Run: `npm exec vitest run tests/unit/worker-completion.test.ts tests/unit/heartbeat-health-session.test.ts tests/unit/notify.test.ts`

Expected: PASS with the inconclusive path staying non-terminal and the exhausted path requeueing only after the inactivity window.

- [ ] **Step 5: Commit the recovery layer**

```bash
git add \
  lib/services/gateway-sessions.ts \
  lib/services/worker-completion.ts \
  lib/services/heartbeat/health.ts \
  lib/dispatch/notify.ts \
  tests/unit/worker-completion.test.ts \
  tests/unit/heartbeat-health-session.test.ts \
  tests/unit/notify.test.ts
git commit -m "feat(recovery): recover live but silent worker sessions"
```

### Task 4: Validate Python Bootstrap And Worker Recovery End-To-End

**Files:**
- Modify: `tests/e2e/qa-bootstrap.e2e.test.ts`
- Modify: `tests/e2e/orchestration-smoke.e2e.test.ts`
- Modify: `tests/unit/test-env-bootstrap.test.ts`

- [ ] **Step 1: Add the end-to-end coverage for Python-first provisioning and live-but-silent recovery**

```ts
// tests/e2e/qa-bootstrap.e2e.test.ts
it("boots a Python QA contract even when the host PATH does not expose python or pip", async () => {
  const repoPath = await makeTempDir("fabrica-e2e-python-no-host-python-");
  const binDir = path.join(repoPath, "bin");
  await fs.mkdir(binDir, { recursive: true });
  await writeExecutable(path.join(binDir, "python"), "#!/usr/bin/env bash\nexit 127\n");
  await writeExecutable(path.join(binDir, "python3"), "#!/usr/bin/env bash\nexit 127\n");
  await writeExecutable(path.join(binDir, "pip"), "#!/usr/bin/env bash\nexit 127\n");
  await writeExecutable(path.join(binDir, "pip-audit"), "#!/usr/bin/env bash\necho 'mock pip-audit (e2e)'\n");

  await writeFile(path.join(repoPath, "pyproject.toml"), `
[build-system]
requires = ["setuptools>=75.0.0"]
build-backend = "setuptools.build_meta"

[project]
name = "fabrica-e2e-python"
version = "0.1.0"
requires-python = ">=3.11"

[project.optional-dependencies]
dev = [
  "pytest>=8.0.0",
  "pytest-cov>=5.0.0",
  "ruff>=0.8.0",
  "mypy>=1.13.0",
]
`);
  await writeFile(path.join(repoPath, "src", "fabrica_e2e_python", "__init__.py"), "");
  await writeFile(path.join(repoPath, "src", "fabrica_e2e_python", "main.py"), "def greet(name: str) -> str:\n    return f\"hello {name}\"\n");
  await writeFile(path.join(repoPath, "tests", "test_main.py"), "from src.fabrica_e2e_python.main import greet\n\ndef test_greet() -> None:\n    assert greet(\"mateus\") == \"hello mateus\"\n");

  const qa = generateQaContract({ spec: baseSpec, stack: "python-cli" });
  await writeExecutable(path.join(repoPath, "scripts", "qa.sh"), qa.script_content);

  const result = await runQa(repoPath, {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
  });

  expect(result.stdout).toContain("QA contract PASSED");
  await expect(fs.access(path.join(repoPath, ".venv", "bin", "python"))).resolves.toBeUndefined();
});
```

```ts
// tests/e2e/orchestration-smoke.e2e.test.ts
it("blocks the first developer pickup until the project environment becomes ready", async () => {
  h = await createTestHarness({
    workflow: smokeWorkflow(),
  });
  await h.writeProjects({
    projects: {
      [h.project.slug]: {
        ...h.project,
        stack: "python-cli",
      },
    },
  });
  mockCreateProvider.mockResolvedValue({ provider: h.provider, type: "github" });

  const ensureEnvironmentReady = vi.fn()
    .mockResolvedValueOnce({
      ready: false,
      state: { status: "provisioning", stack: "python-cli", contractVersion: "python@v1", nextProvisionRetryAt: "2026-04-02T12:00:00.000Z" },
    })
    .mockResolvedValueOnce({
      ready: true,
      state: { status: "ready", stack: "python-cli", contractVersion: "python@v1", nextProvisionRetryAt: null },
    });

  const first = await projectTick({
    workspaceDir: h.workspaceDir,
    projectSlug: h.project.slug,
    provider: h.provider,
    runCommand: h.runCommand,
    workflow: smokeWorkflow(),
    targetRole: "developer",
    ensureEnvironmentReady,
  });
  const second = await projectTick({
    workspaceDir: h.workspaceDir,
    projectSlug: h.project.slug,
    provider: h.provider,
    runCommand: h.runCommand,
    workflow: smokeWorkflow(),
    targetRole: "developer",
    ensureEnvironmentReady,
  });

  expect(first.pickups).toHaveLength(0);
  expect(first.skipped).toContainEqual(expect.objectContaining({ reason: "environment_not_ready" }));
  expect(second.pickups).toHaveLength(1);
});
```

- [ ] **Step 2: Run the targeted e2e coverage and confirm the current behavior is still missing**

Run: `VITEST_E2E=1 npm exec vitest run tests/e2e/qa-bootstrap.e2e.test.ts tests/e2e/orchestration-smoke.e2e.test.ts`

Expected: FAIL until the dispatch gate, environment audit events, and recovery exhaustion path are fully wired.

- [ ] **Step 3: Align the harness fixtures with the new persistent stack field**

```ts
// tests/e2e/orchestration-smoke.e2e.test.ts
h = await createTestHarness({ workflow: smokeWorkflow() });
await h.writeProjects({
  projects: {
    [h.project.slug]: {
      ...h.project,
      stack: "python-cli",
      environment: {
        status: "pending",
        stack: "python-cli",
        contractVersion: "python@v1",
        lastProvisionedAt: null,
        lastProvisionError: null,
        nextProvisionRetryAt: null,
      },
    },
  },
});
```

- [ ] **Step 4: Run the release-grade verification set**

Run: `npm run build && npm run test:hot-path && npm run test:all && npm run verify:runtime-boundary`

Expected:
- `npm run build` exits `0`
- `npm run test:hot-path` passes
- `npm run test:all` passes
- `npm run verify:runtime-boundary` passes

- [ ] **Step 5: Commit the final validation slice**

```bash
git add \
  tests/e2e/qa-bootstrap.e2e.test.ts \
  tests/e2e/orchestration-smoke.e2e.test.ts \
  tests/unit/test-env-bootstrap.test.ts
git commit -m "test: validate stack bootstrap and worker recovery"
```

### Task 5: Document The Python-First Contract For Operators And Future Stack Extensions

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`

- [ ] **Step 1: Add a short operator-facing section describing the new environment gate**

```md
## Stack Environment Provisioning

Fabrica now provisions supported stack tooling before dispatching `developer` or `tester`.

- Python stacks bootstrap `uv` without `sudo`
- Each project gets its own isolated environment
- Dispatch is blocked until the environment is ready
- Environment failures are retried automatically before a visible operational failure is raised
```

- [ ] **Step 2: Add an architecture note describing the persistent environment state and recovery distinction**

```md
### Environment Gate vs Worker Recovery

Fabrica distinguishes two operational layers:

- Environment bootstrap failure: the stack toolchain/project environment is not ready, so no worker is dispatched.
- Worker completion failure: a worker was genuinely active but never produced a canonical final result, so recovery runs before the issue is safely requeued.
```

- [ ] **Step 3: Run a quick docs sanity check**

Run: `rg -n "Stack Environment Provisioning|Environment Gate vs Worker Recovery" README.md ARCHITECTURE.md`

Expected: Two matching sections, one in `README.md` and one in `ARCHITECTURE.md`.

- [ ] **Step 4: Commit the documentation update**

```bash
git add README.md ARCHITECTURE.md
git commit -m "docs: describe stack bootstrap and worker recovery"
```
