/**
 * reviewer-session.ts — Parse reviewer session output to extract approve/reject decision.
 *
 * Shared by:
 *   - subagent-lifecycle-hook.ts (on subagent_ended)
 *   - heartbeat reviewer-poll pass (on every tick while session is active)
 */

export type ReviewerDecision = "approve" | "reject";

type ReviewerMessage = {
  role?: unknown;
  content?: unknown;
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

function extractReviewerDecision(text: string): ReviewerDecision | null {
  const matches = Array.from(text.matchAll(/^\s*Review result:\s*(APPROVE|REJECT)\s*$/gim));
  const latestMatch = matches.at(-1);
  if (!latestMatch) return null;

  return latestMatch[1]?.toUpperCase() === "APPROVE" ? "approve" : "reject";
}

export function extractReviewerDecisionFromMessages(messages: unknown[]): ReviewerDecision | null {
  const assistantTexts = messages
    .filter((message): message is ReviewerMessage => typeof message === "object" && message != null)
    .filter((message) => message.role === "assistant")
    .map((message) => extractTextContent(message.content))
    .filter(Boolean)
    .reverse();

  for (const text of assistantTexts) {
    const decision = extractReviewerDecision(text);
    if (decision) return decision;
  }

  return null;
}

/**
 * Read reviewer session messages and extract the review decision.
 * Returns "approve", "reject", or null if undetermined.
 *
 * Recognises only the canonical reviewer contract:
 *   "Review result: APPROVE"
 *   "Review result: REJECT"
 */
export async function parseReviewerSessionResult(
  runtime: { subagent?: { getSessionMessages?: (opts: { sessionKey: string }) => Promise<unknown> } },
  sessionKey: string,
): Promise<ReviewerDecision | null> {
  try {
    const messagesResult = await runtime.subagent?.getSessionMessages?.({ sessionKey });
    if (!messagesResult) return null;

    const messages: unknown[] = Array.isArray(messagesResult)
      ? messagesResult
      : (Array.isArray((messagesResult as any)?.messages) ? (messagesResult as any).messages : []);
    return extractReviewerDecisionFromMessages(messages);
  } catch {
    return null;
  }
}
