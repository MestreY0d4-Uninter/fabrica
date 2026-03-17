/**
 * TestProvider — In-memory IssueProvider for integration tests.
 *
 * Tracks all method calls for assertion. Issues are stored in a simple map.
 * No external dependencies — pure TypeScript.
 */
import type {
  IssueProvider,
  Issue,
  StateLabel,
  IssueComment,
  PrSelector,
  PrStatus,
  PrReviewComment,
  ReviewSubmission,
  ReviewSubmissionResult,
  ReviewCapabilities,
  ProviderIdentity,
  RepositoryEnsureRequest,
  RepositoryEnsureResult,
} from "../providers/provider.js";
import { getStateLabels } from "../workflow/index.js";
import { DEFAULT_WORKFLOW, type WorkflowConfig } from "../workflow/index.js";

// ---------------------------------------------------------------------------
// Call tracking
// ---------------------------------------------------------------------------

export type ProviderCall =
  | { method: "ensureLabel"; args: { name: string; color: string } }
  | { method: "ensureAllStateLabels"; args: {} }
  | {
      method: "createIssue";
      args: {
        title: string;
        description: string;
        label: StateLabel;
        assignees?: string[];
      };
    }
  | { method: "listIssuesByLabel"; args: { label: StateLabel } }
  | { method: "listIssues"; args: { label?: string; state?: string } }
  | { method: "getIssue"; args: { issueId: number } }
  | { method: "listComments"; args: { issueId: number } }
  | {
      method: "transitionLabel";
      args: { issueId: number; from: StateLabel; to: StateLabel };
    }
  | { method: "addLabel"; args: { issueId: number; label: string } }
  | { method: "removeLabels"; args: { issueId: number; labels: string[] } }
  | { method: "closeIssue"; args: { issueId: number } }
  | { method: "reopenIssue"; args: { issueId: number } }
  | { method: "getMergedMRUrl"; args: { issueId: number } }
  | { method: "getPrStatus"; args: { issueId: number; selector?: PrSelector } }
  | { method: "findOpenPrForBranch"; args: { branchName: string } }
  | { method: "mergePr"; args: { issueId: number; selector?: PrSelector } }
  | { method: "getPrDiff"; args: { issueId: number; selector?: PrSelector } }
  | { method: "getPrReviewComments"; args: { issueId: number; selector?: PrSelector } }
  | { method: "submitPrReview"; args: { issueId: number; review: ReviewSubmission; selector?: PrSelector } }
  | { method: "addPrConversationComment"; args: { issueId: number; body: string; selector?: PrSelector } }
  | { method: "getReviewCapabilities"; args: { issueId: number } }
  | { method: "getProviderIdentity"; args: {} }
  | { method: "addComment"; args: { issueId: number; body: string } }
  | { method: "editIssue"; args: { issueId: number; updates: { title?: string; body?: string } } }
  | { method: "ensureRepository"; args: RepositoryEnsureRequest }
  | { method: "resolveRepositoryRemote"; args: {} }
  | { method: "healthCheck"; args: {} };

// ---------------------------------------------------------------------------
// TestProvider
// ---------------------------------------------------------------------------

export class TestProvider implements IssueProvider {
  /** All issues keyed by iid. */
  issues = new Map<number, Issue>();
  /** Comments per issue. */
  comments = new Map<number, IssueComment[]>();
  /** Labels that have been ensured. */
  labels = new Map<string, string>();
  /** PR status overrides per issue. Default: { state: "closed", url: null }. */
  prStatuses = new Map<number, PrStatus>();
  /** Open PRs keyed by source branch for branch-aware developer validation. */
  branchPrs = new Map<string, PrStatus>();
  /** Merged MR URLs per issue. */
  mergedMrUrls = new Map<number, string>();
  /** Issue IDs where mergePr should fail (simulates merge conflicts). */
  mergePrFailures = new Set<number>();
  /** PR diffs per issue (for reviewer tests). */
  prDiffs = new Map<number, string>();
  /** Review artifacts per issue. */
  prReviewComments = new Map<number, PrReviewComment[]>();
  /** All calls, in order. */
  calls: ProviderCall[] = [];

  private nextIssueId = 1;
  private workflow: WorkflowConfig;

  constructor(opts?: { workflow?: WorkflowConfig }) {
    this.workflow = opts?.workflow ?? DEFAULT_WORKFLOW;
  }

