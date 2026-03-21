/**
 * GitHubProvider — IssueProvider implementation using gh CLI.
 */
import { createSign } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  type IssueProvider,
  type Issue,
  type StateLabel,
  type IssueComment,
  type PrSelector,
  type PrStatus,
  type PrReviewComment,
  type ReviewSubmission,
  type ReviewSubmissionResult,
  type ReviewCapabilities,
  type ProviderIdentity,
  type RepositoryEnsureRequest,
  type RepositoryEnsureResult,
  PrState,
} from "./provider.js";
import type { RunCommand } from "../context.js";
import { getRootLogger } from "../observability/logger.js";
import { withResilience } from "./resilience.js";
import {
  DEFAULT_WORKFLOW,
  getStateLabels,
  LEGACY_OPERATIONAL_LABELS,
  getLabelColors,
  type WorkflowConfig,
} from "../workflow/index.js";
import {
  resolveGitHubAppId,
  resolveGitHubAuthProfile,
  resolveGitHubPrivateKey,
} from "../github/config-credentials.js";
import type { GitHubAppProfileConfig } from "../config/types.js";
import { parseOwnerRepo } from "../intake/lib/repo-target.js";
import type { PrDetails } from "../github/types.js";

type GhIssue = {
  number: number;
  title: string;
  body: string;
  labels: Array<{ name: string }>;
  state: string;
  url: string;
};

type GitHubPluginConfig = {
  providers?: {
    github?: {
      defaultAuthProfile?: string;
      authProfiles?: Record<string, GitHubAppProfileConfig>;
    };
  };
};

type GitHubProviderConfig = NonNullable<GitHubPluginConfig["providers"]>["github"];

type LinkedPr = {
  number: number;
  id?: string;
  title: string;
  body: string;
  headRefName: string;
  url: string;
  mergedAt: string | null;
  reviewDecision: string | null;
  state: string;
  mergeable: string | null;
};

const logger = getRootLogger().child({ provider: "github" });

function extractExplicitIssueRefs(...texts: Array<string | null | undefined>): number[] {
  const refs = new Set<number>();
  const addMatch = (raw: string) => {
    const value = Number(raw);
    if (Number.isInteger(value) && value > 0) refs.add(value);
  };

  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(/#(\d+)\b/g)) {
      addMatch(match[1]!);
    }
    for (const match of text.matchAll(/\bissue\s+#?(\d+)\b/gi)) {
      addMatch(match[1]!);
    }
  }

  return Array.from(refs).sort((a, b) => a - b);
}

function extractBranchIssueRefs(branchName?: string | null): number[] {
  if (!branchName) return [];
  const refs = new Set<number>();
  for (const match of branchName.matchAll(/(?:^|\/)(\d+)(?:[-/]|$)/g)) {
    const value = Number(match[1]);
    if (Number.isInteger(value) && value > 0) refs.add(value);
  }
  return Array.from(refs).sort((a, b) => a - b);
}

function prCurrentlyTargetsIssue(
  pr: { title: string; body: string; headRefName?: string },
  issueId: number,
): boolean {
  const explicitRefs = extractExplicitIssueRefs(pr.title, pr.body);
  return explicitRefs.length > 0 && explicitRefs.includes(issueId);
}

function toIssue(gh: GhIssue): Issue {
  return {
    iid: gh.number, title: gh.title, description: gh.body ?? "",
    labels: gh.labels.map((l) => l.name), state: gh.state, web_url: gh.url,
  };
}

export class GitHubProvider implements IssueProvider {
  private repoPath: string;
  private workflow: WorkflowConfig;
  private runCommand: RunCommand;
  private pluginConfig?: Record<string, unknown>;
  private providerProfile?: string;
  private installationTokenCache:
    | { repoKey: string; installationId: number; token: string; expiresAt: number }
    | null = null;

  constructor(opts: {
    repoPath: string;
    runCommand: RunCommand;
    workflow?: WorkflowConfig;
    pluginConfig?: Record<string, unknown>;
    providerProfile?: string;
  }) {
    this.repoPath = opts.repoPath;
    this.runCommand = opts.runCommand;
    this.workflow = opts.workflow ?? DEFAULT_WORKFLOW;
    this.pluginConfig = opts.pluginConfig;
    this.providerProfile = opts.providerProfile;
  }

