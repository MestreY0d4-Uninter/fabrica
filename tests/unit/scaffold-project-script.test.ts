import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { GenesisPayload } from "../../lib/intake/types.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

async function writeExecutable(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, content);
  await fs.chmod(filePath, 0o755);
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

describe.sequential("scaffold-project.sh", () => {
  it("honors the planned canonical repo_local path from metadata.repo_path", async () => {
    const homeDir = await makeTempDir("fabrica-scaffold-script-home-");
    const fakeBinDir = path.join(homeDir, "fake-bin");
    const remoteRoot = path.join(homeDir, "fake-gh");
    const canonicalRepoLocal = path.join(homeDir, "git", "MestreY0d4-Uninter", "shell-script-cli");
    const legacyRepoLocal = path.join(homeDir, "git", "shell-script-cli");
    const payloadPath = path.join(homeDir, "payload.json");
    const openClawDir = path.join(homeDir, ".openclaw");
    await fs.mkdir(fakeBinDir, { recursive: true });
    await fs.mkdir(openClawDir, { recursive: true });
    await writeFile(path.join(openClawDir, ".env"), "");

    const ghScript = `#!/usr/bin/env bash
set -euo pipefail

REMOTE_ROOT="\${FAKE_GH_ROOT:?missing FAKE_GH_ROOT}"
command="\${1:-}"
shift || true

case "$command" in
  api)
    if [[ "\${1:-}" == "user" && "\${2:-}" == "-q" && "\${3:-}" == ".login" ]]; then
      printf 'MestreY0d4-Uninter\\n'
      exit 0
    fi
    ;;
  repo)
    subcommand="\${1:-}"
    shift || true
    case "$subcommand" in
      view)
        target="\${1:-}"
        owner="\${target%%/*}"
        repo="\${target##*/}"
        [[ -d "$REMOTE_ROOT/$owner/$repo.git" ]] && exit 0
        exit 1
        ;;
      create)
        target="\${1:-}"
        owner="\${target%%/*}"
        repo="\${target##*/}"
        mkdir -p "$REMOTE_ROOT/$owner"
        git init --bare "$REMOTE_ROOT/$owner/$repo.git" >/dev/null 2>&1
        exit 0
        ;;
      clone)
        target="\${1:-}"
        destination="\${2:-}"
        owner="\${target%%/*}"
        repo="\${target##*/}"
        git clone "$REMOTE_ROOT/$owner/$repo.git" "$destination" >/dev/null 2>&1
        exit 0
        ;;
    esac
    ;;
esac

echo "unsupported fake gh invocation: gh $command $*" >&2
exit 1
`;
    await writeExecutable(path.join(fakeBinDir, "gh"), ghScript);

    const payload: GenesisPayload = {
      session_id: "sid-shell-script",
      timestamp: new Date().toISOString(),
      step: "impact",
      raw_idea: "Build a small Python CLI tool called shell-script-cli",
      answers: {},
      metadata: {
        source: "test",
        factory_change: false,
        repo_url: "https://github.com/MestreY0d4-Uninter/shell-script-cli",
        repo_path: canonicalRepoLocal,
        scaffold_plan: {
          version: 1,
          owner: "MestreY0d4-Uninter",
          repo_name: "shell-script-cli",
          repo_url: "https://github.com/MestreY0d4-Uninter/shell-script-cli",
          repo_local: canonicalRepoLocal,
          project_slug: "shell-script-cli",
          stack: "python-cli",
          objective: "Validate the canonical repo_local path",
          delivery_target: "cli",
          repo_target_source: "metadata.repo_url",
        },
      },
      spec: {
        title: "Shell Script CLI",
        type: "feature",
        objective: "Validate the canonical repo_local path",
        scope_v1: ["Create the CLI scaffold"],
        out_of_scope: [],
        acceptance_criteria: ["Scaffold writes into the planned repo path"],
        definition_of_done: ["Initial scaffold is pushed"],
        constraints: "Use Python",
        risks: [],
        delivery_target: "cli",
      },
      impact: {
        is_greenfield: true,
        affected_files: [],
        affected_modules: [],
        new_files_needed: ["src"],
        risk_areas: [],
        estimated_files_changed: 5,
        confidence: "high",
      },
    };
    await writeFile(payloadPath, JSON.stringify(payload));

    const scriptPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../genesis/scripts/scaffold-project.sh",
    );

    const { stdout } = await execFileAsync("bash", [scriptPath, payloadPath], {
      cwd: homeDir,
      env: {
        ...process.env,
        HOME: homeDir,
        PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
        FAKE_GH_ROOT: remoteRoot,
        GENESIS_STACK: "python-cli",
        GIT_AUTHOR_NAME: "Fabrica Test",
        GIT_AUTHOR_EMAIL: "fabrica@example.com",
        GIT_COMMITTER_NAME: "Fabrica Test",
        GIT_COMMITTER_EMAIL: "fabrica@example.com",
      },
      maxBuffer: 10 * 1024 * 1024,
    });

    const parsed = JSON.parse(stdout) as GenesisPayload;
    expect(parsed.scaffold).toEqual(expect.objectContaining({
      created: true,
      repo_local: canonicalRepoLocal,
      repo_url: "https://github.com/MestreY0d4-Uninter/shell-script-cli",
      project_slug: "shell-script-cli",
      stack: "python-cli",
    }));
    await expect(fs.access(path.join(canonicalRepoLocal, "pyproject.toml"))).resolves.toBeUndefined();
    await expect(fs.access(legacyRepoLocal)).rejects.toThrow();

    const qaScript = await fs.readFile(path.join(canonicalRepoLocal, "scripts", "qa.sh"), "utf-8");
    expect(qaScript).toContain("sanitize_public_output()");
    expect(qaScript).toContain("python -m pytest tests/ -v 2>&1 | sanitize_public_output");
  }, 120_000);
});