  // -------------------------------------------------------------------------
  // Test helpers
  // -------------------------------------------------------------------------

  /** Create an issue directly in the store (bypasses createIssue tracking). */
  seedIssue(overrides: Partial<Issue> & { iid: number }): Issue {
    const issue: Issue = {
      iid: overrides.iid,
      title: overrides.title ?? `Issue #${overrides.iid}`,
      description: overrides.description ?? "",
      labels: overrides.labels ?? [],
      state: overrides.state ?? "opened",
      web_url:
        overrides.web_url ?? `https://example.com/issues/${overrides.iid}`,
    };
    this.issues.set(issue.iid, issue);
    if (issue.iid >= this.nextIssueId) this.nextIssueId = issue.iid + 1;
    return issue;
  }

  /** Set PR status for an issue (used by review pass tests). */
  setPrStatus(issueId: number, status: PrStatus): void {
    this.prStatuses.set(issueId, status);
  }

  setPrReviewComments(issueId: number, comments: PrReviewComment[]): void {
    this.prReviewComments.set(issueId, comments);
  }

  /** Get calls filtered by method name. */
  callsTo<M extends ProviderCall["method"]>(
    method: M,
  ): Extract<ProviderCall, { method: M }>[] {
    return this.calls.filter((c) => c.method === method) as any;
  }

  /** Reset call tracking (keeps issue state). */
  resetCalls(): void {
    this.calls = [];
  }

  /** Full reset — clear everything. */
  reset(): void {
    this.issues.clear();
    this.comments.clear();
    this.labels.clear();
    this.prStatuses.clear();
    this.branchPrs.clear();
    this.mergedMrUrls.clear();
    this.mergePrFailures.clear();
    this.prDiffs.clear();
    this.prReviewComments.clear();
    this.calls = [];
    this.nextIssueId = 1;
  }

  // -------------------------------------------------------------------------
  // IssueProvider implementation
  // -------------------------------------------------------------------------

  async ensureRepository(request: RepositoryEnsureRequest): Promise<RepositoryEnsureResult> {
    this.calls.push({ method: "ensureRepository", args: request });
    const owner = request.owner ?? "acme";
    const name = request.name ?? "demo";
    return {
      repoUrl: request.remoteUrl ?? `https://github.com/${owner}/${name}`,
      repoPath: `/tmp/${name}`,
      defaultBranch: request.defaultBranch ?? "main",
      created: true,
      cloned: true,
      seeded: false,
    };
  }

  async resolveRepositoryRemote(): Promise<string | null> {
    this.calls.push({ method: "resolveRepositoryRemote", args: {} });
    return "https://github.com/acme/demo.git";
  }

  async ensureLabel(name: string, color: string): Promise<void> {
    this.calls.push({ method: "ensureLabel", args: { name, color } });
    this.labels.set(name, color);
  }

  async ensureAllStateLabels(): Promise<void> {
    this.calls.push({ method: "ensureAllStateLabels", args: {} });
    const stateLabels = getStateLabels(this.workflow);
    for (const label of stateLabels) {
      this.labels.set(label, "#000000");
    }
  }

  async createIssue(
    title: string,
    description: string,
    label: StateLabel,
    assignees?: string[],
  ): Promise<Issue> {
    this.calls.push({
      method: "createIssue",
      args: { title, description, label, assignees },
    });
    const iid = this.nextIssueId++;
    const issue: Issue = {
      iid,
      title,
      description,
      labels: [label],
      state: "opened",
      web_url: `https://example.com/issues/${iid}`,
    };
    this.issues.set(iid, issue);
    return issue;
  }

  async listIssuesByLabel(label: StateLabel): Promise<Issue[]> {
    this.calls.push({ method: "listIssuesByLabel", args: { label } });
    return [...this.issues.values()].filter((i) => i.labels.includes(label));
  }

  async listIssues(opts?: { label?: string; state?: "open" | "closed" | "all" }): Promise<Issue[]> {
    this.calls.push({ method: "listIssues", args: { label: opts?.label, state: opts?.state } });
    let issues = [...this.issues.values()];
    if (opts?.label) issues = issues.filter((i) => i.labels.includes(opts.label!));
    if (opts?.state === "open") issues = issues.filter((i) => i.state === "opened" || i.state === "OPEN");
    else if (opts?.state === "closed") issues = issues.filter((i) => i.state === "closed" || i.state === "CLOSED");
    return issues;
  }