  private async ghAt(args: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<string> {
    return withResilience(async () => {
      const result = await this.runCommand(["gh", ...args], {
        timeoutMs: opts?.timeoutMs ?? 30_000,
        cwd: opts?.cwd,
      });
      if (result.code != null && result.code !== 0) {
        throw new Error(result.stderr?.trim() || `gh command failed with exit code ${result.code}`);
      }
      return result.stdout.trim();
    }, this.repoPath);
  }

  private async gh(args: string[]): Promise<string> {
    return this.ghAt(args, { cwd: this.repoPath });
  }

  private async git(args: string[], opts?: { cwd?: string; timeoutMs?: number; allowFailure?: boolean }): Promise<string> {
    const result = await this.runCommand(["git", ...args], {
      timeoutMs: opts?.timeoutMs ?? 30_000,
      cwd: opts?.cwd ?? this.repoPath,
    });
    if (!opts?.allowFailure && result.code != null && result.code !== 0) {
      throw new Error(result.stderr?.trim() || `git command failed with exit code ${result.code}`);
    }
    return result.stdout.trim();
  }

  /** Cached repo owner/name for GraphQL queries. */
  private repoInfo: { owner: string; name: string } | null | undefined = undefined;

  /**
   * Get repo owner and name via gh CLI. Cached per instance.
   * Returns null if unavailable (no git remote, etc.).
   */
  private async getRepoInfo(): Promise<{ owner: string; name: string } | null> {
    if (this.repoInfo !== undefined) return this.repoInfo;
    try {
      const raw = await this.gh(["repo", "view", "--json", "owner,name"]);
      const data = JSON.parse(raw);
      this.repoInfo = { owner: data.owner.login, name: data.name };
    } catch {
      this.repoInfo = null;
    }
    return this.repoInfo;
  }

  private getGitHubConfig(): GitHubProviderConfig | undefined {
    return (this.pluginConfig as GitHubPluginConfig | undefined)?.providers?.github;
  }

  private resolveAuthProfile(): GitHubAppProfileConfig | undefined {
    return resolveGitHubAuthProfile(this.pluginConfig, this.providerProfile) ?? undefined;
  }

  private getApiBaseUrl(): string {
    return this.resolveAuthProfile()?.baseUrl?.replace(/\/+$/, "") ?? "https://api.github.com";
  }

  private createAppJwt(appId: string, privateKey: string): string {
    const now = Math.floor(Date.now() / 1000);
    const header = this.base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = this.base64UrlEncode(JSON.stringify({
      iat: now - 60,
      exp: now + 9 * 60,
      iss: appId,
    }));
    const signingInput = `${header}.${payload}`;
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    const signature = signer.sign(privateKey).toString("base64url");
    return `${signingInput}.${signature}`;
  }

  private base64UrlEncode(input: string): string {
    return Buffer.from(input).toString("base64url");
  }

  private async githubFetch(
    url: string,
    init: RequestInit,
    auth: { type: "app_jwt"; token: string } | { type: "installation"; token: string },
  ): Promise<Response> {
    const headers = new Headers(init.headers ?? {});
    headers.set("Accept", "application/vnd.github+json");
    headers.set("Authorization", `Bearer ${auth.token}`);
    headers.set("X-GitHub-Api-Version", "2022-11-28");
    if (init.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    return fetch(url, { ...init, headers });
  }

  private async resolveInstallationAuth(): Promise<{
    repo: { owner: string; name: string };
    installationId: number;
    token: string;
  } | null> {
    const profile = this.resolveAuthProfile();
    if (!profile) return null;
    const appId = resolveGitHubAppId(profile);
    const privateKey = resolveGitHubPrivateKey(profile);
    if (!appId || !privateKey) return null;

    const repo = await this.getRepoInfo();
    if (!repo) return null;
    const repoKey = `${repo.owner}/${repo.name}`;
    const now = Date.now();
    if (
      this.installationTokenCache &&
      this.installationTokenCache.repoKey === repoKey &&
      this.installationTokenCache.expiresAt > now + 60_000
    ) {
      return {
        repo,
        installationId: this.installationTokenCache.installationId,
        token: this.installationTokenCache.token,
      };
    }

    const jwt = this.createAppJwt(appId, privateKey);
    const baseUrl = this.getApiBaseUrl();
    const installationResp = await this.githubFetch(
      `${baseUrl}/repos/${repo.owner}/${repo.name}/installation`,
      { method: "GET" },
      { type: "app_jwt", token: jwt },
    );
    if (!installationResp.ok) return null;
    const installation = await installationResp.json() as { id?: number };
    if (!installation.id) return null;

    const tokenResp = await this.githubFetch(
      `${baseUrl}/app/installations/${installation.id}/access_tokens`,
      { method: "POST" },
      { type: "app_jwt", token: jwt },
    );
    if (!tokenResp.ok) return null;
    const tokenPayload = await tokenResp.json() as { token?: string; expires_at?: string };
    if (!tokenPayload.token || !tokenPayload.expires_at) return null;

    this.installationTokenCache = {
      repoKey,
      installationId: installation.id,
      token: tokenPayload.token,
      expiresAt: new Date(tokenPayload.expires_at).getTime(),
    };

    return { repo, installationId: installation.id, token: tokenPayload.token };
  }

  private async findOpenPrNumber(issueId: number): Promise<number | null> {
    type OpenPr = { number: number; title: string; body: string; headRefName: string };
    const prs = await this.findPrsForIssue<OpenPr>(issueId, "open", "number,title,body,headRefName");
    return prs[0]?.number ?? null;
  }

  async ensureRepository(request: RepositoryEnsureRequest): Promise<RepositoryEnsureResult> {
    const explicit = parseOwnerRepo(request.remoteUrl);
    const owner = explicit?.owner ?? request.owner;
    const name = explicit?.repo ?? request.name;
    if (!owner || !name) {
      throw new Error("GitHub repository provisioning requires owner and name or a valid remoteUrl");
    }

    const repoUrl = (request.remoteUrl ?? `https://github.com/${owner}/${name}`).replace(/\.git$/i, "");
    const gitRemoteUrl = `${repoUrl}.git`;
    let defaultBranch = request.defaultBranch?.trim() || "main";
    const visibility = request.visibility ?? "private";
    let created = false;
    let cloned = false;
    let seeded = false;

    try {
      const raw = await this.ghAt([
        "repo", "view", `${owner}/${name}`,
        "--json", "defaultBranchRef",
        "--jq", ".defaultBranchRef.name // empty",
      ]);
      const existingDefaultBranch = raw.trim();
      if (existingDefaultBranch) {
        defaultBranch = existingDefaultBranch;
      }
    } catch {
      const baseArgs = ["repo", "create", `${owner}/${name}`, visibility === "public" ? "--public" : "--private"];
      try {
        if (request.description?.trim()) {
          await this.ghAt([...baseArgs, "--description", request.description.trim()]);
        } else {
          await this.ghAt(baseArgs);
        }
      } catch (error) {
        if (request.description?.trim()) {
          await this.ghAt(baseArgs);
        } else {
          throw error;
        }
      }
      created = true;
    }

    const repoExists = await fs.stat(this.repoPath).then(() => true).catch(() => false);
    if (!repoExists) {
      await fs.mkdir(path.dirname(this.repoPath), { recursive: true });
      try {
        await this.ghAt(["repo", "clone", `${owner}/${name}`, this.repoPath]);
        cloned = true;
      } catch {
        if (!created) {
          throw new Error(`Failed to clone ${owner}/${name} into ${this.repoPath}`);
        }
        await fs.mkdir(this.repoPath, { recursive: true });
        await this.git(["init"], { cwd: this.repoPath });
        await this.git(["remote", "add", "origin", gitRemoteUrl], { cwd: this.repoPath, allowFailure: true });
      }
    } else {
      const hasGitDir = await fs.stat(path.join(this.repoPath, ".git")).then(() => true).catch(() => false);
      if (!hasGitDir) {
        await this.git(["init"], { cwd: this.repoPath });
      }
      const currentOrigin = await this.git(["remote", "get-url", "origin"], {
        cwd: this.repoPath,
        allowFailure: true,
      });
      if (!currentOrigin.trim()) {
        await this.git(["remote", "add", "origin", gitRemoteUrl], { cwd: this.repoPath });
      } else if (currentOrigin.trim() !== gitRemoteUrl) {
        throw new Error(
          `Refusing to repoint existing checkout at ${this.repoPath} from ${currentOrigin.trim()} to ${gitRemoteUrl}. ` +
          `Choose a different local path or reconcile the checkout manually.`,
        );
      }
    }

    const currentBranch = await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd: this.repoPath,
      allowFailure: true,
    });
    if (!currentBranch.trim()) {
      await this.git(["checkout", "-B", defaultBranch], { cwd: this.repoPath });
    } else if (currentBranch.trim() !== defaultBranch) {
      await this.git(["branch", "-M", defaultBranch], { cwd: this.repoPath });
    }

    const hasHeadCommit = await this.git(["rev-parse", "--verify", "HEAD"], {
      cwd: this.repoPath,
      allowFailure: true,
    });
    if (!hasHeadCommit.trim()) {
      const gitUserName = await this.git(["config", "--get", "user.name"], {
        cwd: this.repoPath,
        allowFailure: true,
      });
      if (!gitUserName.trim()) {
        await this.git(["config", "user.name", "Fabrica"], { cwd: this.repoPath });
      }
      const gitUserEmail = await this.git(["config", "--get", "user.email"], {
        cwd: this.repoPath,
        allowFailure: true,
      });
      if (!gitUserEmail.trim()) {
        await this.git(["config", "user.email", "fabrica@local"], { cwd: this.repoPath });
      }
      const readmePath = path.join(this.repoPath, "README.md");
      const hasReadme = await fs.stat(readmePath).then(() => true).catch(() => false);
      if (!hasReadme) {
        await fs.writeFile(readmePath, `# ${name}\n\nBootstrapped by Fabrica.\n`, "utf-8");
      }
      await this.git(["add", "."], { cwd: this.repoPath });
      await this.git(["commit", "-m", "chore: bootstrap repository"], { cwd: this.repoPath });
      seeded = true;
    }

    await this.git(["push", "-u", "origin", defaultBranch], {
      cwd: this.repoPath,
      allowFailure: !seeded,
      timeoutMs: 60_000,
    });

    await this.ghAt([
      "api",
      `repos/${owner}/${name}`,
      "--method",
      "PATCH",
      "--field",
      `default_branch=${defaultBranch}`,
    ]).catch(() => {});

    return {
      repoUrl,
      repoPath: this.repoPath,
      defaultBranch,
      created,
      cloned,
      seeded,
    };
  }

