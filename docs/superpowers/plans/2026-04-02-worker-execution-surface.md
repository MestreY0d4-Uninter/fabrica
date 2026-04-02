# Worker Execution Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Fabrica hot path workers from using meta-skills or nested coding agents, and recover cleanly when execution-contract violations still occur.

**Architecture:** Add a layered contract around workers: filter inherited skill surface where possible, harden worker prompts/context so direct execution in the assigned worktree is mandatory, and add transcript-based runtime detection plus short-window recovery for forbidden meta-delegation. Keep the FSM semantics clean by treating this as operational failure, not review/test rejection.

**Tech Stack:** TypeScript, OpenClaw plugin hooks/runtime, Vitest, Fabrica audit/pipeline/recovery services

---

## File Map

- Modify: `lib/dispatch/worker-context-hook.ts`
  - Harden worker system context with explicit anti-delegation instructions.
- Modify: `defaults/fabrica/prompts/developer.md`
  - Make direct execution in the assigned worktree mandatory and forbid nested coding agents and planning/meta-skills.
- Modify: `defaults/fabrica/prompts/tester.md`
  - Apply the same anti-delegation rule for tester.
- Modify: `defaults/fabrica/prompts/reviewer.md`
  - Apply the same anti-delegation rule for reviewer.
- Modify: `defaults/fabrica/prompts/architect.md`
  - Apply the same anti-delegation rule for architect.
- Modify: `lib/services/worker-completion.ts`
  - Detect execution-contract violations from transcript evidence and route them into recovery.
- Modify: `lib/services/heartbeat/health.ts`
  - Distinguish execution-contract recovery from normal dispatch liveness.
- Modify: `lib/services/pipeline.ts`
  - Add operational notification path for execution-contract failure/requeue if this file is already the central transition notifier.
- Modify: `lib/dispatch/notify.ts`
  - Add concise topic event for worker execution-contract failure/requeue.
- Modify: `lib/audit.ts` or the callers that emit audit events
  - Add explicit audit events for meta-delegation and recovery exhaustion.
- Create: `tests/unit/worker-execution-surface.test.ts`
  - Transcript-driven regression tests for forbidden meta-delegation detection and recovery decisions.
- Modify: `tests/unit/worker-context-hook.test.ts`
  - Assert anti-delegation context is injected for worker roles.
- Modify: `tests/unit/developer-prompt-content.test.ts`
  - Assert developer prompt forbids nested coding agents and planning/meta-skills.
- Modify: `tests/unit/heartbeat-health-session.test.ts`
  - Cover the case where a worker run violates execution contract and should not stay indefinitely in normal running state.
- Modify: `tests/unit/pipeline-notify.test.ts` or `tests/unit/notify.test.ts`
  - Cover the new operational notification event if needed.

## Task 1: Encode The Worker Contract In Prompts And Context

**Files:**
- Modify: `lib/dispatch/worker-context-hook.ts`
- Modify: `defaults/fabrica/prompts/developer.md`
- Modify: `defaults/fabrica/prompts/tester.md`
- Modify: `defaults/fabrica/prompts/reviewer.md`
- Modify: `defaults/fabrica/prompts/architect.md`
- Modify: `tests/unit/worker-context-hook.test.ts`
- Modify: `tests/unit/developer-prompt-content.test.ts`

- [ ] **Step 1: Write/adjust the failing prompt-context tests**

Add assertions that the worker contract explicitly forbids:
- nested coding agents
- planning/meta-skills
- delegating to another agent
- leaving the assigned worktree execution path

Target commands:

```bash
cd /home/mateus/Fabrica/.worktrees/hot-path-operational-corrections/fabrica
npx vitest run tests/unit/worker-context-hook.test.ts tests/unit/developer-prompt-content.test.ts
```

Expected: failing assertions because the anti-delegation language is not fully present yet.

- [ ] **Step 2: Harden `worker-context-hook.ts`**

Update the injected completion context so every hot path worker role gets a short operational rule block, for example:

```ts
const EXECUTION_SURFACE_CONTEXT = `## Execution Contract

You must execute the task directly in the assigned project worktree.
Do not delegate implementation, testing, review, or planning to another coding agent.
Do not use planning or meta-skills such as brainstorming, writing-plans, or coding-agent.
Do not spawn or supervise another agent to do your work.
If you cannot proceed directly in the assigned worktree, conclude with the canonical BLOCKED result line for your role.
`;
```

Append or prepend this consistently for developer, tester, reviewer, and architect.

- [ ] **Step 3: Harden role prompts**

Add a short explicit rule block in each role prompt:

- `developer.md`
- `tester.md`
- `reviewer.md`
- `architect.md`