  async getIssue(issueId: number): Promise<Issue> {
    this.calls.push({ method: "getIssue", args: { issueId } });
    const issue = this.issues.get(issueId);
    if (!issue) throw new Error(`Issue #${issueId} not found in TestProvider`);
    return issue;
  }

  async listComments(issueId: number): Promise<IssueComment[]> {
    this.calls.push({ method: "listComments", args: { issueId } });
    return this.comments.get(issueId) ?? [];
  }

  async transitionLabel(
    issueId: number,
    from: StateLabel,
    to: StateLabel,
  ): Promise<void> {
    this.calls.push({ method: "transitionLabel", args: { issueId, from, to } });
    const issue = this.issues.get(issueId);
    if (!issue) throw new Error(`Issue #${issueId} not found in TestProvider`);
    // Remove all state labels, add the new one
    const stateLabels = getStateLabels(this.workflow);
    issue.labels = issue.labels.filter((l) => !stateLabels.includes(l));
    issue.labels.push(to);
  }

  async addLabel(issueId: number, label: string): Promise<void> {
    this.calls.push({ method: "addLabel", args: { issueId, label } });
    const issue = this.issues.get(issueId);
    if (issue && !issue.labels.includes(label)) {
      issue.labels.push(label);
    }
  }

  async removeLabels(issueId: number, labels: string[]): Promise<void> {
    this.calls.push({ method: "removeLabels", args: { issueId, labels } });
    const issue = this.issues.get(issueId);
    if (issue) {
      issue.labels = issue.labels.filter((l) => !labels.includes(l));
    }
  }

  async closeIssue(issueId: number): Promise<void> {
    this.calls.push({ method: "closeIssue", args: { issueId } });
    const issue = this.issues.get(issueId);
    if (issue) issue.state = "closed";
  }

  async reopenIssue(issueId: number): Promise<void> {
    this.calls.push({ method: "reopenIssue", args: { issueId } });
    const issue = this.issues.get(issueId);
    if (issue) issue.state = "opened";
  }

  async getMergedMRUrl(issueId: number): Promise<string | null> {
    this.calls.push({ method: "getMergedMRUrl", args: { issueId } });
    return this.mergedMrUrls.get(issueId) ?? null;
  }

  async getPrStatus(issueId: number, selector?: PrSelector): Promise<PrStatus> {
    this.calls.push({ method: "getPrStatus", args: { issueId, selector } });
    if (selector?.prNumber) {
      return [...this.prStatuses.values()].find((status) => status.number === selector.prNumber)
        ?? { state: "closed", url: null };
    }
    return this.prStatuses.get(issueId) ?? { state: "closed", url: null };
  }

  async findOpenPrForBranch(branchName: string): Promise<PrStatus | null> {
    this.calls.push({ method: "findOpenPrForBranch", args: { branchName } });
    return this.branchPrs.get(branchName) ?? null;
  }

  async mergePr(issueId: number, selector?: PrSelector): Promise<void> {
    this.calls.push({ method: "mergePr", args: { issueId, selector } });
    if (this.mergePrFailures.has(issueId)) {
      throw new Error(`Merge conflict: cannot merge PR for issue #${issueId}`);
    }
    // Simulate successful merge — update PR status to merged
    const existing = this.prStatuses.get(issueId);
    if (existing) {
      this.prStatuses.set(issueId, { ...existing, state: "merged" });
    }
  }

  async getPrDiff(issueId: number, selector?: PrSelector): Promise<string | null> {
    this.calls.push({ method: "getPrDiff", args: { issueId, selector } });
    return this.prDiffs.get(issueId) ?? null;
  }

  async getPrReviewComments(issueId: number, selector?: PrSelector): Promise<PrReviewComment[]> {
    this.calls.push({ method: "getPrReviewComments", args: { issueId, selector } });
    return this.prReviewComments.get(issueId) ?? [];
  }