  async resolveRepositoryRemote(): Promise<string | null> {
    const remote = await this.git(["remote", "get-url", "origin"], {
      cwd: this.repoPath,
      allowFailure: true,
    });
    return remote.trim() || null;
  }

  private async getPrStatusForNumber(prNumber: number): Promise<PrStatus | null> {
    try {
      const raw = await this.gh([
        "api",
        `repos/:owner/:repo/pulls/${prNumber}`,
        "--jq",
        "{id: .node_id, number: .number, title: .title, body: .body, headRefName: .head.ref, url: .html_url, state: .state, mergedAt: .merged_at, reviewDecision: .review_decision, mergeable: .mergeable}",
      ]);
      const pr = JSON.parse(raw) as {
        id?: string;
        number: number;
        title: string;
        body: string;
        headRefName: string;
        url: string;
        state: "open" | "closed";
        mergedAt: string | null;
        reviewDecision: string | null;
        mergeable: boolean | null;
      };

      if (!pr?.number || !pr?.url) return null;

      let state: PrState;
      if (pr.state === "closed" && pr.mergedAt) {
        state = pr.reviewDecision === "APPROVED" ? PrState.APPROVED : PrState.MERGED;
      } else if (pr.state === "closed") {
        state = PrState.CLOSED;
      } else if (pr.reviewDecision === "APPROVED") {
        state = PrState.APPROVED;
      } else if (pr.reviewDecision === "CHANGES_REQUESTED") {
        state = PrState.CHANGES_REQUESTED;
      } else {
        const hasChangesRequested = await this.hasChangesRequestedReview(pr.number);
        if (hasChangesRequested) {
          state = PrState.CHANGES_REQUESTED;
        } else {
          const hasReviewFeedback = await this.hasUnacknowledgedReviews(pr.number);
          if (hasReviewFeedback) {
            state = PrState.HAS_COMMENTS;
          } else {
            const hasComments = await this.hasConversationComments(pr.number);
            state = hasComments ? PrState.HAS_COMMENTS : PrState.OPEN;
          }
        }
      }

      const mergeable = pr.mergeable === false ? false
        : pr.mergeable === true ? true
        : undefined;

      return {
        nodeId: pr.id,
        number: pr.number,
        state,
        url: pr.url,
        title: pr.title,
        body: pr.body,
        sourceBranch: pr.headRefName,
        mergeable,
        linkedIssueIds: extractExplicitIssueRefs(pr.title, pr.body),
        branchIssueIds: extractBranchIssueRefs(pr.headRefName),
        bindingSource: "explicit",
        bindingConfidence: "high",
      };
    } catch {
      return null;
    }
  }

  async findOpenPrForBranch(branchName: string): Promise<PrStatus | null> {
    try {
      const raw = await this.gh([
        "pr", "list",
        "--state", "open",
        "--head", branchName,
        "--json", "number,title,body,headRefName,url,reviewDecision,mergeable",
        "--limit", "10",
      ]);
      const prs = JSON.parse(raw) as Array<{
        number: number;
        title: string;
        body: string;
        headRefName: string;
        url: string;
        reviewDecision: string | null;
        mergeable: string | null;
      }>;
      const pr = prs.find((candidate) => candidate.headRefName === branchName) ?? prs[0];
      if (!pr) return null;
      return this.getPrStatusForNumber(pr.number);
    } catch {
      return null;
    }
  }

  private async resolvePrNumber(
    issueId: number,
    selector?: PrSelector,
  ): Promise<number | null> {
    if (selector?.prNumber) return selector.prNumber;
    return this.findOpenPrNumber(issueId);
  }

  /**
   * Find PRs linked to an issue via GitHub's timeline API (GraphQL).
   * This catches PRs regardless of branch naming convention.
   * Returns null if GraphQL query fails (caller should fall back).
   */
  private async findPrsViaTimeline(
    issueId: number,
    state: "open" | "merged" | "all",
  ): Promise<LinkedPr[] | null> {
    const repo = await this.getRepoInfo();
    if (!repo) return null;

    try {
      const query = `query($owner: String!, $name: String!, $issueNumber: Int!) {
        repository(owner: $owner, name: $name) {
          issue(number: $issueNumber) {
            timelineItems(itemTypes: [CONNECTED_EVENT, CROSS_REFERENCED_EVENT], first: 20) {
              nodes {
                __typename
                ... on ConnectedEvent {
                  subject { ... on PullRequest { id number title body headRefName state url mergedAt reviewDecision mergeable } }
                }
                ... on CrossReferencedEvent {
                  source { ... on PullRequest { id number title body headRefName state url mergedAt reviewDecision mergeable } }
                }
              }
            }
          }
        }
      }`;

      const raw = await this.gh([
        "api", "graphql",
        "-F", `owner=${repo.owner}`,
        "-F", `name=${repo.name}`,
        "-F", `issueNumber=${issueId}`,
        "-f", `query=${query}`,
      ]);
      const data = JSON.parse(raw);
      const nodes = data?.data?.repository?.issue?.timelineItems?.nodes ?? [];

      // Extract PR data from both event types
      const seen = new Set<number>();
      const prs: LinkedPr[] = [];

      for (const node of nodes) {
        const pr = node.subject ?? node.source;
        if (!pr?.number || !pr?.url) continue; // Not a PR or empty source
        if (seen.has(pr.number)) continue;
        seen.add(pr.number);
        prs.push({
          id: pr.id ?? undefined,
          number: pr.number,
          title: pr.title ?? "",
          body: pr.body ?? "",
          headRefName: pr.headRefName ?? "",
          url: pr.url,
          mergedAt: pr.mergedAt ?? null,
          reviewDecision: pr.reviewDecision ?? null,
          state: pr.state ?? "",
          mergeable: pr.mergeable ?? null,
        });
      }

      const sortLinkedPrs = <
        T extends { number: number; mergedAt: string | null },
      >(
        linkedPrs: T[],
        sortState: "open" | "merged" | "all",
      ) => linkedPrs.sort((a, b) => {
        if (sortState === "merged") {
          return new Date(b.mergedAt ?? 0).getTime() - new Date(a.mergedAt ?? 0).getTime();
        }
        return b.number - a.number;
      });

      // Filter by state
      if (state === "open") return sortLinkedPrs(prs.filter((pr) => pr.state === "OPEN"), state);
      if (state === "merged") return sortLinkedPrs(prs.filter((pr) => pr.state === "MERGED"), state);
      return sortLinkedPrs(prs, state);
    } catch {
      return null; // GraphQL failed — caller should fall back
    }
  }

