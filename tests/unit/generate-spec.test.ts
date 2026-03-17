import { describe, expect, it, vi } from "vitest";
import { generateSpecStep } from "../../lib/intake/steps/generate-spec.js";
import type { GenesisPayload, StepContext } from "../../lib/intake/types.js";

function makeCtx(): StepContext {
  return {
    runCommand: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    log: vi.fn(),
    homeDir: "/home/test",
    workspaceDir: "/home/test/.openclaw/workspace",
  };
}

function makePayload(overrides: Partial<GenesisPayload> = {}): GenesisPayload {
  return {
    session_id: "test-session",
    timestamp: "2026-03-13T00:00:00Z",
    step: "interview",
    raw_idea: "Criar um CLI para ambientes reproduzíveis com Nix/Flakes",
    answers: {},
    metadata: { source: "test", factory_change: false },
    classification: { type: "feature", delivery_target: "cli", confidence: "high" },
    spec_data: {
      title: "Stack CLI",
      objective: "Criar uma ferramenta de linha de comando para ambientes reproduzíveis.",
      scope_v1: ["Comandos init, add e shell"],
      out_of_scope: [],
      acceptance_criteria: ["O CLI inicializa e usa ambientes reproduzíveis."],
      definition_of_done: ["Testes passam"],
      constraints: "Usar Go ou Rust",
      risks: [],
      delivery_target: "cli",
    },
    ...overrides,
  };
}

describe("generateSpecStep", () => {
  it("does not auto-inject UI/API ACs for hybrid targets", async () => {
    const payload = makePayload({
      classification: { type: "feature", delivery_target: "hybrid", confidence: "low" },
      spec_data: {
        ...makePayload().spec_data!,
        delivery_target: "hybrid",
        acceptance_criteria: ["O produto resolve o fluxo principal descrito."],
      },
    });

    const result = await generateSpecStep.execute(payload, makeCtx());
    const joined = result.spec!.acceptance_criteria.join("\n").toLowerCase();

    expect(joined).not.toMatch(/interface\/tela funcional/);
    expect(joined).not.toMatch(/api\/endpoint funcional/);
  });

  it("keeps explicit CLI prompts focused on CLI even with optional web/api roadmap mentions", async () => {
    const payload = makePayload({
      raw_idea: `Stack CLI

Objetivo do MVP:
- Ferramenta de linha de comando com stack init, stack add, stack shell

Roadmap opcional:
- Interface web opcional
- API opcional`,
      classification: { type: "feature", delivery_target: "unknown", confidence: "medium" },
      spec_data: {
        ...makePayload().spec_data!,
        delivery_target: "unknown",
        acceptance_criteria: ["Existe um comando CLI funcional do fluxo principal."],
      },
    });

    const result = await generateSpecStep.execute(payload, makeCtx());

    expect(result.spec!.delivery_target).toBe("cli");
    expect(result.spec!.acceptance_criteria.join("\n").toLowerCase()).not.toContain("api/endpoint funcional");
    expect(result.spec!.acceptance_criteria.join("\n").toLowerCase()).not.toContain("interface/tela funcional");
  });
});