The rule should say the worker must execute directly in the current worktree/session and must not use nested coding agents or planning/meta-skills.

- [ ] **Step 4: Re-run the focused tests**

Run:

```bash
cd /home/mateus/Fabrica/.worktrees/hot-path-operational-corrections/fabrica
npx vitest run tests/unit/worker-context-hook.test.ts tests/unit/developer-prompt-content.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /home/mateus/Fabrica/.worktrees/hot-path-operational-corrections/fabrica
git add lib/dispatch/worker-context-hook.ts defaults/fabrica/prompts/developer.md defaults/fabrica/prompts/tester.md defaults/fabrica/prompts/reviewer.md defaults/fabrica/prompts/architect.md tests/unit/worker-context-hook.test.ts tests/unit/developer-prompt-content.test.ts
git commit -m "fix(workers): harden execution contract in prompts"
```

## Task 2: Detect Forbidden Meta-Delegation From Worker Transcript

**Files:**
- Modify: `lib/services/worker-completion.ts`
- Create: `tests/unit/worker-execution-surface.test.ts`

- [ ] **Step 1: Write the failing transcript detection tests**

Create tests that feed realistic worker transcript fragments into the worker-completion path and assert they are classified as execution-contract violations when they contain strong evidence such as:

- `coding-agent`
- `brainstorming`
- `writing-plans`
- `codex exec --full-auto`
- explicit spawn/delegation language tied to doing the task

Also add a control case where ordinary direct execution text is not flagged.

Run:

```bash
cd /home/mateus/Fabrica/.worktrees/hot-path-operational-corrections/fabrica
npx vitest run tests/unit/worker-execution-surface.test.ts
```

Expected: FAIL because the detector does not exist yet.

- [ ] **Step 2: Add a narrow transcript detector**

In `lib/services/worker-completion.ts`, add a focused helper such as:

```ts
function detectExecutionContractViolation(messages: unknown[]): {
  violated: boolean;
  reason?: "meta_skill" | "nested_coding_agent";
  evidence?: string;
}
```

Rules:
- only trigger on strong evidence
- do not use vague heuristics
- prefer assistant text/tool evidence
- include a short evidence string for audit logging

- [ ] **Step 3: Wire the detector into worker completion observation**

When a worker run has no canonical final result and the detector finds a violation:
- mark the observation as `invalid_execution_path`
- do not treat it as normal missing-result ambiguity
- carry forward enough context for recovery and audit

Avoid changing reviewer semantics.

- [ ] **Step 4: Re-run the focused tests**

Run:

```bash
cd /home/mateus/Fabrica/.worktrees/hot-path-operational-corrections/fabrica
npx vitest run tests/unit/worker-execution-surface.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /home/mateus/Fabrica/.worktrees/hot-path-operational-corrections/fabrica
git add lib/services/worker-completion.ts tests/unit/worker-execution-surface.test.ts
git commit -m "fix(workers): detect meta-delegation in transcripts"
```

## Task 3: Add Recovery For Execution-Contract Violations

**Files:**
- Modify: `lib/services/worker-completion.ts`
- Modify: `lib/services/heartbeat/health.ts`
- Modify: `tests/unit/heartbeat-health-session.test.ts`
- Modify: `tests/unit/worker-completion.test.ts`

- [ ] **Step 1: Write the failing recovery tests**

Add tests that assert:
- a worker with `invalid_execution_path` is not left indefinitely in normal `running`
- a short recovery window is allowed
- after the window expires without canonical completion, the slot is released and the issue is requeued safely
- this path is treated differently from `dispatch_unconfirmed`

Run:

```bash
cd /home/mateus/Fabrica/.worktrees/hot-path-operational-corrections/fabrica
npx vitest run tests/unit/worker-completion.test.ts tests/unit/heartbeat-health-session.test.ts
```

Expected: FAIL on the new scenarios.

- [ ] **Step 2: Implement recovery state**

Add runtime/audit handling for:
- `worker_execution_contract_violation`
- `worker_execution_recovery_started`
- `worker_execution_recovery_exhausted`

Behavior:
- short grace window after detection
- if canonical completion appears, normal pipeline continues
- if not, requeue as operational failure and free the slot safely

- [ ] **Step 3: Keep semantics clean**

Ensure this path:
- does not map to review rejection
- does not map to environment bootstrap failure
- does not produce `dispatch_unconfirmed`

It should be its own operational branch.

- [ ] **Step 4: Re-run the focused tests**

Run:

