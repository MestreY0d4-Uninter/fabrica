import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PROMPT_PATH = join(__dirname, "../../defaults/fabrica/prompts/developer.md");

describe("developer prompt anti-pattern checklist", () => {
  let content: string;

  beforeAll(() => {
    content = readFileSync(PROMPT_PATH, "utf8");
  });

  it("contains anti-pattern checklist heading", () => {
    expect(content).toContain("Anti-Pattern Checklist");
  });

  it("contains mandatory work_finish instruction", () => {
    expect(content).toContain("work_finish");
  });

  it("contains QA Contract section requiring all 5 gates", () => {
    expect(content).toContain("qa.sh");
    expect(content).toContain("lint");
    expect(content).toContain("coverage");
  });

  it("contains QA Evidence PR body instruction", () => {
    expect(content).toContain("QA Evidence");
  });
});
