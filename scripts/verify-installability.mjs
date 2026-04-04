import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const DEFAULT_TIMEOUT_MS = 300_000;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function formatCommand(command, args) {
  return `${command} ${args.join(" ")}`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildShellCommand(command, args) {
  return [command, ...args].map(shellQuote).join(" ");
}

function failCommand(command, args, status, output) {
  const rendered = output.length > 0 ? `\n${output}` : "";
  throw new Error(
    `Command failed (${status}): ${formatCommand(command, args)}${rendered}`
  );
}

function resolveOpenclawBinary() {
  const lookup = spawnSync("bash", ["-lc", "which -a openclaw | tail -1"], {
    encoding: "utf8",
    timeout: DEFAULT_TIMEOUT_MS,
  });
  const resolved = `${lookup.stdout ?? ""}`.trim();
  return resolved || "openclaw";
}

function neutralizeNpmLifecycleEnv(env = process.env) {
  const nextEnv = { ...env };
  delete nextEnv.npm_config_dry_run;
  delete nextEnv.npm_lifecycle_event;
  delete nextEnv.npm_lifecycle_script;
  return nextEnv;
}

export function executeExternal(command, args, { timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env } = {}) {
  const executable = command === "openclaw" ? resolveOpenclawBinary() : command;
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    env,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();

  if (result.error?.code === "ETIMEDOUT") {
    throw new Error(`Command timed out after ${timeoutMs}ms: ${formatCommand(command, args)}`);
  }

  return {
    status: result.status ?? 1,
    output,
  };
}

export function verifyInstallabilitySmoke({
  exec = executeExternal,
  fsImpl = fs,
  now = Date.now,
  homedir = os.homedir(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const profile = `fabrica-install-smoke-${now()}`;
  const profileDir = path.join(homedir, `.openclaw-${profile}`);
  let tarball = "";

  try {
    const packArgs = ["pack", "--json"];
    const packResult = exec("npm", packArgs, {
      timeoutMs,
      env: neutralizeNpmLifecycleEnv(),
    });
    if (packResult.status !== 0) {
      failCommand("npm", packArgs, packResult.status, packResult.output);
    }

    const packJson = JSON.parse(packResult.output);
    tarball = packJson?.[0]?.filename ?? "";
    if (!tarball) {
      throw new Error("npm pack --json did not return a tarball filename.");
    }

    const installArgs = [
      "--profile", profile,
      "plugins", "install",
      "--dangerously-force-unsafe-install",
      tarball,
    ];
    const installResult = exec("openclaw", installArgs, { timeoutMs });
    if (installResult.status !== 0) {
      failCommand("openclaw", installArgs, installResult.status, installResult.output);
    }

    let inspectOutput = "";
    const inspectArgs = ["--profile", profile, "plugins", "inspect", "fabrica"];
    for (let attempt = 1; attempt <= 4; attempt++) {
      const inspectResult = exec("openclaw", inspectArgs, { timeoutMs });
      if (inspectResult.status === 0) {
        inspectOutput = inspectResult.output;
        break;
      }

      if (attempt < 4 && inspectResult.output.includes("unknown command 'inspect'")) {
        sleep(1_500);
        continue;
      }

      failCommand("openclaw", inspectArgs, inspectResult.status, inspectResult.output);
    }

    if (!inspectOutput.includes("Status: loaded")) {
      throw new Error(`Inspect output does not contain "Status: loaded".\n${inspectOutput}`);
    }

    const doctorArgs = ["--profile", profile, "fabrica", "doctor", "--help"];
    const doctorResult = exec("openclaw", doctorArgs, { timeoutMs });
    if (doctorResult.status !== 0) {
      failCommand("openclaw", doctorArgs, doctorResult.status, doctorResult.output);
    }
    if (doctorResult.output.trim().length === 0) {
      throw new Error("Doctor output was empty.");
    }

    console.log("Installability smoke passed.");
  } finally {
    if (tarball && fsImpl.existsSync(tarball)) {
      fsImpl.rmSync(tarball, { force: true });
    }
    fsImpl.rmSync(profileDir, { recursive: true, force: true });
  }
}

function isMainModule() {
  return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  verifyInstallabilitySmoke();
}