  /**
   * Find PRs associated with an issue.
   * Primary: GitHub timeline API (convention-free, catches all linked PRs).
   * Fallback: regex matching on branch name / title / body.
   *
   * TYPE CASTING NOTE: The timeline query returns a fixed set of fields
   * (number, title, body, headRefName, state, url, mergedAt, reviewDecision, mergeable).
   * When callers request additional fields via the `fields` parameter (e.g., "mergeable"),
   * we cast the timeline results to T assuming they match. This works because:
   * 1. For common fields (mergeable, reviewDecision), the timeline API provides them.
   * 2. The fallback path (gh pr list) provides ALL requested fields via the fields parameter.
   * If a caller requests a field the timeline API doesn't provide, the fallback ensures it.
   */
  protected async findPrsForIssue<T extends { title: string; body: string; headRefName?: string }>(
    issueId: number,
    state: "open" | "merged" | "all",
    fields: string,
  ): Promise<T[]> {
    // Try timeline API first (returns all linked PRs regardless of naming convention)
    const timelinePrs = await this.findPrsViaTimeline(issueId, state);
    if (timelinePrs && timelinePrs.length > 0) {
      const currentMatches = timelinePrs.filter((pr) => prCurrentlyTargetsIssue(pr, issueId));
      if (currentMatches.length === 0) return [];
      // Map timeline results to the expected shape (T includes the requested fields)
      // The timeline query now provides: number, title, body, headRefName, state, url, mergedAt, reviewDecision, mergeable
      return currentMatches as unknown as T[];
    }

    // Fallback: explicit issue refs in title/body only. Branch names are historical hints,
    // never a canonical signal that a PR still belongs to an issue.
    try {
      const args = ["pr", "list", "--json", fields, "--limit", "50"];
      if (state !== "all") args.push("--state", state);
      const raw = await this.gh(args);
      if (!raw) return [];
      const prs = JSON.parse(raw) as T[];
      const titlePat = new RegExp(`#${issueId}\\b`);

      // Fallback: word-boundary match in title/body
      return prs
        .filter((pr) => titlePat.test(pr.title) || titlePat.test(pr.body ?? ""))
        .filter((pr) => prCurrentlyTargetsIssue(pr, issueId));
    } catch { return []; }
  }

