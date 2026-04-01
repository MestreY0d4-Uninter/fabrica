import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEVELOPER_PROMPT_PATH = join(__dirname, "../../defaults/fabrica/prompts/developer.md");
const TESTER_PROMPT_PATH = join(__dirname, "../../defaults/fabrica/prompts/tester.md");
const ARCHITECT_PROMPT_PATH = join(__dirname, "../../defaults/fabrica/prompts/architect.md");

describe("developer prompt anti-pattern checklist", () => {
  let content: string;
  let testerContent: string;
  let architectContent: string;

  beforeAll(() => {
    content = readFileSync(DEVELOPER_PROMPT_PATH, "utf8");
    testerContent = readFileSync(TESTER_PROMPT_PATH, "utf8");
    architectContent = readFileSync(ARCHITECT_PROMPT_PATH, "utf8");
  });

  it("contains anti-pattern checklist heading", () => {
    expect(content).toContain("Anti-Pattern Checklist");
  });

  it("contains canonical final result lines instead of mandatory work_finish instructions", () => {
    expect(content).toContain("Work result: DONE");
    expect(content).toContain("Work result: BLOCKED");
    expect(content).not.toContain("Always call work_finish");
  });

  it("contains QA Contract section requiring all 5 gates", () => {
    expect(content).toContain("qa.sh");
    expect(content).toContain("lint");
    expect(content).toContain("coverage");
  });

  it("contains QA Evidence PR body instruction", () => {
    expect(content).toContain("QA Evidence");
  });

  it("keeps tester and architect prompts aligned to canonical lifecycle result lines", () => {
    expect(testerContent).toContain("Test result: PASS");
    expect(testerContent).toContain("Test result: FAIL_INFRA");
    expect(testerContent).toContain("Test result: BLOCKED");
    expect(testerContent).not.toContain("Test result: REFINE");
    expect(testerContent).not.toContain("work_finish");

    expect(architectContent).toContain("Architecture result: DONE");
    expect(architectContent).toContain("Architecture result: BLOCKED");
    expect(architectContent).not.toContain("work_finish");
  });
});
