import fs from "node:fs";
import { spawnSync } from "node:child_process";

function runRaw(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

function run(command, args, options = {}) {
  const result = runRaw(command, args, options);
  if (result.status !== 0) {
    const rendered = result.output.length > 0 ? `\n${result.output}` : "";
    throw new Error(`Command failed: ${command} ${args.join(" ")}${rendered}`);
  }

  return result.output;
}

function runShell(command) {
  return run("bash", ["-lc", command]);
}

function runShellRaw(command) {
  return runRaw("bash", ["-lc", command]).output;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const profile = `fabrica-install-smoke-${Date.now()}`;
let tarball = "";

try {
  const packOutput = run("npm", ["pack", "--json"]);
  const packResult = JSON.parse(packOutput);
  tarball = packResult?.[0]?.filename;

  if (!tarball) {
    throw new Error("npm pack --json did not return a tarball filename.");
  }

  runShell(
    `openclaw --profile ${shellQuote(profile)} plugins install ${shellQuote(tarball)}`
  );

  let inspectOutput = "";
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      inspectOutput = runShell(
        `openclaw --profile ${shellQuote(profile)} plugins inspect fabrica`
      );
      break;
    } catch (error) {
      if (
        attempt === 4 ||
        !(error instanceof Error) ||
        !error.message.includes("unknown command 'inspect'")
      ) {
        throw error;
      }
      sleep(1_500);
    }
  }

  if (!inspectOutput.includes("Status: loaded")) {
    throw new Error(`Inspect output does not contain "Status: loaded".\n${inspectOutput}`);
  }

  const doctorOutput = runShellRaw(
    `openclaw --profile ${shellQuote(profile)} fabrica doctor --workspace ${shellQuote(process.cwd())}`
  );
  if (doctorOutput.trim().length === 0) {
    throw new Error("Doctor output was empty.");
  }

  console.log("Installability smoke passed.");
} finally {
  if (tarball && fs.existsSync(tarball)) {
    fs.rmSync(tarball, { force: true });
  }
}
