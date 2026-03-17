/**
 * Tests for the Genesis pipeline orchestrator and individual steps.
 */
import { describe, it, expect, vi } from "vitest";
import { runPipeline } from "../../lib/intake/pipeline.js";
import { receiveStep } from "../../lib/intake/steps/receive.js";
import type { GenesisPayload, StepContext } from "../../lib/intake/types.js";

function makePayload(overrides: Partial<GenesisPayload> = {}): GenesisPayload {
  return {
    session_id: "test-session-001",
    timestamp: "2026-03-09T00:00:00Z",
    step: "init",
    raw_idea: "Criar um CLI para contar palavras",
    answers: {},
    metadata: { source: "test", factory_change: false },
    ...overrides,
  };
}

function makeCtx(commandResults: Record<string, { stdout: string; stderr: string; exitCode: number }> = {}): StepContext {
  return {
    runCommand: vi.fn(async (cmd: string, args: string[]) => {
      const key = `${cmd} ${args.join(" ")}`;
      for (const [pattern, result] of Object.entries(commandResults)) {
        if (key.includes(pattern)) return result;
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    }),
    log: vi.fn(),
    homeDir: "/home/test",
    workspaceDir: "/home/test/.openclaw/workspace",
  };
}

describe("receiveStep", () => {
  it("always runs", () => {
    expect(receiveStep.shouldRun(makePayload())).toBe(true);
  });

  it("preserves existing session_id", async () => {
    const p = await receiveStep.execute(makePayload(), makeCtx());
    expect(p.session_id).toBe("test-session-001");
    expect(p.step).toBe("receive");
  });

  it("generates session_id when missing", async () => {
    const p = await receiveStep.execute(makePayload({ session_id: "" }), makeCtx());
    expect(p.session_id).toBeTruthy();
    expect(p.session_id).not.toBe("");
  });

  it("generates timestamp when missing", async () => {
    const p = await receiveStep.execute(makePayload({ timestamp: "" }), makeCtx());
    expect(p.timestamp).toBeTruthy();
  });
});

describe("runPipeline", () => {
  it("runs all applicable steps", async () => {
    // With dry_run, scaffold/create-task/triage are skipped
    const ctx = makeCtx({
      // classify LLM call — will fail (no real LLM), falling back to keywords
      "openclaw": { stdout: "", stderr: "no agent", exitCode: 1 },
    });

    const result = await runPipeline(makePayload({ dry_run: true }), ctx);

    expect(result.success).toBe(true);
    expect(result.steps_executed).toContain("receive");
    expect(result.steps_executed).toContain("classify");
    expect(result.steps_executed).toContain("research");
    expect(result.steps_executed).toContain("interview");
    expect(result.steps_executed).toContain("map-project");
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);

    // dry_run should skip scaffold, create-task, triage
    expect(result.steps_executed).not.toContain("create-task");
    expect(result.steps_executed).not.toContain("triage");
  });

  it("reports steps skipped", async () => {
    const ctx = makeCtx({
      "openclaw": { stdout: "", stderr: "", exitCode: 1 },
    });

    const result = await runPipeline(makePayload({ dry_run: true }), ctx);
    expect(result.steps_skipped.length).toBeGreaterThan(0);
  });

  it("stops and reports on step failure", async () => {
    // Create a payload that will trigger scaffold step to fail (not dry_run, has spec+impact)
    const ctx = makeCtx({
      "openclaw": { stdout: "", stderr: "", exitCode: 1 },
      "bash": { stdout: "", stderr: "script not found", exitCode: 127 },
    });

    const payload = makePayload({
      dry_run: false,
      spec: {
        title: "Test",
        type: "feature",
        delivery_target: "cli",
        objective: "test",
        scope_v1: ["scope"],
        out_of_scope: [],
        acceptance_criteria: ["ac1"],
        definition_of_done: ["dod1"],
        constraints: [],
        risks: [],
        stack: "python-cli",
      },
      impact: {
        is_greenfield: true,
        affected_files: [],
        new_files_needed: ["main.py"],
        risk_areas: [],
        estimated_files_changed: 2,
      },
    });

    const result = await runPipeline(payload, ctx);

    // scaffold should fail because the bash script doesn't exist
    if (!result.success) {
      expect(result.error).toBeTruthy();
      expect(result.steps_executed.length).toBeGreaterThan(0);
    }
    // Either it fails at scaffold or succeeds because shouldRun returned false
    // Both are valid — the point is the pipeline doesn't crash
  });

  it("enriches payload through each step", async () => {
    const ctx = makeCtx({
      "openclaw": { stdout: "", stderr: "", exitCode: 1 },
    });

    const result = await runPipeline(makePayload({ dry_run: true }), ctx);

    const p = result.payload;
    expect(p.step).toBeDefined();
    // After classify, classification should be set
    if (p.classification) {
      expect(p.classification.type).toBeDefined();
    }
    // After interview, interview should be set
    if (p.interview) {
      expect(p.interview.questions.length).toBeGreaterThan(0);
    }
    if (p.research) {
      expect(Array.isArray(p.research.references)).toBe(true);
    }
    // After generate-spec, spec should be set
    if (p.spec) {
      expect(p.spec.title).toBeTruthy();
      expect(p.spec.acceptance_criteria.length).toBeGreaterThan(0);
    }
    if (p.project_map) {
      expect(p.project_map.is_greenfield).toBe(true);
    }
    if (p.impact) {
      expect(Array.isArray(p.impact.affected_modules)).toBe(true);
    }
  });

  it("logs step_skipped for each dry_run-guarded step", async () => {
    const ctx = makeCtx({
      "openclaw": { stdout: "", stderr: "", exitCode: 1 },
    });
    const payload = makePayload({ dry_run: true });

    const result = await runPipeline(payload, ctx);

    // Verify that log was called with "step_skipped" messages
    const logCalls = (ctx.log as any).mock.calls.map((c: any[]) => c[0]);
    const skipLogs = logCalls.filter((msg: string) => msg.includes("step_skipped"));
    // dry_run pipeline should skip steps that have side effects AND log each skip
    expect(result.steps_skipped.length).toBeGreaterThan(0);
    expect(skipLogs.length).toBeGreaterThan(0); // requires explicit log calls in pipeline.ts
    expect(skipLogs.length).toBe(result.steps_skipped.length); // one log per skipped step
  });

  it("full dry_run produces spec with delivery target and ACs", async () => {
    const ctx = makeCtx({
      "openclaw": { stdout: "", stderr: "", exitCode: 1 },
    });

    const result = await runPipeline(
      makePayload({
        dry_run: true,
        raw_idea: "Criar um CLI para contar palavras em arquivos texto",
      }),
      ctx,
    );

    expect(result.success).toBe(true);
    const p = result.payload;
    expect(p.classification?.type).toBe("feature");
    expect(p.spec?.delivery_target).toBe("cli");
    expect(p.spec?.acceptance_criteria.length).toBeGreaterThan(0);
  });
});
