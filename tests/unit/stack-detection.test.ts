/**
 * Tests for stack detection and normalization.
 */
import { describe, it, expect } from "vitest";
import {
  normalizeStackHint,
  detectStackFromText,
  detectStackFromDeliveryTarget,
  getStackFlags,
} from "../../lib/intake/lib/stack-detection.js";

describe("normalizeStackHint", () => {
  it("normalizes nextjs variants", () => {
    expect(normalizeStackHint("nextjs")).toBe("nextjs");
    expect(normalizeStackHint("next.js")).toBe("nextjs");
    expect(normalizeStackHint("next")).toBe("nextjs");
    expect(normalizeStackHint("Next-JS")).toBe("nextjs");
  });

  it("normalizes express variants", () => {
    expect(normalizeStackHint("express")).toBe("express");
    expect(normalizeStackHint("express.js")).toBe("express");
  });

  it("normalizes node-cli variants", () => {
    expect(normalizeStackHint("node-cli")).toBe("node-cli");
    expect(normalizeStackHint("node cli")).toBe("node-cli");
    expect(normalizeStackHint("typescript-cli")).toBe("node-cli");
    expect(normalizeStackHint("ts cli")).toBe("node-cli");
  });

  it("normalizes python stacks", () => {
    expect(normalizeStackHint("fastapi")).toBe("fastapi");
    expect(normalizeStackHint("fast-api")).toBe("fastapi");
    expect(normalizeStackHint("flask")).toBe("flask");
    expect(normalizeStackHint("django")).toBe("django");
    expect(normalizeStackHint("python-cli")).toBe("python-cli");
    expect(normalizeStackHint("python_cli")).toBe("python-cli");
    expect(normalizeStackHint("pycli")).toBe("python-cli");
  });

  it("normalizes go and java", () => {
    expect(normalizeStackHint("go")).toBe("go");
    expect(normalizeStackHint("golang")).toBe("go");
    expect(normalizeStackHint("java")).toBe("java");
    expect(normalizeStackHint("spring")).toBe("java");
    expect(normalizeStackHint("spring-boot")).toBe("java");
  });

  it("returns empty for unknown", () => {
    expect(normalizeStackHint("rust")).toBe("");
    expect(normalizeStackHint("")).toBe("");
  });
});

describe("detectStackFromText", () => {
  it("detects nextjs", () => {
    expect(detectStackFromText("Build with Next.js and React")).toBe("nextjs");
    expect(detectStackFromText("Use NextJS for the frontend")).toBe("nextjs");
  });

  it("detects express", () => {
    expect(detectStackFromText("Express.js API server")).toBe("express");
    expect(detectStackFromText("Node.js API with routes")).toBe("express");
  });

  it("detects node-cli before express/python-cli fallbacks", () => {
    expect(detectStackFromText("TypeScript CLI with commander and subcommands")).toBe("node-cli");
    expect(detectStackFromText("Build a node cli for terminal usage")).toBe("node-cli");
    expect(detectStackFromText("JavaScript command line tool with yargs")).toBe("node-cli");
  });

  it("detects fastapi", () => {
    expect(detectStackFromText("Build FastAPI backend")).toBe("fastapi");
    expect(detectStackFromText("Use uvicorn to serve")).toBe("fastapi");
  });

  it("detects flask and django", () => {
    expect(detectStackFromText("Flask web application")).toBe("flask");
    expect(detectStackFromText("Django REST framework")).toBe("django");
  });

  it("detects python-cli", () => {
    expect(detectStackFromText("Python CLI with argparse")).toBe("python-cli");
    expect(detectStackFromText("CLI python tool using click")).toBe("python-cli");
  });

  it("detects go", () => {
    expect(detectStackFromText("Golang API service")).toBe("go");
    expect(detectStackFromText("Use gin framework")).toBe("go");
    expect(detectStackFromText("Build with fiber")).toBe("go");
    expect(detectStackFromText("Build a command line tool in Go with subcommands")).toBe("go");
  });

  it("detects java", () => {
    expect(detectStackFromText("Spring Boot application")).toBe("java");
    expect(detectStackFromText("Java backend with maven")).toBe("java");
  });

  it("returns empty for undetectable text", () => {
    expect(detectStackFromText("Build something cool")).toBe("");
    expect(detectStackFromText("")).toBe("");
  });

  it("returns first match when multiple stacks in text", () => {
    // nextjs pattern comes before express in the array
    const result = detectStackFromText("NextJS frontend with Express backend");
    expect(result).toBe("nextjs");
  });
});

describe("detectStackFromDeliveryTarget", () => {
  it("maps delivery targets to default stacks", () => {
    expect(detectStackFromDeliveryTarget("web-ui")).toBe("nextjs");
    expect(detectStackFromDeliveryTarget("api")).toBe("fastapi");
    expect(detectStackFromDeliveryTarget("cli")).toBe("python-cli");
    expect(detectStackFromDeliveryTarget("hybrid")).toBe("nextjs");
  });

  it("prefers explicit language hints over optional api/web roadmap wording", () => {
    const prompt = `
Stack CLI para ambientes reproduzíveis

Tecnologias sugeridas:
- Linguagem de implementação: Rust ou Go

Objetivo do MVP:
- ferramenta de linha de comando com stack init, stack add, stack shell e stack run

Roadmap opcional:
- interface web
- api para integrações
`;
    expect(detectStackFromText(prompt)).toBe("go");
  });

  it("falls back to fastapi for unknown", () => {
    expect(detectStackFromDeliveryTarget("unknown")).toBe("fastapi");
  });
});

describe("getStackFlags", () => {
  it("flags JS stacks correctly", () => {
    expect(getStackFlags("nextjs")).toEqual({ IS_PY: false, IS_JS: true, IS_GO: false });
    expect(getStackFlags("node-cli")).toEqual({ IS_PY: false, IS_JS: true, IS_GO: false });
    expect(getStackFlags("express")).toEqual({ IS_PY: false, IS_JS: true, IS_GO: false });
  });

  it("flags Python stacks correctly", () => {
    expect(getStackFlags("fastapi")).toEqual({ IS_PY: true, IS_JS: false, IS_GO: false });
    expect(getStackFlags("flask")).toEqual({ IS_PY: true, IS_JS: false, IS_GO: false });
    expect(getStackFlags("django")).toEqual({ IS_PY: true, IS_JS: false, IS_GO: false });
    expect(getStackFlags("python-cli")).toEqual({ IS_PY: true, IS_JS: false, IS_GO: false });
  });

  it("flags Go stack correctly", () => {
    expect(getStackFlags("go")).toEqual({ IS_PY: false, IS_JS: false, IS_GO: true });
  });

  it("flags Java as none (no specific language flag)", () => {
    expect(getStackFlags("java")).toEqual({ IS_PY: false, IS_JS: false, IS_GO: false });
  });
});
