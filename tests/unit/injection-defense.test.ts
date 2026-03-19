import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("GraphQL injection defense", () => {
  it("does not interpolate owner/name into GraphQL string", () => {
    const source = readFileSync(resolve(__dirname, "../../lib/providers/github.ts"), "utf-8");
    // Should NOT contain literal "${repo.owner}" or "${repo.name}" in GraphQL context
    expect(source).not.toMatch(/repository\(owner:\s*"\$\{repo\.owner\}"/);
    expect(source).not.toMatch(/repository\(owner:\s*'\$\{repo\.owner\}'/);
  });
});

describe("--field body injection defense", () => {
  it("github.ts uses -f (raw-field) for body parameters", () => {
    const source = readFileSync(resolve(__dirname, "../../lib/providers/github.ts"), "utf-8");
    // Should NOT have: "--field", `body=` or "-F", `body=`  in comment methods
    // Note: -F is acceptable for non-user-content fields (owner, repo, numbers)
    // But NOT for body/content which may contain user/agent-generated text
    expect(source).not.toMatch(/"--field",\s*`body=/);
    expect(source).not.toMatch(/"-F",\s*`body=/);
  });

  it("gitlab.ts uses -f (raw-field) for body parameters", () => {
    const source = readFileSync(resolve(__dirname, "../../lib/providers/gitlab.ts"), "utf-8");
    expect(source).not.toMatch(/"--field",\s*`body=/);
    expect(source).not.toMatch(/"-F",\s*`body=/);
  });
});
