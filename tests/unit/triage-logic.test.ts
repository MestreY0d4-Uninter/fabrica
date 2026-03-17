/**
 * Tests for triage decision logic.
 */
import { describe, it, expect } from "vitest";
import {
  calculateEffort,
  calculatePriority,
  validateDoR,
  determineLevel,
  runTriageLogic,
} from "../../lib/intake/lib/triage-logic.js";
import type { TriageMatrix, TriageInput } from "../../lib/intake/lib/triage-logic.js";
import matrix from "../../lib/intake/configs/triage-matrix.json";

const MATRIX = matrix as TriageMatrix;

describe("calculateEffort", () => {
  it("returns small for <=3 files and <=3 ACs", () => {
    expect(calculateEffort(1, 1)).toBe("small");
    expect(calculateEffort(3, 3)).toBe("small");
  });

  it("returns medium for <=10 files and <=7 ACs", () => {
    expect(calculateEffort(4, 4)).toBe("medium");
    expect(calculateEffort(10, 7)).toBe("medium");
  });

  it("returns large for <=25 files and <=15 ACs", () => {
    expect(calculateEffort(11, 8)).toBe("large");
    expect(calculateEffort(25, 15)).toBe("large");
  });

  it("returns xlarge for larger counts", () => {
    expect(calculateEffort(26, 16)).toBe("xlarge");
    expect(calculateEffort(100, 50)).toBe("xlarge");
  });

  it("both dimensions must satisfy threshold (AND logic)", () => {
    // 2 files but 8 ACs → large (ACs exceed medium's max_acs=7)
    expect(calculateEffort(2, 8)).toBe("large");
    // 15 files but 2 ACs → large (files exceed medium's max_files=10)
    expect(calculateEffort(15, 2)).toBe("large");
    // Both within medium bounds
    expect(calculateEffort(5, 5)).toBe("medium");
  });
});

describe("calculatePriority", () => {
  it("bugfix with >=3 risks → P0 critical", () => {
    const { priority, label } = calculatePriority("bugfix", "small", 3, MATRIX);
    expect(priority).toBe("P0");
    expect(label).toBe("priority:critical");
  });

  it("bugfix with <3 risks → P1 high", () => {
    const { priority } = calculatePriority("bugfix", "medium", 1, MATRIX);
    expect(priority).toBe("P1");
  });

  it("feature small → P2 medium", () => {
    const { priority } = calculatePriority("feature", "small", 0, MATRIX);
    expect(priority).toBe("P2");
  });

  it("feature non-small → P3 normal", () => {
    const { priority } = calculatePriority("feature", "medium", 0, MATRIX);
    expect(priority).toBe("P3");
  });

  it("refactor → P3 normal", () => {
    const { priority } = calculatePriority("refactor", "medium", 0, MATRIX);
    expect(priority).toBe("P3");
  });

  it("infra → P2 medium", () => {
    const { priority } = calculatePriority("infra", "large", 0, MATRIX);
    expect(priority).toBe("P2");
  });

  it("research → P3 normal", () => {
    const { priority } = calculatePriority("research", "small", 0, MATRIX);
    expect(priority).toBe("P3");
  });
});

