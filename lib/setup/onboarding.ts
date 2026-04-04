/**
 * onboarding.ts — Conversational onboarding context templates.
 *
 * Provides context templates for the onboard tool.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getAllDefaultModels } from "../roles/index.js";

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export function isPluginConfigured(
  pluginConfig?: Record<string, unknown>,
): boolean {
  // Models moved to workflow.yaml — check for any Fabrica plugin config
  // (heartbeat, notifications, etc.)
  return !!pluginConfig && Object.keys(pluginConfig).length > 0;
}

export async function hasWorkspaceFiles(
  workspaceDir?: string,
): Promise<boolean> {
  if (!workspaceDir) return false;
  try {
    const content = await fs.readFile(
      path.join(workspaceDir, "AGENTS.md"),
      "utf-8",
    );
    return content.includes("Fabrica") && (content.includes("task_start") || content.includes("work_start"));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Context templates
// ---------------------------------------------------------------------------

function buildModelTable(): string {
  const lines: string[] = [];
  for (const [role, levels] of Object.entries(getAllDefaultModels())) {
    for (const [level, model] of Object.entries(levels)) {
      lines.push(`  - **${role} ${level}**: ${model}`);
    }
  }
  return lines.join("\n");
}

export function buildReconfigContext(): string {
  const modelTable = buildModelTable();
  return `# Fabrica Reconfiguration

The user wants to reconfigure Fabrica. Default model configuration:

${modelTable}

Models are configured in \`workflow.yaml\` inside the Fabrica workspace data directory. Edit that file directly or call \`setup\` with a \`models\` object to update.

## What can be changed
1. **Model levels** — call \`setup\` with a \`models\` object containing only the levels to change
2. **Workspace files** — \`setup\` re-writes AGENTS.md, HEARTBEAT.md (backs up existing files)
3. **Register new projects** — DM the bot to bootstrap a new project, or use \`project_register\` only for manual/admin cases

Ask what they want to change, then call the appropriate tool.
\`setup\` is safe to re-run — it backs up existing files before overwriting.
`;
}

export function buildOnboardToolContext(): string {
  // Build the model table dynamically from getAllDefaultModels()
  const rows: string[] = [];
  const purposes: Record<string, string> = {
    junior: "Simple tasks, single-file fixes",
    medior: "Features, bug fixes, code review",
    senior: "Architecture, refactoring, complex tasks",
  };
  for (const [role, levels] of Object.entries(getAllDefaultModels())) {
    for (const [level, model] of Object.entries(levels)) {
      rows.push(`| ${role} | ${level} | ${model} | ${purposes[level] ?? ""} |`);
    }
  }
  const modelTable = rows.join("\n");

  return `# Fabrica Onboarding

## What is Fabrica?
Fabrica turns a Telegram DM + projects forum into an autonomous development system:
- An **orchestrator** that manages backlogs and delegates work
- **Developer workers** (junior/medior/senior levels) that write code in isolated sessions
- **Tester workers** that review code and run tests
- Atomic tools for label transitions, session dispatch, state management, and audit logging

## Setup Steps

**Step 1: Agent Selection**
Ask: "Do you want to configure Fabrica for the current agent, or create a new dedicated agent?"
- Current agent → no \`newAgentName\` needed
- New agent → ask for:
  1. Agent name
  2. **Channel binding**: "Which channel should this agent listen to? (telegram/whatsapp/none)"
     - If telegram/whatsapp selected:
       a) Check openclaw.json for existing channel bindings
       b) If channel not configured/enabled → warn and recommend skipping binding for now
       c) If channel-wide binding exists on another agent → ask: "Migrate binding from {agentName}?"
       d) Collect migration decision
     - If none selected, user can add bindings manually later via openclaw.json

**Step 2: Model Configuration**

1. **Call \`autoconfigure_models\`** to automatically discover and assign models:
   - Discovers all authenticated models in OpenClaw
   - Uses AI to intelligently assign them to Fabrica roles
   - Returns a ready-to-use model configuration

2. **Handle the result**:
   - If \`success: false\` and \`modelCount: 0\`:
     - **BLOCK setup** - show the authentication instructions from the message
     - **DO NOT proceed** - exit onboarding until user configures API keys
   - If \`success: true\`:
     - Present the model assignment table to the user
     - Store the \`models\` object for Step 3

3. **Optional: Prefer specific provider**
   - If user wants only models from one provider (e.g., "only use Anthropic"):
   - Call \`autoconfigure_models({ preferProvider: "anthropic" })\`

4. **Confirm with user**
   - Ask: "Does this look good, or would you like to customize any roles?"
   - If approved → proceed to Step 3 with the \`models\` configuration
   - If they want changes → ask which specific roles to modify
   - If they want different provider → go back to step 3

**Step 3: Run Setup**
Call \`setup\` with the collected answers:
- Current agent: \`setup({})\` or \`setup({ models: { developer: { ... }, tester: { ... } } })\`
- New agent: \`setup({ newAgentName: "<name>", channelBinding: "telegram"|"whatsapp"|null, migrateFrom: "<agentId>"|null, models: { ... } })\`
  - \`migrateFrom\`: Include if user wants to migrate an existing channel-wide binding

**Step 4: Telegram Setup (IMPORTANT)**
After setup completes, explain the current operating model:

📱 **Telegram Guidance:**
Fabrica uses the following official path:
1. **DM with the bot** for new-project bootstrap and short clarifications
2. **One forum group for projects** with **one topic per project**

**Minimum recommended setup:**
1. Keep the bot reachable in DM
2. Add the bot to the projects forum group
3. Ensure the bot can create/manage topics there
4. Set 'plugins.entries.fabrica.config.telegram.projectsForumChatId' to that forum group ID

**Optional / advanced:**
- 'projectsForumAccountId' if a specific Telegram account should own forum actions
- 'opsChatId' only if you want a separate ops-only route; it is not required for the core product flow

**Step 5: Project Registration**
Explain that the canonical path for new projects is:

📌 **How to create a new project:**
1. DM the bot with the project idea
2. Fabrica asks short clarification questions only if essential data is missing
3. Fabrica creates the repository if needed
4. Fabrica creates a project topic in the projects forum
5. The rest of the workflow continues in that topic

Manual \`project_register\` remains available for admin recovery and exceptional cases, but it is not the primary path.

**Step 6: Workflow Overview**
After project registration, briefly tell the user about their active workflow:

- **Review policy**: autonomous DM-created projects use **agent review** by default as a quality guardrail.
- **Test phase**: the current workflow still defaults to 'testPolicy: skip' unless explicitly enabled. Explain this as the current operational default, not the quality ideal of the product.
- **Customization**: They can change the review policy ('human', 'agent', 'skip'), enable testing ('testPolicy: agent'), or override settings per project. Point them to 'workflow.yaml' in the Fabrica workspace data directory.
- Say: "Autonomous projects created from DM use **agent review** by default. Testing is still skipped by default in the current workflow unless you enable it, so if you need stricter QA by default you should change 'testPolicy' in your workflow.yaml."

## Guidelines
- Be conversational and friendly. Ask one question at a time.
- Show defaults so the user can accept them quickly.
- After setup, summarize what was configured (including channel binding if applicable).
`;
}
