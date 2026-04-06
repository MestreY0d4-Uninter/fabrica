import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GenesisPayload, StepContext } from "../../lib/intake/types.js";
import { triageStep } from "../../lib/intake/steps/triage.js";
import { TestProvider } from "../../lib/testing/test-provider.js";
import { upsertTelegramBootstrapSession, readTelegramBootstrapSession } from "../../lib/dispatch/telegram-bootstrap-session.js";

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

    const ctx: StepContext = {
      workspaceDir: "/tmp/workspace",
      homeDir: "/tmp/home",
      log: () => {},
      runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      createIssueProvider: async () => ({ provider, type: "github" }),
    };

    const result = await triageStep.execute(payload, ctx);

    expect(result.triage?.decomposition_mode).toBe("parent_child");
    expect(result.triage?.ready_for_dispatch).toBe(false);
    expect(result.triage?.child_issue_numbers?.length).toBeGreaterThanOrEqual(2);

    const createdIssues = provider.callsTo("createIssue");
    expect(createdIssues.length).toBeGreaterThanOrEqual(2);
    expect(provider.callsTo("transitionLabel")).toHaveLength(0);
    expect(provider.callsTo("addLabel").map((call) => call.args.label)).toEqual(
      expect.arrayContaining(["decomposition:parent", "decomposition:child", "effort:large"]),
    );
    expect(provider.callsTo("addComment").some((call) => String(call.args.body).includes("## Decomposition Plan"))).toBe(true);
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
