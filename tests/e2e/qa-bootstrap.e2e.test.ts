import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { generateQaContract } from "../../lib/quality/qa-contracts.js";
import type { Spec } from "../../lib/intake/types.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

const baseSpec: Spec = {
  title: "E2E bootstrap",
  type: "feature",
  objective: "Validate generated QA bootstrap end-to-end",
  scope_v1: ["Bootstrap local dependencies", "Run full QA locally"],
  out_of_scope: [],
  acceptance_criteria: ["QA script self-bootstraps", "Coverage remains enforced"],
  definition_of_done: ["QA passes"],
  constraints: "Project-local dependencies only",
  risks: [],
  delivery_target: "cli",
};

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

async function runQa(repoPath: string, env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("bash", ["scripts/qa.sh"], {
      cwd: repoPath,
      env,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error: any) {
    const stdout = error?.stdout ?? "";
    const stderr = error?.stderr ?? "";
    throw new Error(`qa.sh failed\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
  }
}

async function createNpmWrapper(binDir: string): Promise<void> {
  const { stdout } = await execFileAsync("bash", ["-lc", "command -v npm"]);
  const realNpm = stdout.trim();
  await writeExecutable(path.join(binDir, "npm"), `#!/usr/bin/env bash
set -euo pipefail
REAL_NPM=${JSON.stringify(realNpm)}
if [[ "\${1:-}" == "audit" ]]; then
  echo "mock npm audit (e2e)"
  exit 0
fi
exec "$REAL_NPM" "$@"
`);
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

describe.sequential("qa bootstrap e2e", () => {
  it("boots and runs a real Node QA contract inside the generated repo", async () => {
    const repoPath = await makeTempDir("fabrica-e2e-node-");
    const binDir = path.join(repoPath, "bin");
    await fs.mkdir(binDir, { recursive: true });
    await createNpmWrapper(binDir);

    await writeFile(path.join(repoPath, "package.json"), JSON.stringify({
      name: "fabrica-e2e-node",
      private: true,
      type: "module",
      scripts: {
        test: "vitest run",
      },
      devDependencies: {
        "@eslint/js": "^9.0.0",
        "@types/node": "^22.0.0",
        "@vitest/coverage-v8": "^3.0.0",
        eslint: "^9.0.0",
        globals: "^15.0.0",
        typescript: "^5.7.0",
        "typescript-eslint": "^8.0.0",
        vitest: "^3.0.0",
      },
    }, null, 2));
    await writeFile(path.join(repoPath, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        types: ["node"],
      },
      include: ["src"],
      exclude: ["tests"],
    }, null, 2));
    await writeFile(path.join(repoPath, "eslint.config.mjs"), `import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: { globals: { ...globals.node } },
    rules: { "no-console": "off" }
  }
);
`);
    await writeFile(path.join(repoPath, "src", "index.ts"), "export function sum(a: number, b: number): number { return a + b; }\n");
    await writeFile(path.join(repoPath, "tests", "sum.test.ts"), `import { describe, expect, it } from "vitest";
import { sum } from "../src/index.js";

describe("sum", () => {
  it("adds values", () => {
    expect(sum(2, 3)).toBe(5);
  });
});
`);

    await execFileAsync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: repoPath,
    });

    const qa = generateQaContract({ spec: baseSpec, stack: "express" });
    await writeExecutable(path.join(repoPath, "scripts", "qa.sh"), qa.script_content);

    const result = await runQa(repoPath, {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.stdout).toContain("QA contract PASSED");
    await expect(fs.access(path.join(repoPath, "node_modules"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(repoPath, ".fabrica", "test-env.sha256"))).resolves.toBeUndefined();
  }, 300_000);

  it("boots and runs a real Python QA contract inside the generated repo", async () => {
    const repoPath = await makeTempDir("fabrica-e2e-python-");
    const binDir = path.join(repoPath, "bin");
    await fs.mkdir(binDir, { recursive: true });
    await writeExecutable(path.join(binDir, "pip-audit"), `#!/usr/bin/env bash
set -euo pipefail
echo "mock pip-audit (e2e)"
exit 0
`);

    await writeFile(path.join(repoPath, "pyproject.toml"), `
[build-system]
requires = ["setuptools>=75.0.0"]
build-backend = "setuptools.build_meta"

[project]
name = "fabrica-e2e-python"
version = "0.1.0"
requires-python = ">=3.11"

[project.optional-dependencies]
dev = [
  "pytest>=8.0.0",
  "pytest-cov>=5.0.0",
  "ruff>=0.8.0",
  "mypy>=1.13.0",
]

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["."]

[tool.setuptools]
package-dir = {"" = "src"}

[tool.setuptools.packages.find]
where = ["src"]
`);
    await writeFile(path.join(repoPath, "src", "fabrica_e2e_python", "__init__.py"), "");
    await writeFile(path.join(repoPath, "src", "fabrica_e2e_python", "main.py"), `def greet(name: str) -> str:
    return f"hello {name}"
`);
    await writeFile(path.join(repoPath, "tests", "test_main.py"), `from src.fabrica_e2e_python.main import greet

def test_greet() -> None:
    assert greet("mateus") == "hello mateus"
`);

    const qa = generateQaContract({ spec: baseSpec, stack: "python-cli" });
    await writeExecutable(path.join(repoPath, "scripts", "qa.sh"), qa.script_content);

    const result = await runQa(repoPath, {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.stdout).toContain("QA contract PASSED");
    await expect(fs.access(path.join(repoPath, ".venv", "bin", "python"))).resolves.toBeUndefined();
  }, 300_000);
});
