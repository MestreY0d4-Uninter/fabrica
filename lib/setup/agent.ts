/**
 * setup/agent.ts — Agent creation and workspace resolution.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginApi, PluginRuntime } from "openclaw/plugin-sdk";
import type { RunCommand } from "../context.js";
import { getRootLogger } from "../observability/logger.js";

/**
 * Create a new agent via `openclaw agents add`.
 * Cleans up .git and BOOTSTRAP.md from the workspace, updates display name.
 */
export async function createAgent(
  api: OpenClawPluginApi | PluginRuntime,
  name: string,
  runCommand: RunCommand,
  channelBinding?: "telegram" | "whatsapp" | null,
  workspacePath?: string,
): Promise<{ agentId: string; workspacePath: string }> {
  const rc = runCommand;
  const agentId = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  const args = ["agents", "add", agentId, "--non-interactive"];
  if (channelBinding) args.push("--bind", channelBinding);
  if (workspacePath) args.push("--workspace", workspacePath);

  try {
    await rc(["openclaw", ...args], { timeoutMs: 30_000 });
  } catch (err) {
    throw new Error(`Failed to create agent "${name}": ${(err as Error).message}`);
  }

  const runtime = "runtime" in api ? api.runtime : api;
  const resolvedWorkspacePath = workspacePath ?? resolveWorkspacePath(runtime, agentId);
  await cleanupWorkspace(resolvedWorkspacePath);
  await updateAgentDisplayName(runtime, agentId, name);

  return { agentId, workspacePath: resolvedWorkspacePath };
}

/**
 * Resolve workspace path from an agent ID via OpenClaw config API.
 */
export function resolveWorkspacePath(api: OpenClawPluginApi | PluginRuntime, agentId: string): string {
  const runtime = "runtime" in api ? api.runtime : api;
  const config = runtime.config.loadConfig();
  const agent = config.agents?.list?.find((a) => a.id === agentId);
  if (!agent?.workspace) {
    throw new Error(`Agent "${agentId}" not found in openclaw.json or has no workspace configured.`);
  }

  return agent.workspace;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

export async function cleanupWorkspace(workspacePath: string): Promise<void> {
  // openclaw agents add creates a .git dir and BOOTSTRAP.md — remove them
  try { await fs.rm(path.join(workspacePath, ".git"), { recursive: true }); } catch { /* may not exist */ }
  try { await fs.unlink(path.join(workspacePath, "BOOTSTRAP.md")); } catch { /* may not exist */ }
}

/**
 * Ensure a dedicated genesis agent exists for Telegram DM bootstrap.
 *
 * Uses `openclaw agents add` directly (not createAgent) because genesis
 * shares the main workspace — no workspace resolution or cleanup needed.
 * Safe to call multiple times — idempotent.
 */
export async function ensureGenesisAgent(
  runtime: PluginRuntime,
  runCommand: RunCommand,
  opts?: { forumGroupId?: string },
): Promise<{ created: boolean; agentId: string }> {
  const config = runtime.config.loadConfig();
  const agents = (config as any).agents?.list ?? [];

  if (agents.some((a: any) => a.id === "genesis")) {
    return { created: false, agentId: "genesis" };
  }

  // Create genesis agent — shares main's workspace, bound to telegram
  const defaultWorkspace = (config as any).agents?.defaults?.workspace;
  const args = ["openclaw", "agents", "add", "genesis", "--non-interactive", "--bind", "telegram"];
  if (defaultWorkspace) args.push("--workspace", defaultWorkspace);
  try {
    await runCommand(args, { timeoutMs: 30_000 });
  } catch (err) {
    throw new Error(`Failed to create genesis agent: ${(err as Error).message}`);
  }

  // Reload config after CLI modified it on disk
  const updatedConfig = runtime.config.loadConfig();

  // Update bindings.
  // Only remove main's channel-wide telegram binding when we have an explicit
  // forum group to re-bind main to. Otherwise preserve the existing main binding
  // so setup does not silently steal Telegram traffic from the primary agent.
  const bindings = ((updatedConfig as any).bindings ?? []).filter((b: any) => {
    const isMainChannelWideTelegram = b.match?.channel === "telegram" && !b.match?.peer && b.agentId === "main";
    if (!isMainChannelWideTelegram) return true;
    return !opts?.forumGroupId;
  });

  // Ensure genesis has channel-wide telegram binding
  if (!bindings.some((b: any) => b.agentId === "genesis" && b.match?.channel === "telegram" && !b.match?.peer)) {
    bindings.push({ agentId: "genesis", match: { channel: "telegram" } });
  }

  // Add group-specific binding for main (Telegram forum notifications)
  if (opts?.forumGroupId) {
    bindings.push({
      agentId: "main",
      match: { channel: "telegram", peer: { kind: "group", id: opts.forumGroupId } },
    });
  }

  (updatedConfig as any).bindings = bindings;
  await runtime.config.writeConfigFile(updatedConfig);

  const logger = getRootLogger().child({ phase: "genesis-setup" });
  logger.info("[fabrica] genesis-agent-created: telegram DMs routed to genesis");

  return { created: true, agentId: "genesis" };
}

/** Check if a genesis agent is configured in the runtime. */
export function hasGenesisAgent(runtime: PluginRuntime): boolean {
  const config = runtime.config.loadConfig();
  return ((config as any).agents?.list ?? []).some((a: any) => a.id === "genesis");
}

async function updateAgentDisplayName(runtime: PluginRuntime, agentId: string, name: string): Promise<void> {
  const logger = getRootLogger().child({ agentId, phase: "agent-setup" });
  if (name === agentId) return;
  try {
    const config = runtime.config.loadConfig();
    const agent = config.agents?.list?.find((a) => a.id === agentId);
    if (agent) {
      (agent as any).name = name;
      await runtime.config.writeConfigFile(config);
    }
  } catch (err) {
    logger.warn({ err }, "Could not update display name");
  }
}
