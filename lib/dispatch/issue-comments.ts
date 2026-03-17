type IssueComment = {
  author: string;
  body: string;
  created_at: string;
};

export function selectIssueComments(
  comments: IssueComment[],
  opts: { role: string; hasPrContext: boolean; hasPrFeedback: boolean },
): IssueComment[] {
  const humanComments = comments.filter((comment) => !isSystemManagedComment(comment));

  if (opts.hasPrFeedback) return [];
  if (opts.role === "reviewer" && opts.hasPrContext) return [];

  return humanComments;
}

function isSystemManagedComment(comment: IssueComment): boolean {
  const body = comment.body.trim();
  const author = comment.author.trim().toLowerCase();

  if (author === "github-actions[bot]") return true;
  if (/\*\*(developer|reviewer|tester|architect|orchestrator)\*\*:/i.test(body)) {
    return true;
  }
  if (/circuit breaker triggered/i.test(body)) return true;
  if (/automated by session-context-health\.sh/i.test(body)) return true;

  return false;
}
