import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PROMPT_PATH = join(__dirname, "../../defaults/fabrica/prompts/reviewer.md");

describe("reviewer prompt quality gate checklist", () => {
  let content: string;

  beforeAll(() => {
    content = readFileSync(PROMPT_PATH, "utf8");
  });

  it("contains mandatory quality gate heading", () => {
    expect(content).toContain("Quality Gate");
  });

  it("contains REJECT instruction for failing items", () => {
    expect(content).toContain("REJECT");
  });

  it("contains QA Evidence verification section", () => {
    expect(content).toContain("QA Evidence");
  });

  it("contains rejection rules for missing evidence", () => {
    expect(content).toContain("NEVER approve if QA Evidence is missing");
  });
});