describe("validateDoR", () => {
  const validInput: TriageInput = {
    type: "feature",
    deliveryTarget: "cli",
    acCount: 3,
    scopeCount: 2,
    dodCount: 2,
    filesChanged: 5,
    totalRisks: 1,
    objective: "Build a word counter CLI",
    rawIdea: "Criar um programa para contar palavras",
    acText: "O programa recebe um arquivo e conta palavras",
    scopeText: "Implementar contagem de palavras no terminal",
    oosText: "Interface gráfica não faz parte",
    authSignal: false,
  };

  it("passes for complete CLI input", () => {
    const errors = validateDoR(validInput);
    expect(errors).toEqual([]);
  });

  it("catches missing objective", () => {
    const errors = validateDoR({ ...validInput, objective: "" });
    expect(errors).toContain("dor_missing_objective");
  });

  it("catches missing scope", () => {
    const errors = validateDoR({ ...validInput, scopeCount: 0 });
    expect(errors).toContain("dor_missing_scope");
  });

  it("catches missing ACs", () => {
    const errors = validateDoR({ ...validInput, acCount: 0 });
    expect(errors).toContain("dor_missing_acceptance_criteria");
  });

  it("catches missing DoD", () => {
    const errors = validateDoR({ ...validInput, dodCount: 0 });
    expect(errors).toContain("dor_missing_definition_of_done");
  });

  it("catches missing UI evidence for web-ui target", () => {
    const errors = validateDoR({
      ...validInput,
      deliveryTarget: "web-ui",
      acText: "The system processes data correctly",
      scopeText: "Implement data processing",
    });
    expect(errors).toContain("dor_web_ui_missing_ui_evidence");
  });

  it("passes web-ui with UI evidence", () => {
    const errors = validateDoR({
      ...validInput,
      deliveryTarget: "web-ui",
      acText: "A tela de cadastro mostra os dados",
      scopeText: "Implementar a interface de cadastro",
    });
    expect(errors).not.toContain("dor_web_ui_missing_ui_evidence");
  });

  it("catches missing API evidence for api target", () => {
    const errors = validateDoR({
      ...validInput,
      deliveryTarget: "api",
      acText: "The system works",
      scopeText: "Implement the feature",
    });
    expect(errors).toContain("dor_api_missing_endpoint_evidence");
  });

  it("passes api with endpoint evidence", () => {
    const errors = validateDoR({
      ...validInput,
      deliveryTarget: "api",
      acText: "O endpoint retorna status 200",
      scopeText: "Implementar a rota de pagamentos",
    });
    expect(errors).not.toContain("dor_api_missing_endpoint_evidence");
  });

  it("catches missing evidence for hybrid target (both)", () => {
    const errors = validateDoR({
      ...validInput,
      deliveryTarget: "hybrid",
      acText: "The system works",
      scopeText: "Implement the feature",
    });
    expect(errors).toContain("dor_hybrid_missing_ui_evidence");
    expect(errors).toContain("dor_hybrid_missing_api_evidence");
  });

  it("catches auth requirements when auth signal present but no evidence", () => {
    const errors = validateDoR({
      ...validInput,
      rawIdea: "Criar sistema com login para usuários",
      objective: "Build a data viewer",  // no auth words in objective
      acText: "The system shows data",
      scopeText: "Implement data display",
      oosText: "No scope exclusions",
      authSignal: true,
    });
    expect(errors).toContain("dor_auth_requirements_missing");
  });

  it("passes when auth signal present with auth evidence", () => {
    const errors = validateDoR({
      ...validInput,
      rawIdea: "Sistema com login",
      objective: "Build with authentication",
      acText: "Usuarios autenticados conseguem fazer login",
      scopeText: "Implementar autenticação por perfil",
      authSignal: true,
    });
    expect(errors).not.toContain("dor_auth_requirements_missing");
  });

  it("catches auth moved to out-of-scope without ACs", () => {
    const errors = validateDoR({
      ...validInput,
      rawIdea: "Sistema com login",
      acText: "The system works fine",
      scopeText: "Basic features",
      oosText: "Autenticação e permissões ficam de fora",
      authSignal: true,
    });
    expect(errors).toContain("dor_auth_moved_to_out_of_scope_without_acceptance");
  });
});

describe("determineLevel", () => {
  it("small effort → junior", () => {
    expect(determineLevel("small", "To Do")).toBe("junior");
  });

  it("medium effort → medior", () => {
    expect(determineLevel("medium", "To Do")).toBe("medior");
  });

  it("large effort → senior", () => {
    expect(determineLevel("large", "To Do")).toBe("senior");
  });

  it("xlarge effort → senior", () => {
    expect(determineLevel("xlarge", "To Do")).toBe("senior");
  });

  it("research medior → junior (downgrade)", () => {
    expect(determineLevel("medium", "To Research")).toBe("junior");
  });
});

describe("runTriageLogic", () => {
  const input: TriageInput = {
    type: "feature",
    deliveryTarget: "cli",
    acCount: 3,
    scopeCount: 2,
    dodCount: 2,
    filesChanged: 3,
    totalRisks: 0,
    // Objective satisfies spec quality gate: >=20 words
    objective: "Build a CLI tool in Python that counts words in text files and displays the total count with filtering options",
    rawIdea: "Criar um programa para contar palavras",
    // acText: 3 items with action verbs (satisfies spec quality gate)
    acText: "deve aceitar arquivos de texto como entrada\nretorna a contagem total de palavras\nvalida que o arquivo existe antes de processar",
    // scopeText: 3 items, mentions "testes" (used as dod in runTriageLogic)
    scopeText: "Implementar contagem de palavras via comando\nAdicionarsuporte a multiplos arquivos\nCobertura de testes automatizados",
    oosText: "Sem interface gráfica",
    authSignal: false,
  };

  it("produces a complete triage decision", () => {
    const d = runTriageLogic(input, MATRIX);
    expect(d.priority).toBe("P2"); // feature small
    expect(d.effort).toBe("small");
    expect(d.effortLabel).toBe("effort:small");
    expect(d.typeLabel).toBe("type:feature");
    expect(d.targetState).toBe("To Do");
    expect(d.dispatchLabel).toBeNull();
    expect(d.level).toBe("junior");
    expect(d.readyForDispatch).toBe(true);
    expect(d.errors).toEqual([]);
  });

  it("marks not ready for dispatch when DoR fails", () => {
    const d = runTriageLogic({ ...input, objective: "" }, MATRIX);
    expect(d.readyForDispatch).toBe(false);
    expect(d.errors).toContain("dor_missing_objective");
  });

  it("research type goes to To Research", () => {
    const d = runTriageLogic({ ...input, type: "research" }, MATRIX);
    expect(d.targetState).toBe("To Research");
    expect(d.level).toBe("junior"); // medium downgrade for research
  });

  it("large bugfix with many risks → P0 senior", () => {
    const d = runTriageLogic({
      ...input,
      type: "bugfix",
      filesChanged: 15,
      acCount: 10,
      totalRisks: 5,
    }, MATRIX);
    expect(d.priority).toBe("P0");
    expect(d.effort).toBe("large");
    expect(d.level).toBe("senior");
  });
});
