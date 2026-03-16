import { describe, it, expect } from "vitest";
import { parseGenesisArgs, loadAnswersFromFile } from "../../scripts/genesis-trigger-args.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("parseGenesisArgs", () => {
  it("extracts raw idea from positional args", () => {
    const result = parseGenesisArgs(["build", "a", "CLI"]);
    expect(result.rawIdea).toBe("build a CLI");
  });

  it("returns error when raw idea is empty", () => {
    const result = parseGenesisArgs([]);
    expect(result.error).toBe("Raw idea is required");
  });

  it("extracts --stack with value", () => {
    const result = parseGenesisArgs(["idea", "--stack", "python-cli"]);
    expect(result.stackHint).toBe("python-cli");
  });

  it("returns error when --stack is last arg (no value)", () => {
    const result = parseGenesisArgs(["idea", "--stack"]);
    expect(result.error).toBe("--stack requires a value");
  });

  it("returns error when --name is last arg (no value)", () => {
    const result = parseGenesisArgs(["idea", "--name"]);
    expect(result.error).toBe("--name requires a value");
  });

  it("returns error when --channel-id value is not a valid number", () => {
    const result = parseGenesisArgs(["idea", "--channel-id", "abc"]);
    expect(result.error).toBe("--channel-id must be a numeric value");
  });

  it("returns error when --channel-id is last arg (no value)", () => {
    const result = parseGenesisArgs(["idea", "--channel-id"]);
    expect(result.error).toBe("--channel-id requires a value");
  });

  it("uses FABRICA_PROJECTS_CHANNEL_ID env var as default channel", () => {
    process.env.FABRICA_PROJECTS_CHANNEL_ID = "-100999";
    const result = parseGenesisArgs(["idea"]);
    expect(result.channelId).toBe("-100999");
    delete process.env.FABRICA_PROJECTS_CHANNEL_ID;
  });

  it("falls back to hardcoded channel ID when env var is not set", () => {
    delete process.env.FABRICA_PROJECTS_CHANNEL_ID;
    const result = parseGenesisArgs(["idea"]);
    expect(result.channelId).toBe("-1003709213169");
  });
});

describe("loadAnswersFromFile", () => {
  it("returns empty object when no path provided", () => {
    const result = loadAnswersFromFile(undefined);
    expect(result).toEqual({});
  });

  it("loads answers from JSON file path", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "gt-answers-"));
    const tmpPath = join(tmpDir, "answers.json");
    writeFileSync(tmpPath, JSON.stringify({ f1: "answer1", f2: "answer2" }));
    try {
      const result = loadAnswersFromFile(tmpPath);
      expect(result).toEqual({ f1: "answer1", f2: "answer2" });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns empty object with warning when file does not exist", () => {
    const result = loadAnswersFromFile("/nonexistent/answers.json");
    expect(result).toEqual({});
  });
});
