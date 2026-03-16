import { describe, it, expect } from "vitest";
import { parseGenesisArgs } from "../../scripts/genesis-trigger-args.js";

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
