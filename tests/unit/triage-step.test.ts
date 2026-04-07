import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GenesisPayload, StepContext } from "../../lib/intake/types.js";
import { triageStep } from "../../lib/intake/steps/triage.js";
import { TestProvider } from "../../lib/testing/test-provider.js";
import { upsertTelegramBootstrapSession, readTelegramBootstrapSession } from "../../lib/dispatch/telegram-bootstrap-session.js";
import { readProjects, writeProjects } from "../../lib/projects/index.js";
import type { ProjectsData } from "../../lib/projects/types.js";

describe("triageStep", () => {
  it("applies triage side-effects via provider when provider access is available", async () => {
    const provider = new TestProvider();
    provider.seedIssue({
      iid: 42,
      title: "Stack CLI MVP",
      labels: ["Planning"],
    });

    const payload: GenesisPayload = {
      session_id: "sid-triage",
      timestamp: new Date().toISOString(),
      step: "create-task",
      raw_idea: "Build a reproducible CLI",
      answers: {},
      metadata: {
        source: "test",
        factory_change: false,
        repo_url: "https://github.com/acme/demo",
        repo_path: "/tmp/demo",
        project_slug: "demo",
      },
      spec: {
        title: "Stack CLI MVP",
        type: "feature",
        objective: "Ship a portable stack CLI that initializes reproducible environments, validates inputs, and exposes a dependable workflow developers can use safely across local and CI contexts.",
        scope_v1: ["Implement stack init command", "Validate configuration inputs with tests", "Document the command workflow"],
        out_of_scope: [],
        acceptance_criteria: [
          "should initialize a stack configuration from the CLI",
          "validates invalid options before writing files",
          "displays a clear success summary for the operator",
        ],
        definition_of_done: ["tests cover init flow", "documentation explains usage", "qa script passes"],
        constraints: "Use Go",
        risks: [],
        delivery_target: "cli",
      },
      impact: {
        is_greenfield: true,
        affected_files: [],
        affected_modules: [],
        new_files_needed: [],
        risk_areas: [],
        estimated_files_changed: 2,
      },
      scaffold: {
        created: true,
        repo_url: "https://github.com/acme/demo",
        repo_local: "/tmp/demo",
        project_slug: "demo",
      },
      issues: [
        {
          number: 42,
          url: "https://example.com/issues/42",
          created_at: new Date().toISOString(),
        },
      ],
    };

    const ctx: StepContext = {
      workspaceDir: "/tmp/workspace",
      homeDir: "/tmp/home",
      log: () => {},
      runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      createIssueProvider: async () => ({ provider, type: "github" }),
    };

    const result = await triageStep.execute(payload, ctx);

    expect(result.triage?.ready_for_dispatch).toBe(true);
    expect(result.triage?.target_state).toBe("To Do");
    expect(result.fidelity_brief?.requested_deliverable).toBe("cli");
    expect(result.metadata.fidelity_brief?.requested_stack).toBeNull();
    expect(result.fidelity_brief?.primary_objective).toContain("portable stack CLI");
    expect(result.fidelity_brief?.confidence).toBe("medium");
    expect(result.triage?.labels_applied).toEqual(
      expect.arrayContaining(["priority:medium", "effort:small", "type:feature"]),
    );

    const addLabelCalls = provider.callsTo("addLabel");
    expect(addLabelCalls.map((call) => call.args.label)).toEqual(
      expect.arrayContaining(["priority:medium", "effort:small", "type:feature", "developer:junior"]),
    );

    const transitionCalls = provider.callsTo("transitionLabel");
    expect(transitionCalls).toHaveLength(1);
    expect(transitionCalls[0]?.args).toEqual({ issueId: 42, from: "Planning", to: "To Do" });
  });

  it("decomposes large ready work into parent + child issues instead of dispatching immediately", async () => {
    const provider = new TestProvider();
    provider.seedIssue({
      iid: 42,
      title: "Task Manager API",
      labels: ["Planning"],
    });

    const payload: GenesisPayload = {
      session_id: "sid-triage-large",
      timestamp: new Date().toISOString(),
      step: "create-task",
      raw_idea: "Build a task management API with authentication, projects, task assignment, notifications, background worker, and reporting.",
      answers: {},
      metadata: {
        source: "test",
        factory_change: false,
        repo_url: "https://github.com/acme/demo",
        repo_path: "/tmp/demo",
        project_slug: "demo",
      },
      spec: {
        title: "Task Manager API",
        type: "feature",
        objective: "Build a production-ready task management API that supports authentication, project management, task assignment, overdue reminders, activity visibility, and delivery-ready quality gates for a small team workflow.",
        scope_v1: [
          "Implement authentication endpoints with JWT and protected routes",
          "Implement project CRUD endpoints and membership rules with tests",
          "Implement task CRUD, assignment, and status transitions",
          "Implement overdue reminder processing with a background worker",
        ],
        out_of_scope: [],
        acceptance_criteria: [
          "should allow authenticated users to create and manage projects",
          "returns task assignment updates through API endpoints",
          "sends overdue reminders using the background worker",
        ],
        definition_of_done: ["tests cover core endpoints", "documentation explains the workflow", "qa script passes"],
        constraints: "Use Python/FastAPI",
        risks: [],
        delivery_target: "api",
      },
      impact: {
        is_greenfield: true,
        affected_files: [],
        affected_modules: [],
        new_files_needed: [],
        risk_areas: ["auth", "background-worker", "notifications"],
        estimated_files_changed: 18,
      },
      scaffold: {
        created: true,
        repo_url: "https://github.com/acme/demo",
        repo_local: "/tmp/demo",
        project_slug: "demo",
      },
      issues: [{ number: 42, url: "https://example.com/issues/42", created_at: new Date().toISOString() }],
    };

    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-triage-large-"));
    const projectsData: ProjectsData = {
      projects: {
        demo: {
          slug: "demo",
          name: "demo",
          repo: "/tmp/demo",
          repoRemote: "https://github.com/acme/demo",
          groupName: "Project: demo",
          deployUrl: "",
          baseBranch: "main",
          deployBranch: "main",
          channels: [],
          provider: "github",
          workers: {},
          issueRuntime: {},
          stack: null,
          environment: null,
        },
      },
    };
    await writeProjects(workspaceDir, projectsData);

    const ctx: StepContext = {
      workspaceDir,
      homeDir: "/tmp/home",
      log: () => {},
      runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      createIssueProvider: async () => ({ provider, type: "github" }),
    };

    const result = await triageStep.execute(payload, ctx);

    expect(result.triage?.decomposition_mode).toBe("parent_child");
    expect(result.triage?.ready_for_dispatch).toBe(false);
    expect(result.triage?.quality_criticality).toBe("high");
    expect(result.triage?.complexity).toBe("high");
    expect(result.triage?.coupling).toBe("low");
    expect(result.triage?.parallelizability).toBe("medium");
    expect(result.triage?.risk_profile).toEqual(expect.arrayContaining(["auth", "async_processing"]));
    expect(result.triage?.child_issue_numbers?.length).toBeGreaterThanOrEqual(2);

    const createdIssues = provider.callsTo("createIssue");
    expect(createdIssues.length).toBeGreaterThanOrEqual(2);
    expect(createdIssues[0]?.args.title).toContain("Authentication");
    expect(createdIssues[0]?.args.description).toContain("## Capability Area");
    expect(createdIssues[0]?.args.description).toContain("## Execution Profile");
    expect(createdIssues[0]?.args.description).toContain("Recommended level:");
    expect(createdIssues[0]?.args.description).toContain("Parallelizable:");
    const transitionCalls = provider.callsTo("transitionLabel");
    expect(transitionCalls.some((call) => call.args.issueId === 42)).toBe(false);
    expect(transitionCalls.filter((call) => call.args.issueId !== 42).length).toBeGreaterThanOrEqual(2);
    expect(transitionCalls.filter((call) => call.args.issueId !== 42).every((call) => call.args.from === "Planning" && call.args.to === "To Do")).toBe(true);
    expect(provider.callsTo("addLabel").map((call) => call.args.label)).toEqual(
      expect.arrayContaining(["decomposition:parent", "decomposition:child", "effort:large"]),
    );
    const childAddLabels = provider.callsTo("addLabel").filter((call) => call.args.issueId !== 42).map((call) => call.args.label);
    expect(childAddLabels).toEqual(expect.arrayContaining(["developer:senior", "developer:medior"]));
    expect(provider.callsTo("addComment").some((call) => String(call.args.body).includes("## Decomposition Plan"))).toBe(true);

    const persisted = await readProjects(workspaceDir);
    const parentRuntime = persisted.projects.demo?.issueRuntime?.["42"];
    expect(parentRuntime?.decompositionMode).toBe("parent_child");
    expect(parentRuntime?.decompositionStatus).toBe("active");
    expect(parentRuntime?.childIssueIds?.length).toBeGreaterThanOrEqual(2);
    const childIds = parentRuntime?.childIssueIds ?? [];
    for (const childId of childIds) {
      expect(persisted.projects.demo?.issueRuntime?.[String(childId)]?.parentIssueId).toBe(42);
    }
    if (childIds.length >= 2) {
      const secondChildRuntime = persisted.projects.demo?.issueRuntime?.[String(childIds[1])];
      expect(secondChildRuntime?.dependencyIssueIds).toContain(childIds[0]);
    }
    expect(parentRuntime?.maxParallelChildren).toBeGreaterThanOrEqual(1);
    expect(parentRuntime?.maxParallelChildren).toBeLessThanOrEqual(4);

    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("keeps large but tightly coupled work as a single executable issue instead of forcing decomposition", async () => {
    const provider = new TestProvider();
    provider.seedIssue({
      iid: 84,
      title: "Billing workflow hardening",
      labels: ["Planning"],
    });

    const payload: GenesisPayload = {
      session_id: "sid-triage-coupled",
      timestamp: new Date().toISOString(),
      step: "create-task",
      raw_idea: "Harden a billing workflow that touches auth, RBAC, API contracts, background reconciliation jobs, database migrations, and admin dashboards in one tightly coupled pass.",
      answers: {},
      metadata: {
        source: "test",
        factory_change: false,
        repo_url: "https://github.com/acme/demo",
        repo_path: "/tmp/demo",
        project_slug: "demo",
      },
      spec: {
        title: "Billing workflow hardening",
        type: "feature",
        objective: "Harden the billing workflow end to end across authentication, authorization, APIs, migrations, reconciliation jobs, and the operator dashboard without splitting ownership across unstable boundaries.",
        scope_v1: [
          "Update authentication, authorization, and RBAC checks for billing actions",
          "Add database migration and persistence changes required for the new billing states",
          "Update API routes and admin dashboard behavior for the same workflow",
          "Update the reconciliation worker so it matches the new schema and auth rules",
        ],
        out_of_scope: [],
        acceptance_criteria: [
          "Allows billing actions only when the required auth and permission rules pass in the API and admin dashboard",
          "Validates migrated data and keeps reconciliation jobs consistent with the new API behavior",
          "Returns the same workflow states in the admin dashboard UI and API responses",
        ],
        definition_of_done: ["tests pass", "migration validated", "qa passes"],
        constraints: "No partial rollout with competing PRs.",
        risks: ["High coupling across data, auth, worker, and UI layers"],
        delivery_target: "hybrid",
      },
      impact: {
        is_greenfield: false,
        affected_files: [],
        affected_modules: [],
        new_files_needed: [],
        risk_areas: ["auth", "database", "worker", "frontend"],
        estimated_files_changed: 18,
      },
      scaffold: {
        created: true,
        repo_url: "https://github.com/acme/demo",
        repo_local: "/tmp/demo",
        project_slug: "demo",
      },
      issues: [{ number: 84, url: "https://example.com/issues/84", created_at: new Date().toISOString() }],
    };

    const ctx: StepContext = {
      workspaceDir: "/tmp/workspace",
      homeDir: "/tmp/home",
      log: () => {},
      runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      createIssueProvider: async () => ({ provider, type: "github" }),
    };

    const result = await triageStep.execute(payload, ctx);

    expect(result.triage?.effort).toBe("large");
    expect(result.triage?.coupling).toBe("high");
    expect(result.triage?.parallelizability).toBe("low");
    expect(result.triage?.decomposition_mode).toBe("none");
    expect(result.triage?.ready_for_dispatch).toBe(true);
    expect(provider.callsTo("createIssue")).toHaveLength(0);
    expect(provider.callsTo("transitionLabel")).toContainEqual(expect.objectContaining({
      args: { issueId: 84, from: "Planning", to: "To Do" },
    }));
  });

  it("persists blocked triage status back into the telegram bootstrap session", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-bootstrap-triage-"));
    await upsertTelegramBootstrapSession(workspaceDir, {
      conversationId: "telegram:6951571380",
      rawIdea: "Build an SRE incident desk",
      projectName: "sre-incident-desk-v1",
      stackHint: "fastapi",
      status: "dispatching",
      bootstrapStep: "project_registered",
      projectSlug: "sre-incident-desk-v1",
      issueId: 7,
      issueUrl: "https://example.com/issues/7",
      messageThreadId: 1861,
      projectChannelId: "-1003709213169",
    });

    const provider = new TestProvider();
    provider.seedIssue({ iid: 7, title: "Thin spec", labels: ["Planning"] });

    const payload: GenesisPayload = {
      session_id: "sid-triage-block",
      timestamp: new Date().toISOString(),
      step: "create-task",
      raw_idea: "Build a task management API with auth, projects, tasks, notifications, and worker.",
      answers: {},
      metadata: {
        source: "telegram-dm-bootstrap",
        factory_change: false,
        repo_url: "https://github.com/acme/demo",
        repo_path: "/tmp/demo",
        project_slug: "demo",
        project_name: "sre-incident-desk-v1",
        stack_hint: "fastapi",
        channel_id: "telegram:6951571380",
        message_thread_id: 1861,
      },
      spec: {
        title: "Thin spec",
        type: "feature",
        objective: "Build a task API quickly",
        scope_v1: ["Add auth", "Add tasks", "Add notifications"],
        out_of_scope: [],
        acceptance_criteria: ["works", "is secure", "is fast"],
        definition_of_done: ["done"],
        constraints: "Use FastAPI",
        risks: [],
        delivery_target: "api",
      },
      impact: {
        is_greenfield: true,
        affected_files: [],
        affected_modules: [],
        new_files_needed: [],
        risk_areas: ["auth", "notifications"],
        estimated_files_changed: 16,
      },
      scaffold: {
        created: true,
        repo_url: "https://github.com/acme/demo",
        repo_local: "/tmp/demo",
        project_slug: "demo",
      },
      issues: [{ number: 7, url: "https://example.com/issues/7", created_at: new Date().toISOString() }],
    };

    const ctx: StepContext = {
      workspaceDir,
      homeDir: "/tmp/home",
      log: () => {},
      runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      createIssueProvider: async () => ({ provider, type: "github" }),
    };

    const result = await triageStep.execute(payload, ctx);
    expect(result.triage?.ready_for_dispatch).toBe(false);

    const session = await readTelegramBootstrapSession(workspaceDir, "telegram:6951571380");
    expect(session?.issueId).toBe(7);
    expect(session?.triageReadyForDispatch).toBe(false);
    expect(session?.triageErrors).toContain("spec_quality_block");
  });

  it("does not spec-quality-block the real SRE incident desk fallback shape after the wording hardening", async () => {
    const provider = new TestProvider();
    provider.seedIssue({ iid: 11, title: "SRE incident desk", labels: ["Planning"] });

    const payload: GenesisPayload = {
      session_id: "sid-sre-real-shape",
      timestamp: new Date().toISOString(),
      step: "create-task",
      raw_idea: "Build a production-ready SRE incident desk for small operations teams. It should let responders open incidents, assign owners, maintain timeline entries, publish status updates, acknowledge alert events, inspect audit trails, manage role-based permissions, and run escalation/reminder jobs in the background.",
      answers: {},
      metadata: {
        source: "telegram-dm-bootstrap",
        factory_change: false,
        repo_url: "https://github.com/acme/sre-incident-desk-v1",
        repo_path: "/tmp/sre-incident-desk-v1",
        project_slug: "sre-incident-desk-v1",
        project_name: "sre-incident-desk-v1",
        stack_hint: "fastapi",
        channel_id: "telegram:6951571380",
        message_thread_id: 1861,
      },
      spec: {
        title: "SRE Incident Desk",
        type: "feature",
        objective: "Build a production-ready SRE incident desk for small operations teams with incidents, timelines, alert acknowledgements, audit trails, role-based permissions, and background escalation or reminder processing.",
        scope_v1: [
          "Implement authentication, authorization, and role-aware access rules",
          "Implement the core domain workflows and CRUD endpoints for the main entities",
          "Implement notifications, reminders, and escalation flows for key events",
        ],
        out_of_scope: ["To be defined during implementation"],
        acceptance_criteria: [
          "Allows operators to complete the primary workflow end to end as requested",
          "Validates and enforces the role, permission, or delivery constraints described in the request",
          "Processes the asynchronous or background behavior required for the main operational path",
        ],
        definition_of_done: ["Code reviewed and merged", "Tests pass", "QA contract passes"],
        constraints: "Delivery target: unknown.",
        risks: [],
        delivery_target: "api",
      },
      impact: {
        is_greenfield: true,
        affected_files: [],
        affected_modules: [],
        new_files_needed: [],
        risk_areas: ["auth", "background-worker", "notifications"],
        estimated_files_changed: 12,
      },
      scaffold: {
        created: true,
        repo_url: "https://github.com/acme/sre-incident-desk-v1",
        repo_local: "/tmp/sre-incident-desk-v1",
        project_slug: "sre-incident-desk-v1",
      },
      issues: [{ number: 11, url: "https://example.com/issues/11", created_at: new Date().toISOString() }],
    };

    const ctx: StepContext = {
      workspaceDir: "/tmp/workspace",
      homeDir: "/tmp/home",
      log: () => {},
      runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      createIssueProvider: async () => ({ provider, type: "github" }),
    };

    const result = await triageStep.execute(payload, ctx);
    expect(result.triage?.errors).not.toContain("spec_quality_block");
  });

  it("blocks automatic dispatch for large work when spec quality is insufficient", async () => {
    const provider = new TestProvider();
    provider.seedIssue({ iid: 7, title: "Thin spec", labels: ["Planning"] });

    const payload: GenesisPayload = {
      session_id: "sid-triage-block",
      timestamp: new Date().toISOString(),
      step: "create-task",
      raw_idea: "Build a task management API with auth, projects, tasks, notifications, and worker.",
      answers: {},
      metadata: {
        source: "test",
        factory_change: false,
        repo_url: "https://github.com/acme/demo",
        repo_path: "/tmp/demo",
        project_slug: "demo",
      },
      spec: {
        title: "Thin spec",
        type: "feature",
        objective: "Build a task API quickly",
        scope_v1: ["Add auth", "Add tasks", "Add notifications"],
        out_of_scope: [],
        acceptance_criteria: ["works", "is secure", "is fast"],
        definition_of_done: ["done"],
        constraints: "Use FastAPI",
        risks: [],
        delivery_target: "api",
      },
      impact: {
        is_greenfield: true,
        affected_files: [],
        affected_modules: [],
        new_files_needed: [],
        risk_areas: ["auth", "notifications"],
        estimated_files_changed: 16,
      },
      scaffold: {
        created: true,
        repo_url: "https://github.com/acme/demo",
        repo_local: "/tmp/demo",
        project_slug: "demo",
      },
      issues: [{ number: 7, url: "https://example.com/issues/7", created_at: new Date().toISOString() }],
    };

    const ctx: StepContext = {
      workspaceDir: "/tmp/workspace",
      homeDir: "/tmp/home",
      log: () => {},
      runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      createIssueProvider: async () => ({ provider, type: "github" }),
    };

    const result = await triageStep.execute(payload, ctx);

    expect(result.triage?.ready_for_dispatch).toBe(false);
    expect(result.triage?.errors).toContain("spec_quality_block");
    expect(provider.callsTo("createIssue")).toHaveLength(0);
    expect(provider.callsTo("transitionLabel")).toHaveLength(0);
    expect(provider.callsTo("addComment").some((call) => String(call.args.body).includes("Spec quality gate blocked automatic dispatch"))).toBe(true);
  });
});