  async submitPrReview(issueId: number, review: ReviewSubmission, selector?: PrSelector): Promise<ReviewSubmissionResult> {
    this.calls.push({ method: "submitPrReview", args: { issueId, review, selector } });
    const comment: PrReviewComment = {
      id: Date.now(),
      author: "reviewer-app",
      body: review.body,
      state: review.result === "approve" ? "APPROVED" : "CHANGES_REQUESTED",
      created_at: new Date().toISOString(),
    };
    const comments = this.prReviewComments.get(issueId) ?? [];
    comments.push(comment);
    this.prReviewComments.set(issueId, comments);
    return {
      artifactId: comment.id,
      artifactType: "formal_review",
      prUrl: this.prStatuses.get(issueId)?.url ?? `https://example.com/pr/${issueId}`,
      usedFallback: false,
    };
  }

  async addPrConversationComment(issueId: number, body: string, selector?: PrSelector): Promise<ReviewSubmissionResult> {
    this.calls.push({ method: "addPrConversationComment", args: { issueId, body, selector } });
    const comment: PrReviewComment = {
      id: Date.now(),
      author: "reviewer-fallback",
      body,
      state: "COMMENTED",
      created_at: new Date().toISOString(),
    };
    const comments = this.prReviewComments.get(issueId) ?? [];
    comments.push(comment);
    this.prReviewComments.set(issueId, comments);
    return {
      artifactId: comment.id,
      artifactType: "pr_conversation_comment",
      prUrl: this.prStatuses.get(issueId)?.url ?? `https://example.com/pr/${issueId}`,
      usedFallback: true,
    };
  }

  async getReviewCapabilities(issueId: number): Promise<ReviewCapabilities> {
    this.calls.push({ method: "getReviewCapabilities", args: { issueId } });
    return { formalReview: true, conversationComment: true };
  }

  async getProviderIdentity(): Promise<ProviderIdentity> {
    this.calls.push({ method: "getProviderIdentity", args: {} });
    return { mode: "test", login: "reviewer-app" };
  }

  async reactToIssue(_issueId: number, _emoji: string): Promise<void> {
    // no-op in test provider
  }

  async issueHasReaction(_issueId: number, _emoji: string): Promise<boolean> {
    return true; // test provider assumes all issues are "new style"
  }

  async reactToPr(_issueId: number, _emoji: string): Promise<void> {
    // no-op in test provider
  }

  async prHasReaction(_issueId: number, _emoji: string): Promise<boolean> {
    return true; // test provider assumes all PRs are "new style"
  }

  async reactToIssueComment(_issueId: number, _commentId: number, _emoji: string): Promise<void> {
    // no-op in test provider
  }

  async reactToPrComment(_issueId: number, _commentId: number, _emoji: string): Promise<void> {
    // no-op in test provider
  }

  async reactToPrReview(_issueId: number, _reviewId: number, _emoji: string): Promise<void> {
    // no-op in test provider
  }

  async issueCommentHasReaction(_issueId: number, _commentId: number, _emoji: string): Promise<boolean> {
    return false; // test provider: no existing reactions
  }

  async prCommentHasReaction(_issueId: number, _commentId: number, _emoji: string): Promise<boolean> {
    return false; // test provider: no existing reactions
  }

  async prReviewHasReaction(_issueId: number, _reviewId: number, _emoji: string): Promise<boolean> {
    return false; // test provider: no existing reactions
  }

  async isCommitOnBaseBranch(_issueId: number, _baseBranch: string): Promise<boolean> {
    return false; // no-op in test provider
  }

  async addComment(issueId: number, body: string): Promise<number> {
    this.calls.push({ method: "addComment", args: { issueId, body } });
    const commentId = Date.now();
    const existing = this.comments.get(issueId) ?? [];
    existing.push({
      id: commentId,
      author: "test",
      body,
      created_at: new Date().toISOString(),
    });
    this.comments.set(issueId, existing);
    return commentId;
  }

  async editIssue(issueId: number, updates: { title?: string; body?: string }): Promise<Issue> {
    this.calls.push({ method: "editIssue", args: { issueId, updates } });
    const issue = this.issues.get(issueId);
    if (!issue) throw new Error(`Issue #${issueId} not found in TestProvider`);
    if (updates.title !== undefined) issue.title = updates.title;
    if (updates.body !== undefined) issue.description = updates.body;
    return issue;
  }

  async uploadAttachment(
    _issueId: number,
    _file: { filename: string; buffer: Buffer; mimeType: string },
  ): Promise<string | null> {
    return null;
  }

  async healthCheck(): Promise<boolean> {
    this.calls.push({ method: "healthCheck", args: {} });
    return true;
  }
}
