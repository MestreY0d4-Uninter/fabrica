import { describe, expect, it } from "vitest";
import type { GenesisPayload, StepContext } from "../../lib/intake/types.js";
import { triageStep } from "../../lib/intake/steps/triage.js";
import { TestProvider } from "../../lib/testing/test-provider.js";

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
        objective: "Ship a portable stack CLI",
        scope_v1: ["Implement stack init"],
        out_of_scope: [],
        acceptance_criteria: ["CLI command works"],
        definition_of_done: ["Tests green"],
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
});
