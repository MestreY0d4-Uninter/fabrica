import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGenesisTool } from "../../lib/tools/admin/genesis.js";
import {
  loadGenesisSession,
  normalizeGenesisRequest,
} from "../../lib/tools/admin/genesis-session.js";
import type { GenesisPayload } from "../../lib/intake/index.js";

function makePluginContext() {
  return {
    runCommand: vi.fn(async (argv: string[]) => {
      const joined = argv.join(" ");
      if (joined.includes("Classify this software project idea")) {
        return {
          stdout: JSON.stringify({
            payloads: [{ text: '{"type":"feature","confidence":0.91,"reasoning":"Feature request"}' }],
          }),
          stderr: "",
          code: 0,
        };
      }
      if (joined.includes("software specification expert")) {
        return {
          stdout: JSON.stringify({
            payloads: [{
              text: JSON.stringify({
                title: "Stack CLI",
                objective: "Create a reproducible development environment CLI",
                scope_v1: ["stack init", "stack shell"],
                out_of_scope: ["Full web console"],
                acceptance_criteria: ["CLI initializes and opens a reproducible shell"],
                definition_of_done: ["Code reviewed and merged", "Tests pass", "QA contract passes"],
                constraints: "Use Go with Nix",
                risks: ["Nix bootstrap variance"],
              }),
            }],
          }),
          stderr: "",
          code: 0,
        };
      }
      return { stdout: "", stderr: "", code: 0 };
    }),
    runtime: {} as never,
    pluginConfig: {},
    config: {} as never,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as never,
  };
}

function makeStoredPayload(): GenesisPayload {
  return {
    session_id: "stored-session",
    timestamp: "2026-03-13T10:00:00.000Z",
    step: "spec",
    raw_idea: "Build a stack cli",
    answers: { f1: "setup", f2: "developers", f3: "run commands" },
    metadata: {
      source: "test",
      repo_url: "https://github.com/acme/stack-cli.git",
      project_name: "stack-cli",
      stack_hint: "go",
      command: "discover",
      timeout_ms: 45000,
      answers_json: { f1: "setup" },
      factory_change: true,
    },
    spec: {
      title: "Stack CLI",
      type: "feature",
      objective: "Build a stack cli",
      scope_v1: ["stack init"],
      out_of_scope: ["UI"],
      acceptance_criteria: ["CLI works"],
      definition_of_done: ["Tests pass"],
      constraints: "Use Go",
      risks: [],
      delivery_target: "cli",
    },
  };
}

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("normalizeGenesisRequest", () => {
  it("accepts legacy-compatible inputs and merges answers_json with direct answers", () => {
    const normalized = normalizeGenesisRequest(
      {
        phase: "discover",
        command: "legacy genesis prompt",
        repo_url: "https://github.com/acme/stack-cli.git",
        factory_change: "true",
        stack: "go",
        timeout_ms: "120000",
        answers_json: '{"f1":"problem","f3":{"steps":["init","shell"]}}',
        answers: { f2: "developers", extra: 7 },
      },
      makeStoredPayload(),
    );

    expect(normalized.phase).toBe("discover");
    expect(normalized.rawIdea).toBe("legacy genesis prompt");
    expect(normalized.metadata.repo_url).toBe("https://github.com/acme/stack-cli.git");
    expect(normalized.metadata.project_name).toBe("stack-cli");
    expect(normalized.metadata.stack_hint).toBe("go");
    expect(normalized.metadata.timeout_ms).toBe(120000);
    expect(normalized.metadata.factory_change).toBe(true);
    expect(normalized.answers.f1).toBe("problem");
    expect(normalized.answers.f2).toBe("developers");
    expect(normalized.answers.f3).toContain("init");
    expect(normalized.answers.extra).toBe("7");
  });
});

describe("genesis tool", () => {
  it("persists normalized discover metadata and validates commit_token against the stored session", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-genesis-tool-"));
    tempDirs.push(workspaceDir);
    const tool = createGenesisTool(makePluginContext())({ workspaceDir });

    const discover = await tool.execute("1", {
      phase: "discover",
      idea: "Build a stack cli with reproducible development environments",
      repo_url: "https://github.com/acme/stack-cli.git",
      stack: "go",
      timeout_ms: 90000,
      factory_change: false,
      answers_json: {
        f1: "Avoid environment drift",
        f2: "Developers",
        f3: ["stack init", "stack shell", "stack run"],
      },
      dry_run: true,
    });

    expect(discover.details.status).toBe("ready");
    expect(discover.details.commit_token).toMatch(/^g1\./);
    expect(discover.details.normalized_inputs.repo_url).toBe("https://github.com/acme/stack-cli.git");
    expect(discover.details.normalized_inputs.stack_hint).toBe("go");
    expect(discover.details.normalized_inputs.timeout_ms).toBe(90000);

    const stored = loadGenesisSession(workspaceDir, discover.details.session_id);
    expect(stored?.metadata.genesis_contract?.discover_complete).toBe(true);
    expect(stored?.metadata.answers_json?.f2).toBe("Developers");

    const commit = await tool.execute("2", {
      phase: "commit",
      session_id: discover.details.session_id,
      commit_token: discover.details.commit_token,
      dry_run: true,
    });

    expect(commit.details.success).toBe(true);
    expect(commit.details.session_id).toBe(discover.details.session_id);

    const sessionPath = path.join(workspaceDir, "genesis-sessions", `${discover.details.session_id}.json`);
    const raw = JSON.parse(await fs.readFile(sessionPath, "utf-8")) as GenesisPayload;
    raw.raw_idea = "tampered payload";
    await fs.writeFile(sessionPath, JSON.stringify(raw, null, 2), "utf-8");

    const tampered = await tool.execute("3", {
      phase: "commit",
      session_id: discover.details.session_id,
      commit_token: discover.details.commit_token,
      dry_run: true,
    });

    expect(tampered.details.error).toContain("modified");
  });
});
