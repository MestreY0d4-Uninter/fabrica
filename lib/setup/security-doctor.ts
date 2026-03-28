import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "./constants.js";

export type SecurityDoctorSeverity = "ok" | "warn" | "error";

export type SecurityDoctorCheck = {
  name: string;
  severity: SecurityDoctorSeverity;
  message: string;
};

export type SecurityDoctorResult = {
  checks: SecurityDoctorCheck[];
  errors: number;
  warnings: number;
};

type OpenClawConfig = {
  gateway?: {
    bind?: string;
    auth?: {
      mode?: string;
      token?: string;
    };
  };
  channels?: {
    telegram?: {
      enabled?: boolean;
      allowFrom?: string[];
      groupAllowFrom?: string[];
      defaultTo?: string;
    };
  };
  tools?: {
    alsoAllow?: string[];
  };
  plugins?: {
    allow?: string[];
    entries?: Record<string, { enabled?: boolean }>;
  };
  bindings?: Array<{
    agentId?: string;
    match?: { channel?: string };
  }>;
};

type CronJob = {
  name?: string;
  enabled?: boolean;
  payload?: {
    text?: string;
    message?: string;
  };
};

const LEGACY_EXTENSION_PATH_PATTERNS = [
  "/extensions/secureclaw/",
  "/extensions/devclaw/",
  "/extensions/genesis/",
];

const LEGACY_MUTATOR_SCRIPT_PATTERNS = [
  "/workspace/scripts/auto-triage.sh",
  "/workspace/scripts/session-context-health.sh",
];

function summarize(checks: SecurityDoctorCheck[]): SecurityDoctorResult {
  return {
    checks,
    errors: checks.filter((check) => check.severity === "error").length,
    warnings: checks.filter((check) => check.severity === "warn").length,
  };
}

export async function runSecurityDoctor(openclawHome: string): Promise<SecurityDoctorResult> {
  const checks: SecurityDoctorCheck[] = [];
  const configPath = path.join(openclawHome, "openclaw.json");
  const jobsPath = path.join(openclawHome, "cron", "jobs.json");
  const workspacePath = path.join(openclawHome, "workspace");
  const checklistPath = path.join(workspacePath, DATA_DIR, "prompts", "security-checklist.md");

  let config: OpenClawConfig | null = null;
  try {
    config = JSON.parse(await fs.readFile(configPath, "utf-8")) as OpenClawConfig;
    checks.push({
      name: "config:openclaw-json",
      severity: "ok",
      message: "openclaw.json loaded",
    });
  } catch (err) {
    checks.push({
      name: "config:openclaw-json",
      severity: "error",
      message: `Failed to load openclaw.json: ${(err as Error).message}`,
    });
    return summarize(checks);
  }

  const bind = config.gateway?.bind ?? "";
  checks.push({
    name: "gateway:bind",
    severity: bind === "loopback" || bind === "tailscale" ? "ok" : "warn",
    message:
      bind === "loopback" || bind === "tailscale"
        ? `Gateway bind is restricted (${bind})`
        : `Gateway bind is "${bind || "unset"}" — prefer loopback or tailscale`,
  });

  const authMode = config.gateway?.auth?.mode;
  const authToken = config.gateway?.auth?.token;
  checks.push({
    name: "gateway:auth",
    severity: authMode === "token" && !!authToken ? "ok" : "error",
    message:
      authMode === "token" && !!authToken
        ? "Gateway token auth configured"
        : "Gateway token auth missing or incomplete",
  });

  const telegram = config.channels?.telegram;
  checks.push({
    name: "telegram:channel",
    severity: telegram?.enabled ? "ok" : "error",
    message: telegram?.enabled ? "Telegram channel enabled" : "Telegram channel disabled",
  });
  checks.push({
    name: "telegram:allowlist",
    severity:
      (telegram?.allowFrom?.length ?? 0) > 0 || (telegram?.groupAllowFrom?.length ?? 0) > 0
        ? "ok"
        : "warn",
    message:
      (telegram?.allowFrom?.length ?? 0) > 0 || (telegram?.groupAllowFrom?.length ?? 0) > 0
        ? "Telegram allowlist configured"
        : "Telegram allowlist is empty",
  });

  const enabledLegacyPlugins = Object.entries(config.plugins?.entries ?? {})
    .filter(([id, entry]) => entry?.enabled && ["devclaw", "secureclaw", "genesis"].includes(id))
    .map(([id]) => id);
  checks.push({
    name: "plugins:legacy-enabled",
    severity: enabledLegacyPlugins.length > 0 ? "warn" : "ok",
    message:
      enabledLegacyPlugins.length > 0
        ? `Legacy plugins still enabled: ${enabledLegacyPlugins.join(", ")}`
        : "No legacy Fabrica-adjacent plugins enabled",
  });

  const residualPlugins = ["lobster", "llm-task"].filter((id) => config.plugins?.entries?.[id]?.enabled);
  checks.push({
    name: "plugins:residual-enabled",
    severity: residualPlugins.length > 0 ? "warn" : "ok",
    message:
      residualPlugins.length > 0
        ? `Residual plugins still enabled: ${residualPlugins.join(", ")}`
        : "No residual non-essential plugins enabled",
  });

  const routerBinding = (config.bindings ?? []).find(
    (binding) => binding.agentId === "genesis-router" && binding.match?.channel === "telegram",
  );
  checks.push({
    name: "bindings:telegram-router",
    severity: routerBinding ? "warn" : "ok",
    message: routerBinding
      ? "Telegram is still bound to genesis-router"
      : "Telegram is not bound to legacy genesis-router",
  });

  try {
    await fs.access(checklistPath);
    checks.push({
      name: "workspace:security-checklist",
      severity: "ok",
      message: "Security checklist is present in workspace prompts",
    });
  } catch {
    checks.push({
      name: "workspace:security-checklist",
      severity: "warn",
      message: "Security checklist is missing from workspace prompts",
    });
  }

  try {
    const jobsJson = JSON.parse(await fs.readFile(jobsPath, "utf-8")) as { jobs?: CronJob[] };
    const jobs = jobsJson.jobs ?? [];
    const legacyJobFindings = jobs
      .filter((job) => job.enabled !== false)
      .flatMap((job) => {
        const text = `${job.payload?.text ?? ""} ${job.payload?.message ?? ""}`;
        const findings: string[] = [];
        if (LEGACY_EXTENSION_PATH_PATTERNS.some((pattern) => text.includes(pattern))) {
          findings.push(`legacy extension path in cron job "${job.name ?? "unnamed"}"`);
        }
        if (LEGACY_MUTATOR_SCRIPT_PATTERNS.some((pattern) => text.includes(pattern))) {
          findings.push(`legacy mutator script in cron job "${job.name ?? "unnamed"}"`);
        }
        return findings;
      });

    checks.push({
      name: "cron:legacy-references",
      severity: legacyJobFindings.length > 0 ? "warn" : "ok",
      message:
        legacyJobFindings.length > 0
          ? legacyJobFindings.join("; ")
          : "No cron jobs reference legacy extension paths or shell mutators",
    });
  } catch (err) {
    checks.push({
      name: "cron:jobs",
      severity: "warn",
      message: `Unable to inspect cron jobs: ${(err as Error).message}`,
    });
  }

  return summarize(checks);
}
