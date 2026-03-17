import { describe, expect, it } from "vitest";
import type { GenesisPayload, StepContext } from "../../lib/intake/types.js";
import { createTaskStep } from "../../lib/intake/steps/create-task.js";
import { TestProvider } from "../../lib/testing/test-provider.js";

describe("createTaskStep", () => {
  it("creates the issue via provider when provider access is available", async () => {
    const provider = new TestProvider();
    const payload: GenesisPayload = {
      session_id: "sid-create-task",
      timestamp: new Date().toISOString(),
      step: "register",
      raw_idea: "Build a reproducible CLI",
      answers: {},
      metadata: {
        source: "test",
        factory_change: false,
        repo_url: "https://github.com/acme/demo",
        repo_path: "/tmp/demo",
        project_slug: "demo",
        project_registered: true,
      },
      spec: {
        title: "Stack CLI MVP",
        type: "feature",
        objective: "Ship a portable stack CLI",
        scope_v1: ["Implement stack init", "Implement stack run"],
        out_of_scope: ["UI dashboard"],
        acceptance_criteria: ["CLI command works"],
        definition_of_done: ["Tests green"],
        constraints: "Use Go",
        risks: ["Nix bootstrap drift"],
        delivery_target: "cli",
      },
      qa_contract: {
        gates: ["go test"],
        acceptance_tests: [],
        script_content: "go test ./...",
      },
      scaffold: {
        created: true,
        repo_url: "https://github.com/acme/demo",
        repo_local: "/tmp/demo",
        project_slug: "demo",
      },
    };

    const ctx: StepContext = {
      workspaceDir: "/tmp/workspace",
      homeDir: "/tmp/home",
      log: () => {},
      runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      createIssueProvider: async () => ({ provider, type: "github" }),
    };

    const result = await createTaskStep.execute(payload, ctx);

    expect(result.issues).toHaveLength(1);
    expect(result.issues?.[0]?.number).toBe(1);
    expect(result.issues?.[0]?.url).toBe("https://example.com/issues/1");

    const createCalls = provider.callsTo("createIssue");
    const ensureCalls = provider.callsTo("ensureLabel");
    expect(ensureCalls).toHaveLength(1);
    expect(ensureCalls[0]?.args.name).toBe("Planning");
    expect(ensureCalls[0]?.args.color).toBe("#95a5a6");
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.args.label).toBe("Planning");
    expect(createCalls[0]?.args.title).toBe("Stack CLI MVP");
    expect(createCalls[0]?.args.description).toContain("## Objetivo");
    expect(createCalls[0]?.args.description).toContain("## QA Contract");
    expect(createCalls[0]?.args.description).not.toContain("## QA Evidence");
  });

  it("does not require repo_url when a local repo path and provider access are available", async () => {
    const provider = new TestProvider();
    const payload: GenesisPayload = {
      session_id: "sid-create-task-local-only",
      timestamp: new Date().toISOString(),
      step: "register",
      raw_idea: "Build a reproducible CLI",
      answers: {},
      metadata: {
        source: "test",
        factory_change: false,
        repo_path: "/tmp/demo-local",
        project_slug: "demo-local",
        project_registered: true,
      },
      spec: {
        title: "Stack CLI MVP",
        type: "feature",
        objective: "Ship a portable stack CLI",
        scope_v1: ["Implement stack init"],
        out_of_scope: [],
        acceptance_criteria: ["CLI command works"],
        definition_of_done: ["Tests green"],
        constraints: "Use Go",
        risks: [],
        delivery_target: "cli",
      },
      provisioning: {
        ready: true,
        mode: "existing_local",
        repo_url: "" as any,
        repo_local: "/tmp/demo-local",
        default_branch: "main",
        created: true,
        cloned: true,
        seeded: false,
        provider: "github",
      },
    };

    delete payload.metadata.repo_url;

    const ctx: StepContext = {
      workspaceDir: "/tmp/workspace",
      homeDir: "/tmp/home",
      log: () => {},
      runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      createIssueProvider: async () => ({ provider, type: "github" }),
    };

    const result = await createTaskStep.execute(payload, ctx);

    expect(result.issues?.[0]?.number).toBe(1);
    expect(provider.callsTo("createIssue")).toHaveLength(1);
  });

  it("does not run before project registration succeeds", () => {
    const payload: GenesisPayload = {
      session_id: "sid-create-task-unregistered",
      timestamp: new Date().toISOString(),
      step: "register",
      raw_idea: "Build a reproducible CLI",
      answers: {},
      metadata: {
        source: "test",
        factory_change: false,
        repo_path: "/tmp/demo-local",
        project_slug: "demo-local",
        project_registered: false,
      },
      spec: {
        title: "Stack CLI MVP",
        type: "feature",
        objective: "Ship a portable stack CLI",
        scope_v1: ["Implement stack init"],
        out_of_scope: [],
        acceptance_criteria: ["CLI command works"],
        definition_of_done: ["Tests green"],
        constraints: "Use Go",
        risks: [],
        delivery_target: "cli",
      },
      provisioning: {
        ready: true,
        mode: "existing_local",
        repo_url: "" as any,
        repo_local: "/tmp/demo-local",
        default_branch: "main",
        created: true,
        cloned: true,
        seeded: false,
        provider: "github",
      },
    };

    expect(createTaskStep.shouldRun(payload)).toBe(false);
  });

  it("fails closed when executed without successful project registration", async () => {
    const payload: GenesisPayload = {
      session_id: "sid-create-task-unregistered-exec",
      timestamp: new Date().toISOString(),
      step: "register",
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
        objective: "Ship a portable stack CLI",
        scope_v1: ["Implement stack init", "Implement stack run"],
        out_of_scope: ["UI dashboard"],
        acceptance_criteria: ["CLI command works"],
        definition_of_done: ["Tests green"],
        constraints: "Use Go",
        risks: ["Nix bootstrap drift"],
        delivery_target: "cli",
      },
    };

    const ctx: StepContext = {
      workspaceDir: "/tmp/workspace",
      homeDir: "/tmp/home",
      log: () => {},
      runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    };

    await expect(createTaskStep.execute(payload, ctx)).rejects.toThrow(
      "Project must be registered successfully before issue creation",
    );
  });
});
