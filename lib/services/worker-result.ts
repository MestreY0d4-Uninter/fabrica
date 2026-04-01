export type WorkerRole = "developer" | "tester" | "architect" | "reviewer";

export type WorkerResultValue =
  | "DONE"
  | "BLOCKED"
  | "PASS"
  | "FAIL"
  | "FAIL_INFRA"
  | "APPROVE"
  | "REJECT";

export type WorkerResult = {
  role: WorkerRole;
  value: WorkerResultValue;
  source: "final_message" | "session_history";
};

type WorkerMessage = {
  role?: unknown;
  content?: unknown;
};

const ROLE_PREFIX: Record<WorkerRole, string> = {
  developer: "Work result:",
  tester: "Test result:",
  architect: "Architecture result:",
  reviewer: "Review result:",
};

const ALLOWED_RESULTS: Record<WorkerRole, readonly WorkerResultValue[]> = {
  developer: ["DONE", "BLOCKED"],
  tester: ["PASS", "FAIL", "FAIL_INFRA", "BLOCKED"],
  architect: ["DONE", "BLOCKED"],
  reviewer: ["APPROVE", "REJECT"],
};

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((block): block is { type?: unknown; text?: unknown } => typeof block === "object" && block != null)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function isAllowedResult(role: WorkerRole, value: string): value is WorkerResultValue {
  return ALLOWED_RESULTS[role].includes(value as WorkerResultValue);
}

export function extractWorkerResultFromMessages(
  role: WorkerRole,
  messages: unknown[],
): WorkerResult | null {
  const prefix = ROLE_PREFIX[role];
  const assistantMessages = messages
    .filter((message): message is WorkerMessage => typeof message === "object" && message != null)
    .filter((message) => message.role === "assistant");

  const latestAssistantMessage = assistantMessages.at(-1);
  if (!latestAssistantMessage) return null;

  const text = extractTextContent(latestAssistantMessage.content);
  if (!text) return null;

  for (const line of text.split("\n").map((value) => value.trim()).toReversed()) {
    if (!line.startsWith(prefix)) continue;

    const value = line.slice(prefix.length).trim().toUpperCase();
    if (!isAllowedResult(role, value)) return null;

    return { role, value, source: "final_message" };
  }

  return null;
}