```bash
cd /home/mateus/Fabrica/.worktrees/hot-path-operational-corrections/fabrica
npx vitest run tests/unit/worker-completion.test.ts tests/unit/heartbeat-health-session.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /home/mateus/Fabrica/.worktrees/hot-path-operational-corrections/fabrica
git add lib/services/worker-completion.ts lib/services/heartbeat/health.ts tests/unit/worker-completion.test.ts tests/unit/heartbeat-health-session.test.ts
git commit -m "fix(workers): recover invalid execution paths safely"
```

## Task 4: Add Topic Notification For Operational Worker Violation

**Files:**
- Modify: `lib/dispatch/notify.ts`
- Modify: `lib/services/pipeline.ts`
- Modify: `tests/unit/notify.test.ts`
- Modify: `tests/unit/pipeline-notify.test.ts`

- [ ] **Step 1: Write the failing notification tests**

Add coverage for a new event that reports worker execution-contract failure/requeue in concise timeline form.

Run:

```bash
cd /home/mateus/Fabrica/.worktrees/hot-path-operational-corrections/fabrica
npx vitest run tests/unit/notify.test.ts tests/unit/pipeline-notify.test.ts
```

Expected: FAIL because the new event type/message does not exist yet.

- [ ] **Step 2: Implement a brief event-shaped notification**

Recommended shape:

```text
⚠️ DEVELOPER run violated execution contract on #1
Nested delegation is not allowed for Fabrica workers
→ DEVELOPER queue
```

Keep it concise and timeline-friendly.

- [ ] **Step 3: Emit notification only when recovery is exhausted**

Do not notify on first detection if the recovery window is still open.
Notify only when Fabrica has decided to requeue.

- [ ] **Step 4: Re-run the focused tests**

Run:

```bash
cd /home/mateus/Fabrica/.worktrees/hot-path-operational-corrections/fabrica
npx vitest run tests/unit/notify.test.ts tests/unit/pipeline-notify.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /home/mateus/Fabrica/.worktrees/hot-path-operational-corrections/fabrica
git add lib/dispatch/notify.ts lib/services/pipeline.ts tests/unit/notify.test.ts tests/unit/pipeline-notify.test.ts
git commit -m "feat(timeline): notify worker execution contract failures"
```

## Task 5: End-To-End Validation Against The Real Failure Mode

**Files:**
- Modify only if needed based on findings from validation

- [ ] **Step 1: Run the focused worker surface suite**

Run:

```bash
cd /home/mateus/Fabrica/.worktrees/hot-path-operational-corrections/fabrica
npx vitest run tests/unit/worker-context-hook.test.ts tests/unit/developer-prompt-content.test.ts tests/unit/worker-execution-surface.test.ts tests/unit/worker-completion.test.ts tests/unit/heartbeat-health-session.test.ts tests/unit/notify.test.ts tests/unit/pipeline-notify.test.ts
```

Expected: PASS

- [ ] **Step 2: Run hot-path verification**

Run:

```bash
cd /home/mateus/Fabrica/.worktrees/hot-path-operational-corrections/fabrica
npm run test:hot-path
npm run build
```

Expected:
- hot path passes
- build succeeds

- [ ] **Step 3: Restart the gateway with the updated plugin**

Run:

```bash
openclaw gateway restart
```

Expected: service restarts cleanly

- [ ] **Step 4: Validate against a real worker cycle**

Use a supported-stack Telegram project flow and monitor:
- worker no longer sees/uses forbidden meta-skills
- worker executes directly in the assigned worktree
- if a violation is forced or reproduced, Fabrica requeues safely instead of hanging

Capture concrete evidence from:
- `~/.openclaw/workspace/fabrica/log/audit.log`
- `~/.openclaw/agents/main/sessions/*.jsonl`
- GitHub issue/PR state

- [ ] **Step 5: Commit validation-only follow-up if needed**

If validation requires small final adjustments:

```bash
cd /home/mateus/Fabrica/.worktrees/hot-path-operational-corrections/fabrica
git add <final-files>
git commit -m "fix(workers): finalize execution surface recovery"
```

If no adjustment is needed, skip this commit.

## Self-Review

- Spec coverage:
  - worker surface restriction: Tasks 1 and 2
  - role-specific policy: Task 1
  - layered enforcement: Tasks 1, 2, 3
  - recovery semantics: Task 3
  - observability and timeline: Task 4
  - runtime validation: Task 5
- Placeholder scan:
  - no `TODO`/`TBD`
  - each task names concrete files and commands
- Type consistency:
  - keep event names consistent with the spec:
    - `worker_execution_contract_violation`
    - `worker_meta_delegation_detected`
    - `worker_execution_recovery_started`
    - `worker_execution_recovery_exhausted`
    - `worker_execution_requeued`
