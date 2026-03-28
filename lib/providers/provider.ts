/**
 * IssueProvider — Abstract interface for issue tracker operations.
 *
 * Implementations: GitHub (gh CLI), GitLab (glab CLI).
 */

import type { PrDetails } from "../github/types.js";
export type { PrDetails };

/**
 * StateLabel type — string for flexibility with custom workflows.
 */
export type StateLabel = string;

// ---------------------------------------------------------------------------
// Issue types
// ---------------------------------------------------------------------------

export type Issue = {
  iid: number;
  title: string;
  description: string;
  labels: string[];
  state: string;
  web_url: string;
};

export type IssueComment = {
  id: number;
  author: string;
  body: string;
  created_at: string;
};

/** Built-in PR states. */
export const PrState = {
  OPEN: "open",
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  /** PR/MR is open with no formal review state, but has top-level comments from non-authors. */
  HAS_COMMENTS: "has_comments",
  MERGED: "merged",
  CLOSED: "closed",
} as const;
export type PrState = (typeof PrState)[keyof typeof PrState];

export type PrStatus = {
  number?: number;
  nodeId?: string;
  state: PrState;
  url: string | null;
  /** MR/PR title (e.g. "feat: add login page"). */
  title?: string;
  /** PR description body (markdown). */
  body?: string;
  /** Source branch name (e.g. "feature/7-blog-cms"). */
  sourceBranch?: string;
  /** false = has merge conflicts. undefined = unknown or not applicable. */
  mergeable?: boolean;
  /** Issues currently referenced by the PR title/body, if detectable. */
  linkedIssueIds?: number[];
  /** Issue references inferred from branch naming only. Historical hint, never canonical. */
  branchIssueIds?: number[];
  /** Whether this PR still appears to target the current issue semantically. */
  currentIssueMatch?: boolean;
  /** Where the current-match conclusion came from. */
  bindingSource?: "explicit" | "selector" | "inferred" | "none";
  /** Confidence in the current binding decision. */
  bindingConfidence?: "high" | "low";
};

export type PrSelector = {
  prNumber?: number;
};

/** A review comment on a PR/MR. */
export type PrReviewComment = {
  id: number;
  author: string;
  body: string;
  /** "APPROVED", "CHANGES_REQUESTED", "COMMENTED" */
  state: string;
  created_at: string;
  /** File path for inline comments. */
  path?: string;
  /** Line number for inline comments. */
  line?: number;
};

export type ReviewArtifactType = "formal_review" | "pr_conversation_comment";

export type ReviewSubmission = {
  result: "approve" | "reject";
  body: string;
  inlineComments?: Array<{ path: string; line: number; body: string }>;
};

export type ReviewSubmissionResult = {
  artifactId: number;
  artifactType: ReviewArtifactType;
  prUrl: string;
  usedFallback: boolean;
  fallbackReason?: string;
};

export type ReviewCapabilities = {
  formalReview: boolean;
  conversationComment: boolean;
  fallbackReason?: string;
};

export type ProviderIdentity = {
  mode: "github_app" | "gh_cli" | "gitlab_cli" | "test";
  login?: string;
};

export type RepositoryVisibility = "private" | "public";

export type RepositoryEnsureRequest = {
  owner?: string;
  name?: string;
  remoteUrl?: string;
  description?: string;
  visibility?: RepositoryVisibility;
  defaultBranch?: string;
};

