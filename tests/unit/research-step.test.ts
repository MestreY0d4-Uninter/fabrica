import { describe, expect, it, vi } from "vitest";
import { researchStep } from "../../lib/intake/steps/research.js";
import type { GenesisPayload, StepContext } from "../../lib/intake/types.js";

function makePayload(overrides: Partial<GenesisPayload> = {}): GenesisPayload {
  return {
    session_id: "sess-research",
    timestamp: "2026-03-13T00:00:00Z",
    step: "classify",
    raw_idea: "Criar uma Stack CLI em Go com Nix/Flakes para ambientes reproduzíveis e geração de devcontainer",
    answers: {},
    metadata: {
      source: "test",
      factory_change: false,
    },
    classification: {
      type: "feature",
      confidence: 0.91,
      reasoning: "CLI tool request",
      delivery_target: "cli",
    },
    ...overrides,
  };
}

function makeCtx(): StepContext {
  return {
    runCommand: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    log: vi.fn(),
    homeDir: "/home/test",
    workspaceDir: "/home/test/.openclaw/workspace",
  };
}

describe("researchStep", () => {
  it("builds deterministic research with structured references", async () => {
    const result = await researchStep.execute(makePayload(), makeCtx());

    expect(result.step).toBe("research");
    expect(result.research?.status).toBe("ok");
    expect(result.research?.technologies.some((entry) => entry.includes("Nix"))).toBe(true);
    expect(result.research?.references.length).toBeGreaterThan(0);
    expect(result.research?.references[0]).toMatchObject({
      title: expect.any(String),
      url: expect.stringMatching(/^https?:\/\//),
    });
    expect(result.metadata.stack_hint).toBe("go");
    expect(result.metadata.stack_confidence).toBe("high");
    expect(result.metadata.research_summary).toContain("delivery target cli");
  });

  it("preserves explicit stack_hint from metadata", async () => {
    const result = await researchStep.execute(
      makePayload({
        metadata: {
          source: "test",
          factory_change: false,
          stack_hint: "python-cli",
        },
      }),
      makeCtx(),
    );

    expect(result.metadata.stack_hint).toBe("python-cli");
    expect(result.metadata.stack_confidence).toBe("high");
  });
});
