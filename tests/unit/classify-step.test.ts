import { describe, expect, it, vi } from "vitest";
import { classifyStep } from "../../lib/intake/steps/classify.js";
import type { GenesisPayload, StepContext } from "../../lib/intake/types.js";

function makeCtx(commandResult: { stdout: string; stderr: string; exitCode: number }): StepContext {
  return {
    runCommand: vi.fn(async () => commandResult),
    log: vi.fn(),
    homeDir: "/tmp/fabrica-home",
    workspaceDir: "/tmp/fabrica-home/.openclaw/workspace",
  };
}

function makePayload(overrides: Partial<GenesisPayload> = {}): GenesisPayload {
  return {
    session_id: "sid-classify",
    timestamp: "2026-04-03T13:30:00.000Z",
    step: "receive",
    raw_idea: "Build a small Python CLI tool called md-frontmatter-audit.",
    answers: {},
    metadata: {
      source: "telegram-dm-bootstrap",
      factory_change: false,
    },
    ...overrides,
  };
}

describe("classifyStep", () => {
  it("accepts direct JSON classifications without the legacy payloads wrapper", async () => {
    const ctx = makeCtx({
      stdout: '{"type":"feature","confidence":0.93,"reasoning":"New tool request"}',
      stderr: "",
      exitCode: 0,
    });

    const result = await classifyStep.execute(makePayload(), ctx);

    expect(result.classification).toEqual({
      type: "feature",
      confidence: 0.93,
      reasoning: "[LLM] New tool request",
      alternatives: [],
      delivery_target: "cli",
    });
  });

  it("falls back to feature for known greenfield Telegram bootstraps when LLM output is unusable", async () => {
    const ctx = makeCtx({
      stdout: '{"error":"402 paid model"}',
      stderr: "",
      exitCode: 0,
    });

    const result = await classifyStep.execute(makePayload({
      raw_idea: `Build a small Python CLI tool called md-frontmatter-audit.

Requirements:
- It reads a Markdown file path from the command line.
- Report a clear error when the frontmatter YAML is invalid.`,
    }), ctx);

    expect(result.classification).toEqual({
      type: "feature",
      confidence: 0.8,
      reasoning: "[Heuristic] Known greenfield bootstrap requests default to 'feature' when LLM classification is unavailable.",
      alternatives: [],
      delivery_target: "cli",
    });
  });

  it("keeps keyword fallback for non-bootstrap ideas when LLM output is unusable", async () => {
    const ctx = makeCtx({
      stdout: '{"error":"402 paid model"}',
      stderr: "",
      exitCode: 0,
    });

    const result = await classifyStep.execute(makePayload({
      raw_idea: "Fix invalid YAML parsing in the existing frontmatter command.",
      metadata: {
        source: "test",
        factory_change: false,
        repo_url: "https://github.com/acme/frontmatter-cli",
      },
    }), ctx);

    expect(result.classification?.type).toBe("bugfix");
    expect(result.classification?.delivery_target).toBe("unknown");
  });
});
