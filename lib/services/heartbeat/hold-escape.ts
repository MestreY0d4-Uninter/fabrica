/**
 * hold-escape.ts — Detect issues stuck in hold states with merged PRs and close them.
 *
 * When an issue is in a hold state (Refining, Planning) but its canonical PR
 * has already been merged, the work is complete and the issue should be closed.
 * This typically happens when the work_finish(pass) guard races with PR merge
 * (the tester's guard blocks because the merge artifact wasn't persisted yet).
 *
 * Called by the heartbeat service during its periodic sweep.
 */
import type { IssueProvider } from "../../providers/provider.js";
import { PrState } from "../../providers/provider.js";
import {
  StateType,
  type WorkflowConfig,
  type StateConfig,
} from "../../workflow/index.js";
import { log as auditLog } from "../../audit.js";
import { persistMergedArtifact } from "../pipeline.js";
import { readProjects, getProject, getIssueRuntime, clearIssueRuntime } from "../../projects/index.js";
import { getCanonicalPrSelector } from "../../projects/pr-binding.js";

/**
 * Scan hold states and close issues whose canonical PR is already merged.
 * Returns the number of transitions made.
 */
export async function holdEscapePass(opts: {
  workspaceDir: string;
  projectName: string;
  workflow: WorkflowConfig;
  provider: IssueProvider;
}): Promise<number> {
  const { workspaceDir, projectName, workflow, provider } = opts;
  let transitions = 0;

  // Find all hold-type states
  const holdStates = Object.entries(workflow.states)
    .filter(([, s]) => s.type === StateType.HOLD) as [string, StateConfig][];

  if (holdStates.length === 0) return 0;

  // Find the terminal state (Done) — target for completed work
  const terminalEntry = Object.entries(workflow.states)
    .find(([, s]) => s.type === StateType.TERMINAL);
  if (!terminalEntry) return 0;
  const [, terminalState] = terminalEntry;

  for (const [_stateKey, state] of holdStates) {
    const issues = await provider.listIssuesByLabel(state.label);

    for (const issue of issues) {
      // Only process managed issues (marked with 👀)
      const isManaged = await provider.issueHasReaction(issue.iid, "eyes");
      if (!isManaged) continue;

      // Check if the issue has a canonical PR binding
      const projectsData = await readProjects(workspaceDir).catch(() => null);
      const project = projectsData ? getProject(projectsData, projectName) : null;
      if (!project) continue;

      const selector = getCanonicalPrSelector(project, issue.iid);
      if (!selector) continue;

      // Check PR status using the canonical selector — only escape if PR is merged
      const status = await provider.getPrStatus(issue.iid, selector);
      if (status.state !== PrState.MERGED) continue;

      // PR is merged but issue is stuck in hold → persist artifact, close, transition
      try {
        // Persist the merged artifact (may be missing due to race condition)
        const issueRuntime = getIssueRuntime(project, issue.iid);
        if (issueRuntime?.currentPrNumber && !issueRuntime.artifactOfRecord) {
          await persistMergedArtifact({
            workspaceDir,
            projectSlug: project.slug,
            issueId: issue.iid,
            issueRuntime,
            prUrl: status.url,
          });
        }

        // Close the issue directly — we've already confirmed the PR is merged,
        // so we bypass guardedCloseIssue which would redundantly re-check PR state
        // and potentially fail on stale PR data.
        await provider.closeIssue(issue.iid);
        await clearIssueRuntime(workspaceDir, project.slug, issue.iid);

        // Transition label to terminal state (after close to avoid orphaned Done+open)
        await provider.transitionLabel(issue.iid, state.label, terminalState.label);

        await auditLog(workspaceDir, "hold_escape_transition", {
          project: projectName,
          issueId: issue.iid,
          from: state.label,
          to: terminalState.label,
          reason: "pr_merged_in_hold_state",
          prNumber: selector.prNumber,
          prUrl: status.url,
        });

        transitions++;
      } catch (err) {
        await auditLog(workspaceDir, "hold_escape_failed", {
          project: projectName,
          issueId: issue.iid,
          from: state.label,
          error: (err as Error).message ?? String(err),
        }).catch(() => {});
      }
    }
  }

  return transitions;
}
