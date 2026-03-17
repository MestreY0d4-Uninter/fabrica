import { describe, it, expect, vi } from "vitest";
import { interviewStep } from "../../lib/intake/steps/interview.js";
import type { GenesisPayload, StepContext } from "../../lib/intake/types.js";

function basePayload(rawIdea: string): GenesisPayload {
  return {
    protocolVersion: 2,
    session_id: "session-1",
    raw_idea: rawIdea,
    step: "classify",
    classification: {
      type: "feature",
      confidence: 0.92,
      reasoning: "explicit feature request",
      delivery_target: "cli",
    },
  };
}

function ctx(): StepContext {
  return {
    runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    log: vi.fn(),
    homeDir: "/tmp",
    workspaceDir: "/tmp/workspace",
  };
}

describe("interviewStep", () => {
  it("does not emit detail_level and keeps stable questions across prompt sizes", async () => {
    const shortResult = await interviewStep.execute(
      basePayload("Criar uma CLI para gerar ambientes reproduzíveis."),
      ctx(),
    );
    const longResult = await interviewStep.execute(
      basePayload(`Criar uma CLI para gerar ambientes reproduzíveis.

MVP:
- stack init
- stack add
- stack shell

Contexto:
- usar Nix/Flakes
- manter consistência entre Linux, macOS e WSL
- ter geração opcional de devcontainer e direnv`),
      ctx(),
    );

    expect(shortResult.interview?.questions.map((q) => q.id)).toEqual(
      longResult.interview?.questions.map((q) => q.id),
    );
    expect(shortResult.interview).not.toHaveProperty("detail_level");
    expect(longResult.interview).not.toHaveProperty("detail_level");
  });

  it("keeps clarity guidance without inferring technical profile", async () => {
    const result = await interviewStep.execute(
      basePayload("Criar uma API para pagamentos com webhook."),
      ctx(),
    );

    expect(result.interview?.guidelines).toContain("Use clear language");
    expect(result.interview?.guidelines).toContain("preserve the user's technical terms");
    expect(result.interview?.guidelines).not.toContain("detail");
    expect(result.interview?.guidelines).not.toContain("non-technical");
  });
});
