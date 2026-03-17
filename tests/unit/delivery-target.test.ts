/**
 * Tests for delivery target detection and normalization.
 */
import { describe, it, expect } from "vitest";
import {
  normalizeDeliveryTarget,
  detectDeliveryTargetFromText,
  crossValidateDeliveryTarget,
} from "../../lib/intake/lib/delivery-target.js";

describe("normalizeDeliveryTarget", () => {
  it("normalizes web variants", () => {
    expect(normalizeDeliveryTarget("web")).toBe("web-ui");
    expect(normalizeDeliveryTarget("web-ui")).toBe("web-ui");
    expect(normalizeDeliveryTarget("webui")).toBe("web-ui");
    expect(normalizeDeliveryTarget("frontend")).toBe("web-ui");
    expect(normalizeDeliveryTarget("front-end")).toBe("web-ui");
    expect(normalizeDeliveryTarget("ui")).toBe("web-ui");
    expect(normalizeDeliveryTarget("site")).toBe("web-ui");
    expect(normalizeDeliveryTarget("pwa")).toBe("web-ui");
  });

  it("normalizes api variants", () => {
    expect(normalizeDeliveryTarget("api")).toBe("api");
    expect(normalizeDeliveryTarget("backend")).toBe("api");
    expect(normalizeDeliveryTarget("rest")).toBe("api");
    expect(normalizeDeliveryTarget("graphql")).toBe("api");
    expect(normalizeDeliveryTarget("webhook")).toBe("api");
  });

  it("normalizes cli variants", () => {
    expect(normalizeDeliveryTarget("cli")).toBe("cli");
    expect(normalizeDeliveryTarget("terminal")).toBe("cli");
    expect(normalizeDeliveryTarget("console")).toBe("cli");
    expect(normalizeDeliveryTarget("command-line")).toBe("cli");
    expect(normalizeDeliveryTarget("linha-de-comando")).toBe("cli");
  });

  it("normalizes hybrid variants", () => {
    expect(normalizeDeliveryTarget("hybrid")).toBe("hybrid");
    expect(normalizeDeliveryTarget("fullstack")).toBe("hybrid");
    expect(normalizeDeliveryTarget("full-stack")).toBe("hybrid");
  });

  it("returns unknown for unrecognized input", () => {
    expect(normalizeDeliveryTarget("foobar")).toBe("unknown");
    expect(normalizeDeliveryTarget("mobile")).toBe("unknown");
    expect(normalizeDeliveryTarget("")).toBe("unknown");
  });

  it("is case-insensitive", () => {
    expect(normalizeDeliveryTarget("API")).toBe("api");
    expect(normalizeDeliveryTarget("Frontend")).toBe("web-ui");
    expect(normalizeDeliveryTarget("CLI")).toBe("cli");
  });
});

describe("detectDeliveryTargetFromText", () => {
  it("detects web-ui patterns", () => {
    expect(detectDeliveryTargetFromText("Criar uma tela de cadastro")).toBe("web-ui");
    expect(detectDeliveryTargetFromText("Build a dashboard for metrics")).toBe("web-ui");
    expect(detectDeliveryTargetFromText("Create a website landing page")).toBe("web-ui");
    expect(detectDeliveryTargetFromText("Página de login do usuário")).toBe("web-ui");
  });

  it("detects api patterns", () => {
    expect(detectDeliveryTargetFromText("Build a REST API for users")).toBe("api");
    expect(detectDeliveryTargetFromText("Create endpoint for payments")).toBe("api");
    expect(detectDeliveryTargetFromText("Serviço de autenticação")).toBe("api");
  });

  it("detects cli patterns", () => {
    expect(detectDeliveryTargetFromText("Criar um CLI para contar palavras")).toBe("cli");
    expect(detectDeliveryTargetFromText("Build a command line tool")).toBe("cli");
    expect(detectDeliveryTargetFromText("Fazer um programa que calcula IMC")).toBe("cli");
    expect(detectDeliveryTargetFromText("Ferramenta para converter temperaturas")).toBe("cli");
  });

  it("detects hybrid when multiple signals present", () => {
    expect(detectDeliveryTargetFromText("Build a web app with a REST API")).toBe("hybrid");
    expect(detectDeliveryTargetFromText("Criar uma tela de login e endpoint de autenticação")).toBe("hybrid");
  });

  it("keeps explicit CLI ideas as cli when web/api mentions are optional roadmap items", () => {
    const prompt = `
Stack CLI para ambientes reproduzíveis

Objetivo do MVP:
- Criar uma ferramenta de linha de comando com subcomandos stack init, stack add e stack shell

Roadmap futuro/opcional:
- Interface web opcional para visualizar ambientes
- API opcional para integrações externas
`;
    expect(detectDeliveryTargetFromText(prompt)).toBe("cli");
  });

  it("does not treat generic 'interface de usuário' wording in a CLI prompt as web-ui", () => {
    expect(
      detectDeliveryTargetFromText("Criar uma interface de usuário para o CLI stack, com subcomandos e help"),
    ).toBe("cli");
  });

  it("returns unknown when no signals", () => {
    expect(detectDeliveryTargetFromText("Make it better")).toBe("unknown");
    expect(detectDeliveryTargetFromText("")).toBe("unknown");
  });
});

describe("crossValidateDeliveryTarget", () => {
  it("text wins on conflict", () => {
    expect(crossValidateDeliveryTarget("api", "Criar uma tela de cadastro")).toBe("web-ui");
  });

  it("text fills unknown spec target", () => {
    expect(crossValidateDeliveryTarget("unknown", "Build a CLI tool")).toBe("cli");
  });

  it("preserves spec target when text is unknown", () => {
    expect(crossValidateDeliveryTarget("api", "Make it better")).toBe("api");
  });

  it("preserves spec target when text agrees", () => {
    expect(crossValidateDeliveryTarget("cli", "Create a command line tool")).toBe("cli");
  });

  it("preserves unknown when both are unknown", () => {
    expect(crossValidateDeliveryTarget("unknown", "something vague")).toBe("unknown");
  });
});