export type RepositoryEnsureResult = {
  repoUrl: string;
  repoPath: string;
  defaultBranch: string;
  created: boolean;
  cloned: boolean;
  seeded: boolean;
};

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface IssueProvider {
  ensureRepository(request: RepositoryEnsureRequest): Promise<RepositoryEnsureResult>;
  resolveRepositoryRemote(): Promise<string | null>;
  ensureLabel(name: string, color: string): Promise<void>;
  ensureAllStateLabels(): Promise<void>;
  createIssue(title: string, description: string, label: StateLabel, assignees?: string[]): Promise<Issue>;
  listIssuesByLabel(label: StateLabel): Promise<Issue[]>;
  /** List issues with optional filters. Provider-agnostic — future Jira/Linear/Trello can map to native queries. */
  listIssues(opts?: { label?: string; state?: "open" | "closed" | "all" }): Promise<Issue[]>;
  getIssue(issueId: number): Promise<Issue>;
  listComments(issueId: number): Promise<IssueComment[]>;
  transitionLabel(issueId: number, from: StateLabel, to: StateLabel): Promise<void>;
  addLabel(issueId: number, label: string): Promise<void>;
  removeLabels(issueId: number, labels: string[]): Promise<void>;
  closeIssue(issueId: number): Promise<void>;
  reopenIssue(issueId: number): Promise<void>;
  getMergedMRUrl(issueId: number): Promise<string | null>;
  getPrStatus(issueId: number, selector?: PrSelector): Promise<PrStatus>;
  /**
   * Lightweight PR lookup for polling-based FabricaRun creation.
   * Returns prNumber, headSha, repositoryId, owner/repo, and prState.
   * Does NOT determine review state — use getPrStatus for that.
   * Returns null if no PR exists for the issue or on API error.
   */
  getPrDetails(issueId: number): Promise<PrDetails | null>;
  findOpenPrForBranch(branchName: string): Promise<PrStatus | null>;
  mergePr(issueId: number, selector?: PrSelector): Promise<void>;
  getPrDiff(issueId: number, selector?: PrSelector): Promise<string | null>;
  /** Get review comments on the PR linked to an issue. */
  getPrReviewComments(issueId: number, selector?: PrSelector): Promise<PrReviewComment[]>;
  submitPrReview(issueId: number, review: ReviewSubmission, selector?: PrSelector): Promise<ReviewSubmissionResult>;
  addPrConversationComment(issueId: number, body: string, selector?: PrSelector): Promise<ReviewSubmissionResult>;
  getReviewCapabilities(issueId: number): Promise<ReviewCapabilities>;
  getProviderIdentity(): Promise<ProviderIdentity>;
  /**
   * Check if work for an issue is already present on the base branch via git history.
   * Used as a fallback when no PR exists (e.g., work committed directly to main).
   * Searches recent git log on the base branch for commits mentioning issue #N or !N.
   * @param issueId  Issue number to search for
   * @param baseBranch  Branch to search (e.g. "main")
   */
  isCommitOnBaseBranch(issueId: number, baseBranch: string): Promise<boolean>;
  /**
   * Add an emoji reaction to a PR/MR comment by its comment ID.
   * Best-effort — implementations should not throw.
   * @param issueId  Issue ID (used to locate the associated PR/MR)
   * @param commentId  The numeric ID of the comment to react to
   * @param emoji  Reaction name understood by the provider (e.g. "rocket", "+1")
   */
  /**
   * Add an emoji reaction to an issue comment by its comment ID.
   * Best-effort — implementations should not throw.
   */
  /**
   * Add an emoji reaction to the issue body itself (not a comment).
   * Used to mark issues as "managed by Fabrica" — presence of 👀 on the
   * issue body distinguishes new-style issues from legacy ones.
   * Best-effort — implementations should not throw.
   */
  reactToIssue(issueId: number, emoji: string): Promise<void>;
  /**
   * Check if the issue body has a specific emoji reaction.
   * Returns false on error (best-effort).
   */
  issueHasReaction(issueId: number, emoji: string): Promise<boolean>;
  /**
   * Add an emoji reaction to the PR/MR body linked to an issue.
   * Best-effort — implementations should not throw.
   */
  reactToPr(issueId: number, emoji: string): Promise<void>;
  /**
   * Check if the PR/MR linked to an issue has a specific emoji reaction.
   * Returns false on error (best-effort).
   */
  prHasReaction(issueId: number, emoji: string): Promise<boolean>;
  reactToIssueComment(issueId: number, commentId: number, emoji: string): Promise<void>;
  reactToPrComment(issueId: number, commentId: number, emoji: string): Promise<void>;
  /**
   * Add an emoji reaction to a PR review (not a comment) by its review ID.
   * Best-effort — implementations should not throw.
   */
  reactToPrReview(issueId: number, reviewId: number, emoji: string): Promise<void>;
  /**
   * Check if an issue comment has a specific emoji reaction.
   * Returns false on error (best-effort).
   */
  issueCommentHasReaction(issueId: number, commentId: number, emoji: string): Promise<boolean>;
  /**
   * Check if a PR comment has a specific emoji reaction.
   * Returns false on error (best-effort).
   */
  prCommentHasReaction(issueId: number, commentId: number, emoji: string): Promise<boolean>;
  /**
   * Check if a PR review has a specific emoji reaction.
   * Returns false on error (best-effort).
   */
  prReviewHasReaction(issueId: number, reviewId: number, emoji: string): Promise<boolean>;
  /** Add a comment to an issue. Returns the new comment's ID. */
  addComment(issueId: number, body: string): Promise<number>;
  editIssue(issueId: number, updates: { title?: string; body?: string }): Promise<Issue>;
  /**
   * Upload a file attachment and return a public URL for embedding in issues.
   * Returns null if the provider doesn't support uploads or the upload fails.
   *
   * GitHub: commits file to a `fabrica-attachments` branch, returns raw URL.
   * GitLab: uses the native project uploads API.
   */
  uploadAttachment(issueId: number, file: {
    filename: string;
    buffer: Buffer;
    mimeType: string;
  }): Promise<string | null>;
  healthCheck(): Promise<boolean>;
}
