/**
 * review-skip.ts — Auto-merge and transition review:skip issues through the review queue.
 *
 * When reviewPolicy is "skip", issues arrive in the review queue
 * with a review:skip label. This pass auto-merges their PR and
 * transitions them to the next state (e.g. toTest), executing the
 * SKIP event's configured actions (mergePr, gitPull).
 *
 * Mirrors testSkipPass() in test-skip.ts — called by the heartbeat service.
 */
import type { IssueProvider } from "../../providers/provider.js";
import { PrState } from "../../providers/provider.js";
import {
  Action,
  StateType,
  TestPolicy,
  WorkflowEvent,
  type WorkflowConfig,
  type StateConfig,
} from "../../workflow/index.js";
import { detectStepRouting } from "../queue-scan.js";
import type { RunCommand } from "../../context.js";
import { log as auditLog } from "../../audit.js";
import { guardedCloseIssue, persistMergedArtifact } from "../pipeline.js";
import { readProjects, getProject, getIssueRuntime, getCanonicalPrSelector } from "../../projects/index.js";
import { resilientLabelTransition } from "../../workflow/labels.js";

/**
 * Scan review queue states and auto-merge + transition issues with review:skip.
 * Returns the number of transitions made.
 */
export async function reviewSkipPass(opts: {
  workspaceDir: string;
  projectName: string;
  workflow: WorkflowConfig;
  provider: IssueProvider;
  repoPath: string;
  gitPullTimeoutMs?: number;
  /** Called after a successful PR merge (for notifications). */
  onMerge?: (issueId: number, prUrl: string | null, prTitle?: string, sourceBranch?: string) => void;
  runCommand: RunCommand;
}): Promise<number> {
  const rc = opts.runCommand;
  const { workspaceDir, projectName, workflow, provider, repoPath, gitPullTimeoutMs = 30_000, onMerge } = opts;
  let transitions = 0;

  // Find review queue states (role=reviewer, type=queue) that have a SKIP event
  const reviewQueueStates = Object.entries(workflow.states)
    .filter(([, s]) => s.role === "reviewer" && s.type === StateType.QUEUE) as [string, StateConfig][];

  for (const [_stateKey, state] of reviewQueueStates) {
    const skipTransition = state.on?.[WorkflowEvent.SKIP];
    if (!skipTransition) continue;

    const targetKey = typeof skipTransition === "string" ? skipTransition : skipTransition.target;
    const actions = typeof skipTransition === "object" ? skipTransition.actions : undefined;
    const effectiveActions =
      (workflow.testPolicy ?? TestPolicy.SKIP) === TestPolicy.AGENT
        ? actions?.filter((action) =>
            action !== Action.MERGE_PR &&
            action !== Action.GIT_PULL &&
            action !== Action.REOPEN_ISSUE
          )
        : actions;
    const targetState = workflow.states[targetKey];
    if (!targetState) continue;

    const issues = await provider.listIssuesByLabel(state.label);
    for (const issue of issues) {
      const routing = detectStepRouting(issue.labels, "review");
      if (routing !== "skip") continue;

      // Only process issues managed by Fabrica (marked with 👀 on issue body).
      const isManaged = await provider.issueHasReaction(issue.iid, "eyes");
      if (!isManaged) continue;

      const projectData = await readProjects(workspaceDir).catch(() => null);
      const project = projectData ? getProject(projectData, projectName) : null;
      const issueRuntime = project ? getIssueRuntime(project, issue.iid) : undefined;
      const prSelector = project ? getCanonicalPrSelector(project, issue.iid) : undefined;

      // Execute SKIP transition actions
      let aborted = false;
      if (actions && effectiveActions && actions.length !== effectiveActions.length) {
        await auditLog(workspaceDir, "illegal_merge_before_test", {
          project: projectName,
          issueId: issue.iid,
          role: "reviewer",
          from: state.label,
          to: targetState.label,
          reason: "heartbeat_review_skip",
        });
      }

      if (effectiveActions) {
        for (const action of effectiveActions) {
          switch (action) {
            case Action.MERGE_PR: {
              const status = await provider.getPrStatus(issue.iid, prSelector);
              if (status.currentIssueMatch === false) {
                aborted = true;
                break;
              }
              // Already merged externally — skip the merge call but continue.
              if (status.state === PrState.MERGED) {
                if (project && issueRuntime?.currentPrNumber) {
                  await persistMergedArtifact({
                    workspaceDir,
                    projectSlug: project.slug,
                    issueId: issue.iid,
                    issueRuntime,
                    prUrl: status.url,
                  });
                }
                onMerge?.(issue.iid, status.url, status.title, status.sourceBranch);
                break;
              }
              // No PR exists — skip merge (work may have been committed directly).
              if (!status.url) break;
              try {
                await provider.mergePr(issue.iid, prSelector);
                if (project && issueRuntime?.currentPrNumber) {
                  await persistMergedArtifact({
                    workspaceDir,
                    projectSlug: project.slug,
                    issueId: issue.iid,
                    issueRuntime,
                    prUrl: status.url,
                  });
                }
                onMerge?.(issue.iid, status.url, status.title, status.sourceBranch);
              } catch (err) {
                // Merge failed → fire MERGE_FAILED transition if configured
                await auditLog(workspaceDir, "review_skip_merge_failed", {
                  project: projectName,
                  issueId: issue.iid,
                  from: state.label,
                  error: (err as Error).message ?? String(err),
                });
                const failedTransition = state.on?.[WorkflowEvent.MERGE_FAILED];
                if (failedTransition) {
                  const failedKey = typeof failedTransition === "string" ? failedTransition : failedTransition.target;
                  const failedState = workflow.states[failedKey];
                  if (failedState) {
                    await resilientLabelTransition(provider, issue.iid, state.label, failedState.label);
                    transitions++;
                  }
                }
                aborted = true;
              }
              break;
            }
            case Action.GIT_PULL:
              try { await rc(["git", "pull"], { timeoutMs: gitPullTimeoutMs, cwd: repoPath }); } catch { /* best-effort */ }
              break;
            case Action.CLOSE_ISSUE:
              try {
                if (!project) throw new Error(`Project not found: ${projectName}`);
                await guardedCloseIssue({
                  workspaceDir,
                  projectName,
                  projectSlug: project.slug,
                  issueId: issue.iid,
                  role: "reviewer",
                  provider,
                  selector: prSelector,
                  issueRuntime,
                  followUpPrRequired: issueRuntime?.followUpPrRequired === true,
                });
              } catch {
                aborted = true;
              }
              break;
            case Action.REOPEN_ISSUE:
              try { await provider.reopenIssue(issue.iid); } catch { /* best-effort */ }
              break;
          }
          if (aborted) break;
        }
      }

      if (aborted) continue;

      // Transition label
      await resilientLabelTransition(provider, issue.iid, state.label, targetState.label);

      await auditLog(workspaceDir, "review_skip_transition", {
        project: projectName,
        issueId: issue.iid,
        from: state.label,
        to: targetState.label,
        reason: "review:skip",
      });

      transitions++;
    }
  }

  return transitions;
}
