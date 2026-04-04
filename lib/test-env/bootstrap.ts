import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { CanonicalStack } from "../intake/types.js";

export type QaGateCommands = {
  lint: string;
  types: string;
  security: string;
  tests: string;
  coverage: string;
};

export type BootstrapMode = "scaffold" | "qa" | "developer" | "tester" | "e2e";

export type TestEnvironmentFamily = "node" | "python" | "go" | "java";

export type BootstrapCommand = {
  cmd: string;
  args: string[];
  reason: string;
  env?: Record<string, string | undefined>;
};

export type BootstrapResult = {
  ready: boolean;
  skipped: boolean;
  stack: CanonicalStack;
  family: TestEnvironmentFamily;
  toolchain: string;
  packageManager: string;
  lockfile: string | null;
  environmentPath: string | null;
  commandsRun: BootstrapCommand[];
  fingerprint: string | null;
  reason?: string;
};

type RunCommand = (
  cmd: string,
  args: string[],
  opts?: { timeout?: number; cwd?: string; env?: Record<string, string | undefined> },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

type NodeManager = "npm" | "pnpm" | "bun" | "yarn";
type PythonManager = "uv" | "pip";

const NODE_STACKS = new Set<CanonicalStack>(["nextjs", "node-cli", "express"]);
const PYTHON_STACKS = new Set<CanonicalStack>(["fastapi", "flask", "django", "python-cli"]);
const GREENFIELD_SCAFFOLD_STACKS = new Set<CanonicalStack>([
  "nextjs",
  "node-cli",
  "express",
  "fastapi",
  "flask",
  "django",
  "python-cli",
]);

const NEXTJS_GATES: QaGateCommands = {
  lint: "next lint",
  types: "tsc --noEmit",
  security: "npm audit --audit-level=moderate",
  tests: "npm test",
  coverage: "vitest run --coverage --coverage.thresholds.lines=80",
};

const EXPRESS_GATES: QaGateCommands = {
  lint: "eslint .",
  types: "tsc --noEmit",
  security: "npm audit --audit-level=moderate",
  tests: "npm test",
  coverage: "vitest run --coverage --coverage.thresholds.lines=80",
};

const NODE_CLI_GATES: QaGateCommands = {
  lint: "npm run lint",
  types: "npm run build -- --noEmit",
  security: "npm audit --audit-level=moderate",
  tests: "npm test",
  coverage: "npm run coverage",
};

const PYTHON_APP_GATES: QaGateCommands = {
  lint: "ruff check app/ tests/",
  types: "mypy app/ --ignore-missing-imports",
  security: "pip-audit",
  tests: "python -m pytest tests/ -v --tb=short",
  coverage: "python -m pytest tests/ --cov=app --cov-fail-under=80",
};

const PYTHON_CLI_GATES: QaGateCommands = {
  lint: "ruff check src/ tests/",
  types: "mypy src/ --ignore-missing-imports",
  security: "pip-audit",
  tests: "python -m pytest tests/ -v --tb=short",
  coverage: "python -m pytest tests/ --cov=src --cov-fail-under=80",
};

const GO_GATES: QaGateCommands = {
  lint: "go vet ./...",
  types: "go build ./...",
  security: "govulncheck ./...",
  tests: "go test -v ./...",
  coverage: "go test -coverprofile=coverage.out ./... && go tool cover -func=coverage.out",
};

const JAVA_GATES: QaGateCommands = {
  lint: "mvn checkstyle:check",
  types: "mvn compile",
  security: "mvn org.owasp:dependency-check-maven:check",
  tests: "mvn test",
  coverage: "mvn test jacoco:report",
};

const BOOTSTRAP_STATE_DIR = ".fabrica";
const BOOTSTRAP_STATE_FILE = "test-env.sha256";
const DEFAULT_TIMEOUT = 180_000;

function fileName(refPath: string): string {
  return path.basename(refPath);
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

/** Check if a file exists AND has non-zero size (catches 0-byte corrupt binaries). */
export async function isValidBinary(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.size > 0;
  } catch {
    return false;
  }
}

export function familyForStack(stack: CanonicalStack): TestEnvironmentFamily {
  if (NODE_STACKS.has(stack)) return "node";
  if (PYTHON_STACKS.has(stack)) return "python";
  if (stack === "go") return "go";
  return "java";
}

export function supportsGreenfieldScaffold(stack: CanonicalStack): boolean {
  return GREENFIELD_SCAFFOLD_STACKS.has(stack);
}

export function getSupportedGreenfieldStacks(): CanonicalStack[] {
  return [...GREENFIELD_SCAFFOLD_STACKS];
}

export function getQaGateCommands(stack: CanonicalStack): QaGateCommands {
  if (stack === "nextjs") return NEXTJS_GATES;
  if (stack === "node-cli") return NODE_CLI_GATES;
  if (stack === "express") return EXPRESS_GATES;
  if (stack === "python-cli") return PYTHON_CLI_GATES;
  if (PYTHON_STACKS.has(stack)) return PYTHON_APP_GATES;
  if (stack === "go") return GO_GATES;
  return JAVA_GATES;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function buildCommonScriptPrelude(): string {
  return [
    'ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"',
    'cd "$ROOT_DIR"',
    "",
    `mkdir -p "${BOOTSTRAP_STATE_DIR}"`,
    `STATE_FILE="$ROOT_DIR/${BOOTSTRAP_STATE_DIR}/${BOOTSTRAP_STATE_FILE}"`,
    "",
    "hash_files() {",
    "  if command -v sha256sum >/dev/null 2>&1; then",
    "    sha256sum \"$@\" | awk '{print $1}' | tr '\\n' ' ' | sha256sum | awk '{print $1}'",
    "  elif command -v shasum >/dev/null 2>&1; then",
    "    shasum -a 256 \"$@\" | awk '{print $1}' | tr '\\n' ' ' | shasum -a 256 | awk '{print $1}'",
    "  else",
    '    echo "Missing sha256sum/shasum for deterministic QA bootstrap" >&2',
    "    exit 2",
    "  fi",
    "}",
    "",
    "require_cmd() {",
    '  local cmd="$1"',
    '  local hint="$2"',
    '  if ! command -v "$cmd" >/dev/null 2>&1; then',
    '    echo "$hint" >&2',
    "    exit 2",
    "  fi",
    "}",
  ].join("\n");
}

function buildNodeBootstrapPrelude(): string {
  return `${buildCommonScriptPrelude()}
NODE_FILES=()
for candidate in package.json bun.lock pnpm-lock.yaml yarn.lock package-lock.json; do
  if [[ -f "$candidate" ]]; then
    NODE_FILES+=("$candidate")
  fi
done

if [[ ! -f package.json ]]; then
  echo "Missing package.json for Node QA bootstrap" >&2
  exit 2
fi

if [[ \${#NODE_FILES[@]} -eq 0 ]]; then
  echo "Missing lockfile for deterministic Node QA bootstrap" >&2
  exit 2
fi

BOOTSTRAP_FINGERPRINT="$(hash_files "\${NODE_FILES[@]}")"
if [[ -d node_modules && -f "$STATE_FILE" ]] && [[ "$(cat "$STATE_FILE")" == "$BOOTSTRAP_FINGERPRINT" ]]; then
  echo "Node test environment already prepared"
else
  if [[ -f bun.lock ]]; then
    require_cmd bun "bun.lock detected but bun is not installed"
    bun install --frozen-lockfile
  elif [[ -f pnpm-lock.yaml ]]; then
    if command -v pnpm >/dev/null 2>&1; then
      pnpm install --frozen-lockfile
    elif command -v corepack >/dev/null 2>&1; then
      corepack pnpm install --frozen-lockfile
    else
      echo "pnpm-lock.yaml detected but neither pnpm nor corepack is available" >&2
      exit 2
    fi
  elif [[ -f yarn.lock ]]; then
    if command -v yarn >/dev/null 2>&1; then
      yarn install --immutable
    elif command -v corepack >/dev/null 2>&1; then
      corepack yarn install --immutable
    else
      echo "yarn.lock detected but neither yarn nor corepack is available" >&2
      exit 2
    fi
  elif [[ -f package-lock.json ]]; then
    require_cmd npm "package-lock.json detected but npm is not installed"
    npm ci
  else
    echo "Missing lockfile for deterministic Node QA bootstrap" >&2
    exit 2
  fi
  printf '%s' "$BOOTSTRAP_FINGERPRINT" > "$STATE_FILE"
fi

export PATH="$ROOT_DIR/node_modules/.bin:$PATH"
`;
}

function buildPythonBootstrapPrelude(): string {
  return `${buildCommonScriptPrelude()}

# --- Shared toolchain (ruff, mypy, pip-audit) ---
TOOLCHAIN="$HOME/.openclaw/toolchains/python"
if [ ! -x "$TOOLCHAIN/bin/ruff" ] || [ ! -s "$TOOLCHAIN/bin/ruff" ]; then
  echo "[qa] Toolchain not found — provisioning..."
  command -v uv >/dev/null 2>&1 || {
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"
  }
  uv venv "$TOOLCHAIN"
  uv pip install -p "$TOOLCHAIN/bin/python" ${PYTHON_TOOLCHAIN_PACKAGES.join(" ")}
fi
export PATH="$TOOLCHAIN/bin:$PATH"

# --- Project venv (runtime deps + pytest) ---
if [ ! -x ".venv/bin/python" ]; then
  echo "[qa] .venv not found — creating..."
  command -v uv >/dev/null 2>&1 || export PATH="$HOME/.local/bin:$PATH"
  uv venv .venv
  if [ -f "pyproject.toml" ]; then
    if python3 -c "import tomllib; t=tomllib.load(open('pyproject.toml','rb')); t['project']['optional-dependencies']['dev']" 2>/dev/null; then
      uv pip install -e '.[dev]' --python .venv/bin/python
    else
      uv pip install -e . --python .venv/bin/python
    fi
  elif [ -f "requirements.txt" ]; then
    uv pip install -r requirements.txt --python .venv/bin/python
  fi
fi
export PATH=".venv/bin:$PATH"
`;
}

export function buildQaBootstrapPrelude(stack: CanonicalStack): string {
  const family = familyForStack(stack);
  if (family === "node") return buildNodeBootstrapPrelude();
  if (family === "python") return buildPythonBootstrapPrelude();
  return `${buildCommonScriptPrelude()}
echo "No automated dependency bootstrap for ${shellQuote(stack)} stack"
`;
}

async function computeFingerprint(repoPath: string, files: string[]): Promise<string | null> {
  const existing = [];
  for (const file of files) {
    const fullPath = path.join(repoPath, file);
    if (await pathExists(fullPath)) {
      existing.push(file);
    }
  }
  if (existing.length === 0) return null;

  const hash = createHash("sha256");
  for (const file of existing.sort()) {
    hash.update(`${file}\n`);
    hash.update(await fs.readFile(path.join(repoPath, file)));
    hash.update("\n");
  }
  return hash.digest("hex");
}

async function readBootstrapFingerprint(repoPath: string): Promise<string | null> {
  const stateFile = path.join(repoPath, BOOTSTRAP_STATE_DIR, BOOTSTRAP_STATE_FILE);
  try {
    return (await fs.readFile(stateFile, "utf-8")).trim() || null;
  } catch {
    return null;
  }
}

async function writeBootstrapFingerprint(repoPath: string, fingerprint: string): Promise<void> {
  const stateDir = path.join(repoPath, BOOTSTRAP_STATE_DIR);
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(stateDir, BOOTSTRAP_STATE_FILE), fingerprint, "utf-8");
}

async function toolExists(runCommand: RunCommand, cmd: string, args: string[] = ["--version"]): Promise<boolean> {
  try {
    const result = await runCommand(cmd, args, { timeout: 30_000 });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

async function runAndAssert(
  runCommand: RunCommand,
  repoPath: string,
  commands: BootstrapCommand[],
  command: BootstrapCommand,
): Promise<void> {
  const result = await runCommand(command.cmd, command.args, {
    timeout: DEFAULT_TIMEOUT,
    cwd: repoPath,
    env: command.env,
  });
  commands.push(command);
  if (result.exitCode !== 0) {
    throw new Error(
      `Dependency bootstrap failed (${command.reason}): ${(result.stderr || result.stdout || "unknown error").trim()}`,
    );
  }
}

const UV_INSTALL_URL = "https://astral.sh/uv/install.sh";

export async function ensureUv(runCommand: RunCommand, log?: (msg: string) => void): Promise<string> {
  const emit = log ?? (() => {});

  // Check if uv is already available (use --version, consistent with toolExists pattern)
  const check = await runCommand("uv", ["--version"], { timeout: 10_000 }).catch(() => ({
    stdout: "",
    stderr: "",
    exitCode: 1,
  }));

  if (check.exitCode === 0) {
    emit(`[test-env] uv already available: ${check.stdout.trim()}`);
    return "uv"; // uv is in PATH
  }

  // Try installing via official script
  emit("[test-env] uv not found — installing via official script...");
  const install = await runCommand("bash", [
    "-c",
    `curl -LsSf ${UV_INSTALL_URL} | sh`,
  ], { timeout: 120_000 }).catch(() => ({ stdout: "", stderr: "", exitCode: 1 }));

  if (install.exitCode !== 0) {
    throw new Error(
      `Failed to install uv. Install manually: curl -LsSf ${UV_INSTALL_URL} | sh\n` +
      `Details: ${(install.stderr || install.stdout || "unknown error").trim()}`,
    );
  }

  // Verify uv is now available (install.sh puts it in ~/.local/bin which should be in PATH)
  const verify = await runCommand("uv", ["--version"], { timeout: 10_000 }).catch(() => ({
    stdout: "",
    stderr: "",
    exitCode: 1,
  }));

  if (verify.exitCode === 0) {
    emit(`[test-env] uv installed successfully: ${verify.stdout.trim()}`);
    return "uv";
  }

  // If not in PATH, return absolute path
  const home = process.env.HOME ?? "";
  const fallbackPath = path.join(home, ".local", "bin", "uv");
  try {
    await fs.access(fallbackPath);
    emit(`[test-env] uv installed at fallback path: ${fallbackPath}`);
    return fallbackPath;
  } catch {
    throw new Error(
      `uv installed but not found. Expected at: ${fallbackPath}\n` +
      `Install manually: curl -LsSf ${UV_INSTALL_URL} | sh`,
    );
  }
}

export const PYTHON_TOOLCHAIN_PACKAGES = ["ruff", "mypy", "pip-audit"];
const TOOLCHAIN_DIR = ".openclaw/toolchains/python";
const TOOLCHAIN_FINGERPRINT_FILE = "toolchain.sha256";

export async function toolchainFingerprint(runCommand: RunCommand): Promise<string> {
  let pythonVersion = "unknown";
  try {
    const result = await runCommand("python3", ["--version"], { timeout: 5_000 });
    if (result.exitCode === 0) pythonVersion = result.stdout.trim();
  } catch { /* fallback to "unknown" */ }
  return createHash("sha256")
    .update(PYTHON_TOOLCHAIN_PACKAGES.join(",") + ":" + pythonVersion)
    .digest("hex");
}

export async function ensurePythonToolchain(
  runCommand: RunCommand,
  homeDir?: string,
): Promise<string> {
  const home = homeDir ?? process.env.HOME ?? "/tmp";
  const toolchainPath = path.join(home, TOOLCHAIN_DIR);
  const ruffPath = path.join(toolchainPath, "bin", "ruff");
  const fingerprintPath = path.join(toolchainPath, TOOLCHAIN_FINGERPRINT_FILE);

  const expectedFp = await toolchainFingerprint(runCommand);

  // Check if already provisioned with matching fingerprint
  if (await isValidBinary(ruffPath)) {
    try {
      const currentFp = (await fs.readFile(fingerprintPath, "utf-8")).trim();
      if (currentFp === expectedFp) {
        return toolchainPath;
      }
    } catch {
      // fingerprint missing — rebuild
    }
    // Fingerprint mismatch or missing — teardown and recreate
    await fs.rm(toolchainPath, { recursive: true, force: true });
  }

  const uvCmd = await ensureUv(runCommand);

  // Create toolchain venv
  await fs.mkdir(path.dirname(toolchainPath), { recursive: true });
  const venvResult = await runCommand(uvCmd, ["venv", toolchainPath], { timeout: 60_000 });
  if (venvResult.exitCode !== 0) {
    throw new Error(`Failed to create toolchain venv: ${venvResult.stderr}`);
  }

  // Install tools
  const installResult = await runCommand(uvCmd, [
    "pip", "install",
    "-p", path.join(toolchainPath, "bin", "python"),
    ...PYTHON_TOOLCHAIN_PACKAGES,
  ], { timeout: 120_000 });
  if (installResult.exitCode !== 0) {
    throw new Error(`Failed to install toolchain packages: ${installResult.stderr}`);
  }

  // Write fingerprint
  await fs.writeFile(fingerprintPath, expectedFp, "utf-8");

  return toolchainPath;
}

async function hasPyprojectDevExtra(repoPath: string): Promise<boolean> {
  const pyprojectPath = path.join(repoPath, "pyproject.toml");
  if (!await pathExists(pyprojectPath)) return false;
  const content = await fs.readFile(pyprojectPath, "utf-8");
  const match = content.match(/\[project\.optional-dependencies\]([\s\S]*?)(?:\n\[|$)/);
  if (!match) return false;
  return /^\s*dev\s*=\s*\[/m.test(match[1] ?? "");
}

async function ensureNodeEnvironment(
  repoPath: string,
  stack: CanonicalStack,
  mode: BootstrapMode,
  runCommand: RunCommand,
): Promise<BootstrapResult> {
  const commandsRun: BootstrapCommand[] = [];
  const lockfiles = ["bun.lock", "pnpm-lock.yaml", "yarn.lock", "package-lock.json"];
  const fingerprint = await computeFingerprint(repoPath, ["package.json", ...lockfiles]);
  const current = await readBootstrapFingerprint(repoPath);
  const nodeModulesPath = path.join(repoPath, "node_modules");
  const bunLock = await pathExists(path.join(repoPath, "bun.lock"));
  const pnpmLock = await pathExists(path.join(repoPath, "pnpm-lock.yaml"));
  const yarnLock = await pathExists(path.join(repoPath, "yarn.lock"));
  const packageLock = await pathExists(path.join(repoPath, "package-lock.json"));
  const detectedLockfile = bunLock
    ? "bun.lock"
    : pnpmLock
      ? "pnpm-lock.yaml"
      : yarnLock
        ? "yarn.lock"
        : packageLock
          ? "package-lock.json"
          : null;

  if (fingerprint && current === fingerprint && await pathExists(nodeModulesPath)) {
    return {
      ready: true,
      skipped: true,
      stack,
      family: "node",
      toolchain: "node",
      packageManager: "cached",
      lockfile: detectedLockfile,
      environmentPath: nodeModulesPath,
      commandsRun,
      fingerprint,
    };
  }
  const packageJson = await pathExists(path.join(repoPath, "package.json"));

  if (!packageJson) {
    return {
      ready: false,
      skipped: false,
      stack,
      family: "node",
      toolchain: "node",
      packageManager: "unknown",
      lockfile: null,
      environmentPath: null,
      commandsRun,
      fingerprint,
      reason: "missing_package_json",
    };
  }

  if (bunLock) {
    if (!await toolExists(runCommand, "bun")) {
      return {
        ready: false,
        skipped: false,
        stack,
        family: "node",
        toolchain: "node",
        packageManager: "bun",
        lockfile: "bun.lock",
        environmentPath: null,
        commandsRun,
        fingerprint,
        reason: "bun_lock_without_bun",
      };
    }
    await runAndAssert(runCommand, repoPath, commandsRun, {
      cmd: "bun",
      args: ["install", "--frozen-lockfile"],
      reason: "bun install",
    });
    if (fingerprint) await writeBootstrapFingerprint(repoPath, fingerprint);
    return {
      ready: true,
      skipped: false,
      stack,
      family: "node",
      toolchain: "node",
      packageManager: "bun",
      lockfile: "bun.lock",
      environmentPath: nodeModulesPath,
      commandsRun,
      fingerprint,
    };
  }

  if (pnpmLock) {
    const hasPnpm = await toolExists(runCommand, "pnpm");
    const hasCorepack = await toolExists(runCommand, "corepack");
    if (!hasPnpm && !hasCorepack) {
      return {
        ready: false,
        skipped: false,
        stack,
        family: "node",
        toolchain: "node",
        packageManager: "pnpm",
        lockfile: "pnpm-lock.yaml",
        environmentPath: null,
        commandsRun,
        fingerprint,
        reason: "pnpm_lock_without_pnpm_or_corepack",
      };
    }
    await runAndAssert(runCommand, repoPath, commandsRun, hasPnpm
      ? { cmd: "pnpm", args: ["install", "--frozen-lockfile"], reason: "pnpm install" }
      : { cmd: "corepack", args: ["pnpm", "install", "--frozen-lockfile"], reason: "corepack pnpm install" });
    if (fingerprint) await writeBootstrapFingerprint(repoPath, fingerprint);
    return {
      ready: true,
      skipped: false,
      stack,
      family: "node",
      toolchain: "node",
      packageManager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      environmentPath: nodeModulesPath,
      commandsRun,
      fingerprint,
    };
  }

  if (yarnLock) {
    const hasYarn = await toolExists(runCommand, "yarn");
    const hasCorepack = await toolExists(runCommand, "corepack");
    if (!hasYarn && !hasCorepack) {
      return {
        ready: false,
        skipped: false,
        stack,
        family: "node",
        toolchain: "node",
        packageManager: "yarn",
        lockfile: "yarn.lock",
        environmentPath: null,
        commandsRun,
        fingerprint,
        reason: "yarn_lock_without_yarn_or_corepack",
      };
    }
    await runAndAssert(runCommand, repoPath, commandsRun, hasYarn
      ? { cmd: "yarn", args: ["install", "--immutable"], reason: "yarn install" }
      : { cmd: "corepack", args: ["yarn", "install", "--immutable"], reason: "corepack yarn install" });
    if (fingerprint) await writeBootstrapFingerprint(repoPath, fingerprint);
    return {
      ready: true,
      skipped: false,
      stack,
      family: "node",
      toolchain: "node",
      packageManager: "yarn",
      lockfile: "yarn.lock",
      environmentPath: nodeModulesPath,
      commandsRun,
      fingerprint,
    };
  }

  if (packageLock) {
    if (!await toolExists(runCommand, "npm")) {
      return {
        ready: false,
        skipped: false,
        stack,
        family: "node",
        toolchain: "node",
        packageManager: "npm",
        lockfile: "package-lock.json",
        environmentPath: null,
        commandsRun,
        fingerprint,
        reason: "package_lock_without_npm",
      };
    }
    await runAndAssert(runCommand, repoPath, commandsRun, {
      cmd: "npm",
      args: ["ci"],
      reason: "npm ci",
    });
    if (fingerprint) await writeBootstrapFingerprint(repoPath, fingerprint);
    return {
      ready: true,
      skipped: false,
      stack,
      family: "node",
      toolchain: "node",
      packageManager: "npm",
      lockfile: "package-lock.json",
      environmentPath: nodeModulesPath,
      commandsRun,
      fingerprint,
    };
  }

  if (mode !== "scaffold") {
    return {
      ready: false,
      skipped: false,
      stack,
      family: "node",
      toolchain: "node",
      packageManager: "npm",
      lockfile: null,
      environmentPath: null,
      commandsRun,
      fingerprint,
      reason: "missing_lockfile_for_reproducible_test_bootstrap",
    };
  }

  if (!await toolExists(runCommand, "npm")) {
    return {
      ready: false,
      skipped: false,
      stack,
      family: "node",
      toolchain: "node",
      packageManager: "npm",
      lockfile: null,
      environmentPath: null,
      commandsRun,
      fingerprint,
      reason: "npm_not_available_for_greenfield_bootstrap",
    };
  }

  await runAndAssert(runCommand, repoPath, commandsRun, {
    cmd: "npm",
    args: ["install"],
    reason: "npm install to create deterministic lockfile",
  });
  const newFingerprint = await computeFingerprint(repoPath, ["package.json", ...lockfiles]);
  if (newFingerprint) await writeBootstrapFingerprint(repoPath, newFingerprint);
  return {
    ready: true,
    skipped: false,
    stack,
    family: "node",
    toolchain: "node",
    packageManager: "npm",
    lockfile: "package-lock.json",
    environmentPath: nodeModulesPath,
    commandsRun,
    fingerprint: newFingerprint,
  };
}

async function ensurePythonEnvironment(
  repoPath: string,
  stack: CanonicalStack,
  runCommand: RunCommand,
): Promise<BootstrapResult> {
  const commandsRun: BootstrapCommand[] = [];
  const fingerprint = await computeFingerprint(repoPath, ["pyproject.toml", "requirements.txt", "uv.lock"]);
  const current = await readBootstrapFingerprint(repoPath);
  const venvPath = path.join(repoPath, ".venv");
  const venvPython = path.join(venvPath, "bin", "python");

  if (fingerprint && current === fingerprint && await pathExists(venvPython)) {
    return {
      ready: true,
      skipped: true,
      stack,
      family: "python",
      toolchain: "uv",
      packageManager: "uv",
      lockfile: await pathExists(path.join(repoPath, "uv.lock")) ? "uv.lock" : null,
      environmentPath: venvPath,
      commandsRun,
      fingerprint,
    };
  }

  // Ensure uv is available (auto-install if needed)
  const uvCmd = await ensureUv(runCommand);

  const uvLock = await pathExists(path.join(repoPath, "uv.lock"));
  const pyproject = await pathExists(path.join(repoPath, "pyproject.toml"));
  const requirements = await pathExists(path.join(repoPath, "requirements.txt"));

  if (!uvLock && !pyproject && !requirements) {
    return {
      ready: false,
      skipped: false,
      stack,
      family: "python",
      toolchain: "uv",
      packageManager: "uv",
      lockfile: null,
      environmentPath: null,
      commandsRun,
      fingerprint,
      reason: "missing_pyproject_or_requirements",
    };
  }

  if (uvLock && !pyproject) {
    return {
      ready: false,
      skipped: false,
      stack,
      family: "python",
      toolchain: "uv",
      packageManager: "uv",
      lockfile: "uv.lock",
      environmentPath: null,
      commandsRun,
      fingerprint,
      reason: "uv_lock_requires_pyproject",
    };
  }

  // Ensure shared toolchain exists (only for real Python projects)
  await ensurePythonToolchain(runCommand);

  if (uvLock) {
    await runAndAssert(runCommand, repoPath, commandsRun, {
      cmd: uvCmd,
      args: ["sync", "--locked"],
      reason: "uv sync",
    });
    if (fingerprint) await writeBootstrapFingerprint(repoPath, fingerprint);
    return {
      ready: true,
      skipped: false,
      stack,
      family: "python",
      toolchain: "uv",
      packageManager: "uv",
      lockfile: "uv.lock",
      environmentPath: venvPath,
      commandsRun,
      fingerprint,
    };
  }

  // uv is guaranteed available after ensureUv() — use it unconditionally
  await runAndAssert(runCommand, repoPath, commandsRun, {
    cmd: uvCmd,
    args: ["venv", ".venv"],
    reason: "create project-local virtualenv with uv",
  });
  if (requirements && !pyproject) {
    await runAndAssert(runCommand, repoPath, commandsRun, {
      cmd: uvCmd,
      args: ["pip", "install", "--python", ".venv/bin/python", "-r", "requirements.txt"],
      reason: "install requirements.txt dependencies with uv",
    });
  }
  if (pyproject) {
    const hasDevExtra = await hasPyprojectDevExtra(repoPath);
    await runAndAssert(runCommand, repoPath, commandsRun, {
      cmd: uvCmd,
      args: ["pip", "install", "--python", ".venv/bin/python", "-e", hasDevExtra ? ".[dev]" : "."],
      reason: hasDevExtra ? "install editable project with dev extras via uv" : "install editable project via uv",
    });
  }
  if (fingerprint) await writeBootstrapFingerprint(repoPath, fingerprint);
  return {
    ready: true,
    skipped: false,
    stack,
    family: "python",
    toolchain: "uv",
    packageManager: "uv",
    lockfile: null,
    environmentPath: venvPath,
    commandsRun,
    fingerprint,
  };
}

export async function ensureProjectTestEnvironment(opts: {
  repoPath: string;
  stack: CanonicalStack;
  mode?: BootstrapMode;
  runCommand: RunCommand;
}): Promise<BootstrapResult> {
  const mode = opts.mode ?? "qa";
  const family = familyForStack(opts.stack);

  if (family === "node") {
    return ensureNodeEnvironment(opts.repoPath, opts.stack, mode, opts.runCommand);
  }
  if (family === "python") {
    return ensurePythonEnvironment(opts.repoPath, opts.stack, opts.runCommand);
  }

  return {
    ready: false,
    skipped: false,
    stack: opts.stack,
    family,
    toolchain: family,
    packageManager: family,
    lockfile: null,
    environmentPath: null,
    commandsRun: [],
    fingerprint: null,
    reason: `${opts.stack}_bootstrap_not_implemented`,
  };
}
