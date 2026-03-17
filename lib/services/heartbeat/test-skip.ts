/**
 * test-skip.ts — Auto-transition test:skip issues through the test queue.
 *
 * When testPolicy is "skip" (default), issues arrive in the test queue
 * with a test:skip label. This pass auto-transitions them to done,
 * executing the SKIP event's configured actions (e.g. closeIssue).
 *
 * Mirrors reviewPass() in review.ts — called by the heartbeat service.
 */
import type { IssueProvider } from "../../providers/provider.js";
import { PrState } from "../../providers/provider.js";
import {
  Action,
  StateType,
  WorkflowEvent,
  type WorkflowConfig,
  type StateConfig,
} from "../../workflow/index.js";
import { detectStepRouting } from "../queue-scan.js";
import { log as auditLog } from "../../audit.js";
import { guardedCloseIssue, persistMergedArtifact } from "../pipeline.js";
import { readProjects, getProject, getIssueRuntime } from "../../projects/index.js";

/**
 * Scan test queue states and auto-transition issues with test:skip.
 * Returns the number of transitions made.
 */
export async function testSkipPass(opts: {
  workspaceDir: string;
  projectName: string;
  workflow: WorkflowConfig;
  provider: IssueProvider;
  repoPath?: string;
  gitPullTimeoutMs?: number;
  runCommand?: import("../../context.js").RunCommand;
}): Promise<number> {
  const { workspaceDir, projectName, workflow, provider, repoPath, gitPullTimeoutMs = 30_000, runCommand } = opts;
  let transitions = 0;

  // Find test queue states (role=tester, type=queue) that have a SKIP event
  const testQueueStates = Object.entries(workflow.states)
    .filter(([, s]) => s.role === "tester" && s.type === StateType.QUEUE) as [string, StateConfig][];

  for (const [_stateKey, state] of testQueueStates) {
    const skipTransition = state.on?.[WorkflowEvent.SKIP];
    if (!skipTransition) continue;

    const targetKey = typeof skipTransition === "string" ? skipTransition : skipTransition.target;
    const actions = typeof skipTransition === "object" ? skipTransition.actions : undefined;
    const targetState = workflow.states[targetKey];
    if (!targetState) continue;

    const issues = await provider.listIssuesByLabel(state.label);
    for (const issue of issues) {
      const routing = detectStepRouting(issue.labels, "test");
      if (routing !== "skip") continue;

      // Execute SKIP transition actions
      let aborted = false;
      if (actions) {
        for (const action of actions) {
          switch (action) {
            case Action.MERGE_PR: {
              const status = await provider.getPrStatus(issue.iid);
              if (status.currentIssueMatch === false) {
                aborted = true;
                break;
              }
              if (status.state === PrState.MERGED) {
                const project = getProject(await readProjects(workspaceDir), projectName);
                const issueRuntime = project ? getIssueRuntime(project, issue.iid) : undefined;
                if (project && issueRuntime?.currentPrNumber) {
                  await persistMergedArtifact({
                    workspaceDir,
                    projectSlug: project.slug,
                    issueId: issue.iid,
                    issueRuntime,
                    prUrl: status.url,
                  });
                }
                break;
              }
              if (!status.url) break;
              try {
                await provider.mergePr(issue.iid);
                const project = getProject(await readProjects(workspaceDir), projectName);
                const issueRuntime = project ? getIssueRuntime(project, issue.iid) : undefined;
                if (project && issueRuntime?.currentPrNumber) {
                  await persistMergedArtifact({
                    workspaceDir,
                    projectSlug: project.slug,
                    issueId: issue.iid,
                    issueRuntime,
                    prUrl: status.url,
                  });
                }
              } catch (err) {
                await auditLog(workspaceDir, "test_skip_merge_failed", {
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
                    await provider.transitionLabel(issue.iid, state.label, failedState.label);
                    transitions++;
                  }
                }
                aborted = true;
              }
              break;
            }
            case Action.GIT_PULL:
              if (runCommand && repoPath) {
                try { await runCommand(["git", "pull"], { timeoutMs: gitPullTimeoutMs, cwd: repoPath }); } catch { /* best-effort */ }
              }
              break;
            case Action.CLOSE_ISSUE:
              try {
                const project = getProject(await readProjects(workspaceDir), projectName);
                const issueRuntime = project ? getIssueRuntime(project, issue.iid) : undefined;
                if (!project) throw new Error(`Project not found: ${projectName}`);
                await guardedCloseIssue({
                  workspaceDir,
                  projectName,
                  projectSlug: project.slug,
                  issueId: issue.iid,
                  role: "tester",
                  provider,
                  issueRuntime,
                  followUpPrRequired: issueRuntime?.followUpPrRequired === true,
                });
              } catch { /* best-effort */ }
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
      await provider.transitionLabel(issue.iid, state.label, targetState.label);

      await auditLog(workspaceDir, "test_skip_transition", {
        project: projectName,
        issueId: issue.iid,
        from: state.label,
        to: targetState.label,
        reason: "test:skip",
      });

      transitions++;
    }
  }

  return transitions;
}
