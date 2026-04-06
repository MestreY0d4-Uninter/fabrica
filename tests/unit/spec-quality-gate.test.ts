import { describe, it, expect } from "vitest";
import { validateSpecQuality, type SpecQualityInput } from "../../lib/intake/lib/triage-logic.js";
import { runTriageLogic, type TriageInput, type TriageMatrix } from "../../lib/intake/lib/triage-logic.js";
import matrix from "../../lib/intake/configs/triage-matrix.json";

const MATRIX = matrix as TriageMatrix;

const goodSpec: SpecQualityInput = {
  // 22 words — satisfies >=20 word requirement
  objective: "Criar um CLI em Python que converte temperaturas entre Celsius, Fahrenheit e Kelvin com validacao de entrada e saida formatada",
  scopeItems: ["converter celsius para fahrenheit", "converter fahrenheit para celsius", "converter para kelvin"],
  acceptanceCriteria: [
    "deve aceitar temperatura via argumento de linha de comando",
    "retorna erro claro para entrada invalida",
    "valida que temperatura nao e abaixo do zero absoluto",
  ],
  dod: "todos os testes passando, cobertura >= 80%, lint limpo",
};

describe("validateSpecQuality", () => {
  it("passes a well-formed spec", () => {
    const errors = validateSpecQuality(goodSpec);
    expect(errors).toEqual([]);
  });

  it("rejects objective < 20 words", () => {
    const errors = validateSpecQuality({ ...goodSpec, objective: "fazer um app" });
    expect(errors).toContain("spec_objective_too_short");
  });

  it("rejects < 3 scope items", () => {
    const errors = validateSpecQuality({ ...goodSpec, scopeItems: ["item1", "item2"] });
    expect(errors).toContain("spec_scope_insufficient");
  });

  it("rejects < 3 acceptance criteria", () => {
    const errors = validateSpecQuality({ ...goodSpec, acceptanceCriteria: ["deve funcionar"] });
    expect(errors).toContain("spec_ac_insufficient");
  });

  it("rejects AC without action verbs", () => {
    const errors = validateSpecQuality({
      ...goodSpec,
      acceptanceCriteria: ["coisa boa", "algo legal", "funcionalidade ok"],
    });
    expect(errors).toContain("spec_ac_no_action_verbs");
  });

  it("rejects DoD that does not mention test/teste", () => {
    const errors = validateSpecQuality({ ...goodSpec, dod: "deploy feito" });
    expect(errors).toContain("spec_dod_no_test_mention");
  });
});

describe("triage integration", () => {
  it("sets specQualityBlock=true when spec quality fails", () => {
    const input: TriageInput = {
      type: "feature",
      deliveryTarget: "cli",
      acCount: 1,
      scopeCount: 1,
      dodCount: 1,
      filesChanged: 2,
      totalRisks: 0,
      objective: "fazer um app",
      rawIdea: "fazer um app",
      acText: "funciona",
      scopeText: "item",
      dodText: "deploy feito",
      oosText: "",
      authSignal: false,
    };
    const result = runTriageLogic(input, MATRIX);
    expect(result.specQualityBlock).toBe(true);
  });

  it("sets specQualityBlock=false when spec quality passes", () => {
    const input: TriageInput = {
      type: "feature",
      deliveryTarget: "cli",
      acCount: 3,
      scopeCount: 3,
      dodCount: 1,
      filesChanged: 3,
      totalRisks: 0,
      objective: "Criar um CLI em Python que converte temperaturas entre Celsius, Fahrenheit e Kelvin com validacao de entrada e saida formatada",
      rawIdea: "Criar um CLI em Python que converte temperaturas entre Celsius, Fahrenheit e Kelvin com validacao de entrada e saida formatada",
      acText: "deve aceitar temperatura via argumento\nretorna erro claro para entrada invalida\nvalida que temperatura nao e abaixo do zero absoluto",
      scopeText: "converter celsius para fahrenheit\nconverter fahrenheit para celsius\nconverter para kelvin",
      dodText: "todos os testes passando\ncobertura >= 80%\nlint limpo",
      oosText: "",
      authSignal: false,
    };
    const result = runTriageLogic(input, MATRIX);
    expect(result.specQualityBlock).toBe(false);
  });
});
