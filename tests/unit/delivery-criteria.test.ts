/**
 * Tests for stack-specific delivery criteria.
 */
import { describe, it, expect } from "vitest";
import { getDeliveryCriteria, listSupportedStacks } from "../../lib/quality/delivery-criteria.js";

describe("getDeliveryCriteria", () => {
  it("returns Python criteria for python-cli", () => {
    const dc = getDeliveryCriteria("python-cli");
    expect(dc.stack).toBe("python-cli");
    expect(dc.coverageThreshold).toBe(80);
    expect(dc.criteria.some(c => c.command.includes("ruff"))).toBe(true);
    expect(dc.criteria.some(c => c.command.includes("mypy"))).toBe(true);
    expect(dc.criteria.some(c => c.command.includes("pytest"))).toBe(true);
    expect(dc.criteria.some(c => c.command.includes("pip-audit"))).toBe(true);
  });

  it("returns Python criteria for fastapi/flask/django", () => {
    for (const stack of ["fastapi", "flask", "django"] as const) {
      const dc = getDeliveryCriteria(stack);
      expect(dc.criteria.some(c => c.command.includes("ruff"))).toBe(true);
    }
  });

  it("returns JS criteria for nextjs/node-cli/express", () => {
    const nextjs = getDeliveryCriteria("nextjs");
    expect(nextjs.criteria.some(c => c.command.includes("next lint"))).toBe(true);
    expect(nextjs.criteria.some(c => c.command.includes("tsc"))).toBe(true);
    expect(nextjs.criteria.some(c => c.command.includes("npm audit"))).toBe(true);

    const nodeCli = getDeliveryCriteria("node-cli");
    expect(nodeCli.criteria.some(c => c.command.includes("npm run lint"))).toBe(true);
    expect(nodeCli.criteria.some(c => c.command.includes("npm run typecheck"))).toBe(true);
    expect(nodeCli.criteria.some(c => c.command.includes("npm audit"))).toBe(true);

    const express = getDeliveryCriteria("express");
    expect(express.criteria.some(c => c.command.includes("eslint"))).toBe(true);
    expect(express.criteria.some(c => c.command.includes("tsc"))).toBe(true);
    expect(express.criteria.some(c => c.command.includes("npm audit"))).toBe(true);
  });

  it("returns Go criteria for go", () => {
    const dc = getDeliveryCriteria("go");
    expect(dc.criteria.some(c => c.command.includes("go vet"))).toBe(true);
    expect(dc.criteria.some(c => c.command.includes("govulncheck"))).toBe(true);
  });

  it("returns Java criteria for java", () => {
    const dc = getDeliveryCriteria("java");
    expect(dc.criteria.some(c => c.command.includes("mvn"))).toBe(true);
    expect(dc.criteria.some(c => c.command.includes("checkstyle"))).toBe(true);
  });

  it("all criteria are required", () => {
    const dc = getDeliveryCriteria("python-cli");
    expect(dc.criteria.every(c => c.required)).toBe(true);
  });

  it("all criteria have name, command, description", () => {
    for (const stack of ["python-cli", "nextjs", "node-cli", "go", "java"] as const) {
      const dc = getDeliveryCriteria(stack);
      for (const c of dc.criteria) {
        expect(c.name).toBeTruthy();
        expect(c.command).toBeTruthy();
        expect(c.description).toBeTruthy();
      }
    }
  });
});

describe("listSupportedStacks", () => {
  it("lists 9 stacks", () => {
    const stacks = listSupportedStacks();
    expect(stacks).toHaveLength(9);
  });

  it("each stack has criteria count > 0", () => {
    for (const s of listSupportedStacks()) {
      expect(s.criteriaCount).toBeGreaterThan(0);
    }
  });
});