  async ensureLabel(name: string, color: string): Promise<void> {
    await this.gh(["label", "create", name, "--color", color.replace(/^#/, ""), "--force"]);
  }

  async ensureAllStateLabels(): Promise<void> {
    const labels = getStateLabels(this.workflow);
    const colors = getLabelColors(this.workflow);
    for (const label of labels) {
      await this.ensureLabel(label, colors[label]);
    }
  }

  async createIssue(title: string, description: string, label: StateLabel, assignees?: string[]): Promise<Issue> {
    const args = ["issue", "create", "--title", title, "--body", description, "--label", label];
    if (assignees?.length) args.push("--assignee", assignees.join(","));
    const url = await this.gh(args);
    const match = url.match(/\/issues\/(\d+)$/);
    if (!match) throw new Error(`Failed to parse issue URL: ${url}`);
    return this.getIssue(parseInt(match[1], 10));
  }

  async listIssuesByLabel(label: StateLabel): Promise<Issue[]> {
    try {
      const raw = await this.gh(["issue", "list", "--label", label, "--state", "open", "--json", "number,title,body,labels,state,url"]);
      return (JSON.parse(raw) as GhIssue[]).map(toIssue);
    } catch { return []; }
  }

  async listIssues(opts?: { label?: string; state?: "open" | "closed" | "all" }): Promise<Issue[]> {
    try {
      const args = ["issue", "list", "--state", opts?.state ?? "open", "--json", "number,title,body,labels,state,url"];
      if (opts?.label) args.push("--label", opts.label);
      const raw = await this.gh(args);
      return (JSON.parse(raw) as GhIssue[]).map(toIssue);
    } catch { return []; }
  }

  async getIssue(issueId: number): Promise<Issue> {
    const raw = await this.gh(["issue", "view", String(issueId), "--json", "number,title,body,labels,state,url"]);
    return toIssue(JSON.parse(raw) as GhIssue);
  }

  async listComments(issueId: number): Promise<IssueComment[]> {
    try {
      const raw = await this.gh(["api", `repos/:owner/:repo/issues/${issueId}/comments`, "--jq", ".[] | {id: .id, author: .user.login, body: .body, created_at: .created_at}"]);
      if (!raw) return [];
      return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } catch { return []; }
  }

  async transitionLabel(issueId: number, from: StateLabel, to: StateLabel): Promise<void> {
    // Two-phase transition to ensure atomicity and recoverability:
    // Phase 1: Add new label first (safer than removing first)
    // Phase 2: Remove old state labels
    // This way, if phase 2 fails, the issue still has the new label (issue is correctly transitioned)
    // instead of having no state label at all.
    
    await this.gh(["issue", "edit", String(issueId), "--add-label", to]);
    
    // Remove old state labels (best-effort if there are multiple old labels)
    const issue = await this.getIssue(issueId);
    const stateLabels = getStateLabels(this.workflow);
    const currentStateLabels = issue.labels.filter((l) => stateLabels.includes(l) && l !== to);
    const staleOperationalLabels = issue.labels.filter((l) =>
      LEGACY_OPERATIONAL_LABELS.includes(l as (typeof LEGACY_OPERATIONAL_LABELS)[number]),
    );

    if (currentStateLabels.length > 0 || staleOperationalLabels.length > 0) {
      const args = ["issue", "edit", String(issueId)];
      for (const l of currentStateLabels) args.push("--remove-label", l);
      for (const l of staleOperationalLabels) args.push("--remove-label", l);
      await this.gh(args);
    }

    // Post-transition validation: verify exactly one state label remains (#473)
    try {
      const postIssue = await this.getIssue(issueId);
      const postStateLabels = postIssue.labels.filter((l) => stateLabels.includes(l));
      if (postStateLabels.length !== 1 || !postStateLabels.includes(to)) {
        // Log anomaly but don't throw — transition is already committed
        logger.error({
          issueId,
          from,
          to,
          postStateLabels,
        }, "State transition anomaly detected after GitHub issue label transition");
      }
    } catch {
      // Validation is best-effort — don't break the transition
    }
  }

  async addLabel(issueId: number, label: string): Promise<void> {
    await this.gh(["issue", "edit", String(issueId), "--add-label", label]);
  }

  async removeLabels(issueId: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    const args = ["issue", "edit", String(issueId)];
    for (const l of labels) args.push("--remove-label", l);
    await this.gh(args);
  }

  async closeIssue(issueId: number): Promise<void> { await this.gh(["issue", "close", String(issueId)]); }
  async reopenIssue(issueId: number): Promise<void> { await this.gh(["issue", "reopen", String(issueId)]); }

  async getMergedMRUrl(issueId: number): Promise<string | null> {
    type MergedPr = { title: string; body: string; headRefName: string; url: string; mergedAt: string };
    const prs = await this.findPrsForIssue<MergedPr>(issueId, "merged", "title,body,headRefName,url,mergedAt");
    if (prs.length === 0) return null;
    prs.sort((a, b) => new Date(b.mergedAt).getTime() - new Date(a.mergedAt).getTime());
    return prs[0].url;
  }

  async getPrStatus(issueId: number, selector?: PrSelector): Promise<PrStatus> {
    const selectedPrNumber = selector?.prNumber;
    if (selectedPrNumber) {
      const direct = await this.getPrStatusForNumber(selectedPrNumber);
      if (!direct) return { state: PrState.CLOSED, url: null };
      const linkedIssueIds = direct.linkedIssueIds ?? [];
      return {
        ...direct,
        currentIssueMatch: linkedIssueIds.length > 0 && linkedIssueIds.includes(issueId),
        bindingSource: "selector",
        bindingConfidence: linkedIssueIds.length > 0 ? "high" : "low",
      };
    }

    // Check open PRs first — include mergeable for conflict detection
    type OpenPr = { title: string; body: string; headRefName: string; url: string; number: number; reviewDecision: string; mergeable: string };
    const open = await this.findPrsForIssue<OpenPr>(issueId, "open", "title,body,headRefName,url,number,reviewDecision,mergeable");
    if (open.length > 0) {
      const pr = open[0];
      let state: PrState;
      if (pr.reviewDecision === "APPROVED") {
        state = PrState.APPROVED;
      } else if (pr.reviewDecision === "CHANGES_REQUESTED") {
        state = PrState.CHANGES_REQUESTED;
      } else {
        // No branch protection → reviewDecision may be empty. Check individual reviews.
        const hasChangesRequested = await this.hasChangesRequestedReview(pr.number);
        if (hasChangesRequested) {
          state = PrState.CHANGES_REQUESTED;
        } else {
          // Check for unacknowledged COMMENTED reviews (feedback without formal "Request changes")
          const hasReviewFeedback = await this.hasUnacknowledgedReviews(pr.number);
          if (hasReviewFeedback) {
            state = PrState.HAS_COMMENTS;
          } else {
            // Fall through to conversation comment detection
            const hasComments = await this.hasConversationComments(pr.number);
            state = hasComments ? PrState.HAS_COMMENTS : PrState.OPEN;
          }
        }
      }

      // Conflict detection: "CONFLICTING" means merge conflicts, "UNKNOWN" means still computing
      const mergeable = pr.mergeable === "CONFLICTING" ? false
        : pr.mergeable === "MERGEABLE" ? true
        : undefined; // UNKNOWN or missing — don't assume
      return {
        number: pr.number,
        nodeId: (pr as { id?: string }).id,
        state,
        url: pr.url,
        title: pr.title,
        body: pr.body,
        sourceBranch: pr.headRefName,
        mergeable,
        linkedIssueIds: extractExplicitIssueRefs(pr.title, pr.body),
        branchIssueIds: extractBranchIssueRefs(pr.headRefName),
        currentIssueMatch: true,
        bindingSource: "explicit",
        bindingConfidence: "high",
      };
    }
    // Check merged PRs — also fetch reviewDecision to detect approved-then-merged vs self-merged.
    type MergedPr = { title: string; body: string; headRefName: string; url: string; reviewDecision: string | null; mergedAt?: string | null };
    const merged = await this.findPrsForIssue<MergedPr>(issueId, "merged", "title,body,headRefName,url,reviewDecision,mergedAt");
    if (merged.length > 0) {
      merged.sort((a, b) => new Date(b.mergedAt ?? 0).getTime() - new Date(a.mergedAt ?? 0).getTime());
      const pr = merged[0];
      const state = pr.reviewDecision === "APPROVED" ? PrState.APPROVED : PrState.MERGED;
      return {
        number: (pr as { number?: number }).number,
        nodeId: (pr as { id?: string }).id,
        state,
        url: pr.url,
        title: pr.title,
        body: pr.body,
        sourceBranch: pr.headRefName,
        linkedIssueIds: extractExplicitIssueRefs(pr.title, pr.body),
        branchIssueIds: extractBranchIssueRefs(pr.headRefName),
        currentIssueMatch: true,
        bindingSource: "explicit",
        bindingConfidence: "high",
      };
    }
    // Check for closed-without-merge PRs. url: non-null = PR was explicitly closed;
    // url: null = no PR has ever been created for this issue.
    const allPrs = await this.findPrsViaTimeline(issueId, "all");
    const closedPr = allPrs?.find((pr) => pr.state === "CLOSED");
    if (closedPr) {
      return {
        number: closedPr.number,
        nodeId: closedPr.id,
        state: PrState.CLOSED,
        url: closedPr.url,
        title: closedPr.title,
        sourceBranch: closedPr.headRefName,
        linkedIssueIds: extractExplicitIssueRefs(closedPr.title, closedPr.body),
        branchIssueIds: extractBranchIssueRefs(closedPr.headRefName),
        currentIssueMatch: prCurrentlyTargetsIssue(closedPr, issueId),
        bindingSource: prCurrentlyTargetsIssue(closedPr, issueId) ? "explicit" : "none",
        bindingConfidence: prCurrentlyTargetsIssue(closedPr, issueId) ? "high" : "low",
      };
    }
    return { state: PrState.CLOSED, url: null };
  }

  async getPrDetails(issueId: number): Promise<PrDetails | null> {
    try {
      // Find the open PR for this issue via timeline (reuses existing infrastructure)
      type RawPr = { number: number; headRefName: string; url: string; state: string; mergedAt: string | null };
      let prs = await this.findPrsForIssue<RawPr>(
        issueId,
        "open",
        "number,headRefName,url,state,mergedAt",
      );
      let prState: "open" | "merged" | "closed" = "open";

      if (!prs.length) {
        // Check recently merged PRs
        prs = await this.findPrsForIssue<RawPr>(issueId, "merged", "number,headRefName,url,state,mergedAt");
        if (prs.length) prState = "merged";
      }
      if (!prs.length) return null;

      const pr = prs[0]!;
      if (pr.state === "closed") {
        prState = pr.mergedAt ? "merged" : "closed";
      }

      // Fetch headSha, repositoryId, owner, and repo in one API call
      const raw = await this.gh([
        "api",
        `repos/:owner/:repo/pulls/${pr.number}`,
        "--jq",
        "{headSha: .head.sha, repositoryId: .head.repo.id, owner: .head.repo.owner.login, repo: .head.repo.name}",
      ]);
      const extra = JSON.parse(raw) as { headSha: string; repositoryId: number; owner: string; repo: string };
      if (!extra.headSha || !extra.repositoryId || !extra.owner || !extra.repo) return null;

      return {
        prNumber: pr.number,
        headSha: extra.headSha,
        prState,
        prUrl: pr.url ?? null,
        sourceBranch: pr.headRefName,
        repositoryId: extra.repositoryId,
        owner: extra.owner,
        repo: extra.repo,
      };
    } catch {
      return null;
    }
  }

  /**
   * Check individual reviews for CHANGES_REQUESTED state.
   * Used when branch protection is disabled (reviewDecision is empty).
   */
  private async hasChangesRequestedReview(prNumber: number): Promise<boolean> {
    try {
      const raw = await this.gh(["api", `repos/:owner/:repo/pulls/${prNumber}/reviews`, "--jq",
        "[.[] | select(.state == \"CHANGES_REQUESTED\" or .state == \"APPROVED\") | {user: .user.login, state}] | group_by(.user) | map(sort_by(.state) | last) | .[] | select(.state == \"CHANGES_REQUESTED\") | .user"]);
      return raw.trim().length > 0;
    } catch { return false; }
  }

  /**
   * Check if a PR has unacknowledged COMMENTED reviews from non-bot users.
   * A review is "acknowledged" if it has an 👀 (eyes) reaction.
   * This catches the common case where reviewers submit feedback as "Comment"
   * rather than "Request changes".
   *
   * Note: We don't filter out self-reviews because DevClaw agents commit under
   * the repo owner's account — the PR author and reviewer are the same person.
   */
  private async hasUnacknowledgedReviews(prNumber: number): Promise<boolean> {
    try {
      const raw = await this.gh(["api", `repos/:owner/:repo/pulls/${prNumber}/reviews`]);
      const reviews = JSON.parse(raw) as Array<{
        id: number; user: { login: string }; body: string; state: string;
      }>;

      // Filter to COMMENTED reviews with non-empty body from non-bot users
      const commentedReviews = reviews.filter(
        (r) => r.state === "COMMENTED" && r.body?.trim().length > 0 &&
          !r.user.login.endsWith("[bot]"),
      );

      if (commentedReviews.length === 0) return false;

      // Check if any are unacknowledged (no 👀 reaction)
      for (const review of commentedReviews) {
        try {
          const reactionsRaw = await this.gh([
            "api", `repos/:owner/:repo/pulls/${prNumber}/reviews/${review.id}/reactions`,
          ]);
          const reactions = JSON.parse(reactionsRaw) as Array<{ content: string }>;
          const hasEyes = reactions.some((r) => r.content === "eyes");
          if (!hasEyes) return true; // Found unacknowledged review
        } catch {
          // Can't check reactions — treat as unacknowledged to be safe
          return true;
        }
      }

      return false;
    } catch { return false; }
  }

  /**
   * Check if a PR has any top-level conversation comments from human users.
   * Excludes only bot accounts ([bot] suffix) and empty bodies.
   * Uses the Issues Comments API (PRs are also issues in GitHub).
   */
  private async hasConversationComments(prNumber: number): Promise<boolean> {
    try {
      const raw = await this.gh(["api", `repos/:owner/:repo/issues/${prNumber}/comments`]);
      const comments = JSON.parse(raw) as Array<{ user: { login: string }; body: string; reactions: { eyes: number } }>;
      return comments.some(
        (c) => !c.user.login.endsWith("[bot]") && c.body.trim().length > 0 && !(c.reactions?.eyes > 0),
      );
    } catch { return false; }
  }

  /**
   * Fetch top-level conversation comments on a PR from human users.
   * These are comments on the PR timeline (not inline review comments).
   * Excludes only bot accounts and empty bodies.
   */
  private async fetchConversationComments(
    prNumber: number,
  ): Promise<Array<{ id: number; user: { login: string }; body: string; created_at: string }>> {
    try {
      const raw = await this.gh(["api", `repos/:owner/:repo/issues/${prNumber}/comments`]);
      const all = JSON.parse(raw) as Array<{ id: number; user: { login: string }; body: string; created_at: string }>;
      return all.filter(
        (c) => !c.user.login.endsWith("[bot]") && c.body.trim().length > 0,
      );
    } catch { return []; }
  }

  async mergePr(issueId: number, selector?: PrSelector): Promise<void> {
    const prStatus = await this.getPrStatus(issueId, selector);
    if (prStatus.currentIssueMatch === false) {
      throw new Error(`Bound PR no longer targets issue #${issueId}`);
    }
    const prNumber = await this.resolvePrNumber(issueId, selector);
    if (!prNumber) throw new Error(`No open PR found for issue #${issueId}`);
    await this.gh(["pr", "merge", String(prNumber), "--merge"]);
  }

  async getPrDiff(issueId: number, selector?: PrSelector): Promise<string | null> {
    const prStatus = await this.getPrStatus(issueId, selector);
    if (prStatus.currentIssueMatch === false) return null;
    const prNumber = await this.resolvePrNumber(issueId, selector);
    if (!prNumber) return null;
    try {
      return await this.gh(["pr", "diff", String(prNumber)]);
    } catch { return null; }
  }

  async getPrReviewComments(issueId: number, selector?: PrSelector): Promise<PrReviewComment[]> {
    const prStatus = await this.getPrStatus(issueId, selector);
    if (prStatus.currentIssueMatch === false) return [];
    const prNumber = await this.resolvePrNumber(issueId, selector);
    if (!prNumber) return [];
    const comments: PrReviewComment[] = [];

    try {
      // Review-level comments (top-level reviews: APPROVED, CHANGES_REQUESTED, COMMENTED)
      const reviewsRaw = await this.gh(["api", `repos/:owner/:repo/pulls/${prNumber}/reviews`]);
      const reviews = JSON.parse(reviewsRaw) as Array<{
        id: number; user: { login: string }; body: string; state: string; submitted_at: string;
      }>;
      for (const r of reviews) {
        if (r.state === "DISMISSED") continue; // Skip dismissed
        if (!r.body && r.state === "COMMENTED") continue; // Skip empty COMMENTED reviews
        comments.push({
          id: r.id,
          author: r.user.login,
          body: r.body ?? "",
          state: r.state,
          created_at: r.submitted_at,
        });
      }
    } catch { /* best-effort */ }

    try {
      // Inline (file-level) review comments
      const inlineRaw = await this.gh(["api", `repos/:owner/:repo/pulls/${prNumber}/comments`]);
      const inlines = JSON.parse(inlineRaw) as Array<{
        id: number; user: { login: string }; body: string; path: string; line: number | null; created_at: string;
      }>;
      for (const c of inlines) {
        comments.push({
          id: c.id,
          author: c.user.login,
          body: c.body,
          state: "INLINE",
          created_at: c.created_at,
          path: c.path,
          line: c.line ?? undefined,
        });
      }
    } catch { /* best-effort */ }

    // Top-level conversation comments (regular PR comments via Issues API)
    const conversationComments = await this.fetchConversationComments(prNumber);
    for (const c of conversationComments) {
      comments.push({
        id: c.id,
        author: c.user.login,
        body: c.body,
        state: "COMMENTED",
        created_at: c.created_at,
      });
    }

    // Sort by date
    comments.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    return comments;
  }

  async submitPrReview(issueId: number, review: ReviewSubmission, selector?: PrSelector): Promise<ReviewSubmissionResult> {
    const prStatus = await this.getPrStatus(issueId, selector);
    if (prStatus.currentIssueMatch === false) {
      throw new Error(`No open PR found for issue #${issueId}`);
    }
    const prNumber = await this.resolvePrNumber(issueId, selector);
    if (!prStatus.url || !prNumber) {
      throw new Error(`No open PR found for issue #${issueId}`);
    }

    const installation = await this.resolveInstallationAuth();
    if (!installation) {
      const fallback = await this.addPrConversationComment(issueId, review.body, selector);
      return {
        ...fallback,
        usedFallback: true,
        fallbackReason: "github_app_unavailable",
      };
    }

    const event = review.result === "approve" ? "APPROVE" : "REQUEST_CHANGES";
    const response = await this.githubFetch(
      `${this.getApiBaseUrl()}/repos/${installation.repo.owner}/${installation.repo.name}/pulls/${prNumber}/reviews`,
      {
        method: "POST",
        body: JSON.stringify({
          event,
          body: review.body,
          comments: review.inlineComments?.map((comment) => ({
            path: comment.path,
            line: comment.line,
            body: comment.body,
          })),
        }),
      },
      { type: "installation", token: installation.token },
    );

    if (!response.ok) {
      const fallback = await this.addPrConversationComment(issueId, review.body, selector);
      return {
        ...fallback,
        usedFallback: true,
        fallbackReason: "formal_review_request_failed",
      };
    }

    const payload = await response.json() as { id: number; html_url?: string };
    return {
      artifactId: payload.id,
      artifactType: "formal_review",
      prUrl: prStatus.url,
      usedFallback: false,
    };
  }

  async addPrConversationComment(issueId: number, body: string, selector?: PrSelector): Promise<ReviewSubmissionResult> {
    const prStatus = await this.getPrStatus(issueId, selector);
    if (prStatus.currentIssueMatch === false) {
      throw new Error(`No open PR found for issue #${issueId}`);
    }
    const prNumber = await this.resolvePrNumber(issueId, selector);
    if (!prStatus.url || !prNumber) {
      throw new Error(`No open PR found for issue #${issueId}`);
    }

    const installation = await this.resolveInstallationAuth();
    if (installation) {
      const response = await this.githubFetch(
        `${this.getApiBaseUrl()}/repos/${installation.repo.owner}/${installation.repo.name}/issues/${prNumber}/comments`,
        {
          method: "POST",
          body: JSON.stringify({ body }),
        },
        { type: "installation", token: installation.token },
      );
      if (response.ok) {
        const payload = await response.json() as { id: number };
        return {
          artifactId: payload.id,
          artifactType: "pr_conversation_comment",
          prUrl: prStatus.url,
          usedFallback: false,
        };
      }
    }

    const raw = await this.gh([
      "api", `repos/:owner/:repo/issues/${prNumber}/comments`,
      "--method", "POST",
      "-f", `body=${body}`,
    ]);
    const parsed = JSON.parse(raw) as { id: number };
    return {
      artifactId: parsed.id,
      artifactType: "pr_conversation_comment",
      prUrl: prStatus.url,
      usedFallback: true,
      fallbackReason: installation ? "github_app_comment_failed" : "github_app_unavailable",
    };
  }

  async getReviewCapabilities(_issueId: number): Promise<ReviewCapabilities> {
    const installation = await this.resolveInstallationAuth();
    if (installation) {
      return {
        formalReview: true,
        conversationComment: true,
      };
    }
    return {
      formalReview: false,
      conversationComment: true,
      fallbackReason: "github_app_unavailable",
    };
  }

  async getProviderIdentity(): Promise<ProviderIdentity> {
    const installation = await this.resolveInstallationAuth();
    if (installation) {
      return { mode: "github_app" };
    }
    try {
      const login = await this.gh(["api", "user", "--jq", ".login"]);
      return { mode: "gh_cli", login: login.trim() || undefined };
    } catch {
      return { mode: "gh_cli" };
    }
  }

  async addComment(issueId: number, body: string): Promise<number> {
    const raw = await this.gh([
      "api", `repos/:owner/:repo/issues/${issueId}/comments`,
      "--method", "POST",
      "-f", `body=${body}`,
    ]);
    const parsed = JSON.parse(raw) as { id: number };
    return parsed.id;
  }

  async reactToIssue(issueId: number, emoji: string): Promise<void> {
    try {
      await this.gh([
        "api", `repos/:owner/:repo/issues/${issueId}/reactions`,
        "--method", "POST",
        "--field", `content=${emoji}`,
      ]);
    } catch { /* best-effort */ }
  }

  async issueHasReaction(issueId: number, emoji: string): Promise<boolean> {
    try {
      const raw = await this.gh(["api", `repos/:owner/:repo/issues/${issueId}/reactions`]);
      const reactions = JSON.parse(raw) as Array<{ content: string }>;
      return reactions.some((r) => r.content === emoji);
    } catch { return false; }
  }

  async reactToPr(issueId: number, emoji: string): Promise<void> {
    try {
      // GitHub PRs are also issues — use the same reactions API with the PR number
      type OpenPr = { title: string; body: string; headRefName: string; number: number };
      const prs = await this.findPrsForIssue<OpenPr>(issueId, "open", "title,body,headRefName,number");
      if (prs.length === 0) return;
      await this.gh([
        "api", `repos/:owner/:repo/issues/${prs[0].number}/reactions`,
        "--method", "POST",
        "--field", `content=${emoji}`,
      ]);
    } catch { /* best-effort */ }
  }

  async prHasReaction(issueId: number, emoji: string): Promise<boolean> {
    try {
      type OpenPr = { title: string; body: string; headRefName: string; number: number };
      const prs = await this.findPrsForIssue<OpenPr>(issueId, "open", "title,body,headRefName,number");
      if (prs.length === 0) return false;
      const raw = await this.gh(["api", `repos/:owner/:repo/issues/${prs[0].number}/reactions`]);
      const reactions = JSON.parse(raw) as Array<{ content: string }>;
      return reactions.some((r) => r.content === emoji);
    } catch { return false; }
  }

  async reactToIssueComment(_issueId: number, commentId: number, emoji: string): Promise<void> {
    try {
      await this.gh([
        "api", `repos/:owner/:repo/issues/comments/${commentId}/reactions`,
        "--method", "POST",
        "--field", `content=${emoji}`,
      ]);
    } catch { /* best-effort */ }
  }

  /**
   * Add an emoji reaction to a PR/MR issue comment.
   * Uses the GitHub Issues Comments Reactions API (PRs share the issue comment namespace).
   * Best-effort — swallows all errors.
   */
  async reactToPrComment(_issueId: number, commentId: number, emoji: string): Promise<void> {
    try {
      await this.gh([
        "api", `repos/:owner/:repo/issues/comments/${commentId}/reactions`,
        "--method", "POST",
        "--field", `content=${emoji}`,
      ]);
    } catch { /* best-effort */ }
  }

  /**
   * Add an emoji reaction to a PR review by its review ID.
   * Uses the GitHub Pull Request Review Reactions API.
   */
  async reactToPrReview(issueId: number, reviewId: number, emoji: string): Promise<void> {
    try {
      // We need the PR number, not the issue ID. Find the PR first.
      type OpenPr = { title: string; body: string; headRefName: string; number: number };
      const prs = await this.findPrsForIssue<OpenPr>(issueId, "open", "title,body,headRefName,number");
      if (prs.length === 0) return;
      await this.gh([
        "api", `repos/:owner/:repo/pulls/${prs[0].number}/reviews/${reviewId}/reactions`,
        "--method", "POST",
        "--field", `content=${emoji}`,
      ]);
    } catch { /* best-effort */ }
  }

  async issueCommentHasReaction(issueId: number, commentId: number, emoji: string): Promise<boolean> {
    try {
      const raw = await this.gh(["api", `repos/:owner/:repo/issues/comments/${commentId}/reactions`]);
      const reactions = JSON.parse(raw) as Array<{ content: string }>;
      return reactions.some((r) => r.content === emoji);
    } catch { return false; }
  }

  async prCommentHasReaction(issueId: number, commentId: number, emoji: string): Promise<boolean> {
    try {
      const raw = await this.gh(["api", `repos/:owner/:repo/issues/comments/${commentId}/reactions`]);
      const reactions = JSON.parse(raw) as Array<{ content: string }>;
      return reactions.some((r) => r.content === emoji);
    } catch { return false; }
  }

  async prReviewHasReaction(issueId: number, reviewId: number, emoji: string): Promise<boolean> {
    try {
      type OpenPr = { title: string; body: string; headRefName: string; number: number };
      const prs = await this.findPrsForIssue<OpenPr>(issueId, "open", "title,body,headRefName,number");
      if (prs.length === 0) return false;
      const raw = await this.gh([
        "api", `repos/:owner/:repo/pulls/${prs[0].number}/reviews/${reviewId}/reactions`,
      ]);
      const reactions = JSON.parse(raw) as Array<{ content: string }>;
      return reactions.some((r) => r.content === emoji);
    } catch { return false; }
  }

  async editIssue(issueId: number, updates: { title?: string; body?: string }): Promise<Issue> {
    const args = ["issue", "edit", String(issueId)];
    if (updates.title !== undefined) args.push("--title", updates.title);
    if (updates.body !== undefined) args.push("--body", updates.body);
    await this.gh(args);
    return this.getIssue(issueId);
  }

  /**
   * Check if work for an issue is already present on the base branch via git log.
   * Searches the last 200 commits on baseBranch for commit messages mentioning #issueId.
   * Used as a fallback when no PR exists (e.g., direct commit to main).
   */
  async isCommitOnBaseBranch(issueId: number, baseBranch: string): Promise<boolean> {
    try {
      const result = await this.runCommand(
        ["git", "log", `origin/${baseBranch}`, "--oneline", "-200", "--grep", `#${issueId}`],
        { timeoutMs: 15_000, cwd: this.repoPath },
      );
      return result.stdout.trim().length > 0;
    } catch { return false; }
  }

  async uploadAttachment(
    issueId: number,
    file: { filename: string; buffer: Buffer; mimeType: string },
  ): Promise<string | null> {
    try {
      const branch = "fabrica-attachments";
      const safeFilename = file.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      const filePath = `attachments/${issueId}/${Date.now()}-${safeFilename}`;
      const base64Content = file.buffer.toString("base64");

      // Get repo owner/name
      const repo = await this.getRepoInfo();
      if (!repo) return null;

      // Ensure branch exists
      let branchExists = false;
      try {
        await this.gh(["api", `repos/${repo.owner}/${repo.name}/git/ref/heads/${branch}`]);
        branchExists = true;
      } catch { /* doesn't exist */ }

      if (!branchExists) {
        const raw = await this.gh([
          "repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name",
        ]);
        const defaultBranch = raw.trim();
        const shaRaw = await this.gh([
          "api", `repos/${repo.owner}/${repo.name}/git/ref/heads/${defaultBranch}`,
          "--jq", ".object.sha",
        ]);
        await this.gh([
          "api", `repos/${repo.owner}/${repo.name}/git/refs`,
          "--method", "POST",
          "--field", `ref=refs/heads/${branch}`,
          "--field", `sha=${shaRaw.trim()}`,
        ]);
      }

      // Upload via Contents API
      await this.gh([
        "api", `repos/${repo.owner}/${repo.name}/contents/${filePath}`,
        "--method", "PUT",
        "--field", `message=attachment: ${file.filename} for issue #${issueId}`,
        "--field", `content=${base64Content}`,
        "--field", `branch=${branch}`,
      ]);

      return `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${branch}/${filePath}`;
    } catch {
      return null;
    }
  }

  async healthCheck(): Promise<boolean> {
    try { await this.gh(["auth", "status"]); return true; } catch { return false; }
  }
}
