# Fabrica Phase A Implementation Plan

> For Hermes: execute this in small commits. Do not mix Phase B+ work into this plan.

Goal

Canonicalize parent/child decomposition in Fabrica runtime state so automatically decomposed epics and manually created child tasks use the same durable structure.

Architecture

Today Fabrica has two parallel mechanisms:
- automatic decomposition in `lib/intake/steps/triage.ts`
- manual child creation in `lib/tools/tasks/task-create.ts`

The manual path already persists `parentIssueId` and `childIssueIds` in `issueRuntime`. The automatic path creates child issues and labels, but does not fully persist the same canonical relationship. Phase A makes both paths converge on one runtime model and one helper API.

Tech Stack

- TypeScript
- Vitest
- Existing project runtime state in `projects.json`
- Existing `withProjectsMutation(...)` mutation helpers

Non-goals

- Do not add dependency graphs yet
- Do not add parallelizability scoring yet
- Do not change scheduler behavior yet
- Do not add new workflow states yet
- Do not redesign decomposition heuristics yet

---

## Target state for Phase A

After this phase:
- every automatically decomposed parent issue stores canonical child references
- every auto-created child issue stores canonical parent reference
- decomposition metadata is persisted explicitly in runtime state
- helper functions exist to query parent/child runtime relationships cleanly
- decomposition labels are treated as official/synchronized operational labels
- tests cover both manual and automatic parent/child creation paths

---

## Files expected to change

Primary files
- Modify: `lib/projects/types.ts`
- Modify: `lib/projects/mutations.ts`
- Modify: `lib/projects/index.ts`
- Modify: `lib/intake/types.ts`
- Modify: `lib/intake/steps/triage.ts`
- Modify: `lib/tools/tasks/task-create.ts`
- Modify: `lib/workflow/labels.ts`
- Modify: `lib/tools/admin/sync-labels.ts`

Tests
- Modify: `tests/unit/triage-step.test.ts`
- Add: `tests/unit/project-parent-child-runtime.test.ts`
- Optional add if needed: `tests/unit/task-create-parent-child.test.ts`

Docs
- Optional patch after code lands: `ARCHITECTURE.md`

---

## Runtime model to introduce

Extend `IssueRuntimeState` with:

```ts
decompositionMode?: "none" | "parent_child" | null;
decompositionStatus?: "draft" | "active" | "completed" | "blocked" | null;
```

Semantics:
- parent issue after decomposition:
  - `decompositionMode: "parent_child"`
  - `decompositionStatus: "active"`
  - `childIssueIds: [child ids]`
- child issue:
  - `parentIssueId: <parent>`
  - `decompositionMode: "none"`
  - `decompositionStatus: null`

Notes:
- Keep `parentIssueId` and `childIssueIds` as the canonical relationship fields.
- `decompositionStatus` is only needed for parent-side orchestration visibility in this phase.
- Do not add dependency fields yet.

---

## Helper API to add

In `lib/projects/mutations.ts` and re-export through `lib/projects/index.ts`, add helpers:

```ts
export function getParentIssueRuntime(
  project: Project,
  issueId: number | string,
): IssueRuntimeState | undefined

export function getChildIssueRuntimes(
  project: Project,
  issueId: number | string,
): Array<{ issueId: number; runtime: IssueRuntimeState | undefined }>

export function isParentIssue(
  project: Project,
  issueId: number | string,
): boolean

export function isChildIssue(
  project: Project,
  issueId: number | string,
): boolean
```

Behavior:
- `isParentIssue` => true when `childIssueIds` has length > 0 or `decompositionMode === "parent_child"`
- `isChildIssue` => true when `parentIssueId` is set
- `getParentIssueRuntime` => for a child issue, return the parent runtime
- `getChildIssueRuntimes` => for a parent issue, return all referenced child runtimes

Keep these pure read helpers — no side effects.

---

## Label policy for Phase A

Treat the following as official decomposition labels:
- `decomposition:parent`
- `decomposition:child`

Update the workflow/admin label sync path so these labels are guaranteed to exist before use.

Important:
- Do not overload them with scheduling meaning yet.
- In this phase, they are visibility/traceability labels only.

---

## Implementation tasks

### Task 1: Add failing test for IssueRuntimeState decomposition metadata

Objective: lock in the new runtime shape before implementation.

Files:
- Modify: `tests/unit/project-parent-child-runtime.test.ts` (new)
- Read: `lib/projects/types.ts`

Step 1: Create the new test file

Write a new test file with an initial shape assertion around parent and child runtime values.

Suggested test skeleton:

```ts
import { describe, expect, it } from "vitest";
import type { IssueRuntimeState } from "../../lib/projects/types.js";

describe("project parent/child runtime metadata", () => {
  it("supports decomposition metadata on parent runtime", () => {
    const runtime: IssueRuntimeState = {
      childIssueIds: [11, 12],
      decompositionMode: "parent_child",
      decompositionStatus: "active",
    };

    expect(runtime.childIssueIds).toEqual([11, 12]);
    expect(runtime.decompositionMode).toBe("parent_child");
    expect(runtime.decompositionStatus).toBe("active");
  });
});
```

Step 2: Run the focused test

Run:

```bash
npm test -- --run tests/unit/project-parent-child-runtime.test.ts
```

Expected now:
- TypeScript/Vitest failure because fields are not in `IssueRuntimeState`

Step 3: Extend the type

Modify `lib/projects/types.ts` to add:

```ts
decompositionMode?: "none" | "parent_child" | null;
decompositionStatus?: "draft" | "active" | "completed" | "blocked" | null;
```

Step 4: Re-run test

Expected:
- pass

Step 5: Commit

```bash
git add tests/unit/project-parent-child-runtime.test.ts lib/projects/types.ts
git commit -m "feat: add decomposition runtime metadata"
```

---

### Task 2: Add failing tests for parent/child read helpers

Objective: define the canonical helper behavior before implementation.

Files:
- Modify: `tests/unit/project-parent-child-runtime.test.ts`
- Modify: `lib/projects/mutations.ts`
- Modify: `lib/projects/index.ts`

Step 1: Add tests for helper behavior

Add tests covering:
- `isParentIssue(...)`
- `isChildIssue(...)`
- `getParentIssueRuntime(...)`
- `getChildIssueRuntimes(...)`

Suggested test fixture:

```ts
const project = {
  issueRuntime: {
    "10": {
      childIssueIds: [11, 12],
      decompositionMode: "parent_child",
      decompositionStatus: "active",
    },
    "11": { parentIssueId: 10 },
    "12": { parentIssueId: 10 },
  },
} as any;
```

Assertions:

```ts
expect(isParentIssue(project, 10)).toBe(true);
expect(isParentIssue(project, 11)).toBe(false);
expect(isChildIssue(project, 11)).toBe(true);
expect(isChildIssue(project, 10)).toBe(false);
expect(getParentIssueRuntime(project, 11)?.childIssueIds).toEqual([11, 12]);
expect(getChildIssueRuntimes(project, 10).map(x => x.issueId)).toEqual([11, 12]);
```

Step 2: Run test and verify failure

Run:

```bash
npm test -- --run tests/unit/project-parent-child-runtime.test.ts
```

Expected:
- import/function missing failures

Step 3: Implement helpers in `lib/projects/mutations.ts`

Add pure functions near `getIssueRuntime(...)`.

Implementation guidance:
- normalize `issueId` with `String(issueId)`
- use `project.issueRuntime?.[key]`
- be null-safe
- `getChildIssueRuntimes(...)` should return stable order based on `childIssueIds`

Step 4: Re-export from `lib/projects/index.ts`

Step 5: Re-run test

Expected:
- pass

Step 6: Commit

```bash
git add tests/unit/project-parent-child-runtime.test.ts lib/projects/mutations.ts lib/projects/index.ts
git commit -m "feat: add parent child runtime query helpers"
```

---

### Task 3: Add failing test that automatic triage decomposition persists parent/child runtime links

Objective: make automatic decomposition use the same canonical runtime structure as manual task creation.

Files:
- Modify: `tests/unit/triage-step.test.ts`
- Modify: `lib/intake/steps/triage.ts`

Step 1: Locate existing decomposition test

Find the existing test:
- `decomposes large ready work into parent + child issues instead of dispatching immediately`

Step 2: Extend that test with new expectations

Add expectations that after decomposition:
- parent runtime has:
  - `childIssueIds`
  - `decompositionMode: "parent_child"`
  - `decompositionStatus: "active"`
- each child runtime has:
  - `parentIssueId: <parent>`

Pseudo-assertions:

```ts
const projects = await readProjects(workspaceDir);
const project = projects.projects[slug]!;
expect(project.issueRuntime?.["42"]?.decompositionMode).toBe("parent_child");
expect(project.issueRuntime?.["42"]?.decompositionStatus).toBe("active");
expect(project.issueRuntime?.["42"]?.childIssueIds?.length).toBeGreaterThanOrEqual(2);
for (const childId of project.issueRuntime?.["42"]?.childIssueIds ?? []) {
  expect(project.issueRuntime?.[String(childId)]?.parentIssueId).toBe(42);
}
```

Step 3: Run the test

Run:

```bash
npm test -- --run tests/unit/triage-step.test.ts
```

Expected:
- fail because triage currently does not persist all of this canonical structure

Step 4: Patch `lib/intake/steps/triage.ts`

When auto-decomposition succeeds:
- after `createdChildIssueNumbers` is known
- update parent runtime with:

```ts
await updateIssueRuntime(..., issue.number, {
  childIssueIds: createdChildIssueNumbers,
  decompositionMode: "parent_child",
  decompositionStatus: "active",
});
```

For each child issue:

```ts
await updateIssueRuntime(..., child.iid, {
  parentIssueId: issue.number,
  decompositionMode: "none",
  decompositionStatus: null,
});
```

Important:
- use the canonical runtime mutation helpers
- do not only write comments/body text
- keep existing labels/comments behavior unchanged for now

Step 5: Re-run the test

Expected:
- pass

Step 6: Commit

```bash
git add tests/unit/triage-step.test.ts lib/intake/steps/triage.ts
git commit -m "feat: persist auto decomposition runtime links"
```

---

### Task 4: Add failing test that manual `task_create(parentIssueId)` and automatic decomposition stay consistent

Objective: verify both paths produce compatible runtime structure.

Files:
- Modify: `tests/unit/project-parent-child-runtime.test.ts`
- Read: `lib/tools/tasks/task-create.ts`

Step 1: Add a consistency test

This can be a shape-level test rather than full tool execution if there is already enough helper coverage.

Validate assumptions:
- manual path stores `parentIssueId` on child and appends to `childIssueIds` on parent
- automatic path now stores the same pair plus decomposition metadata on parent

At minimum, assert the helper API behaves equally on both shapes.

Step 2: If easier, add or extend a `task-create` unit test

If the repo already has `task_create` tests, extend them.
If not, keep the assertion in `project-parent-child-runtime.test.ts`.

Step 3: Re-run focused tests

Run:

```bash
npm test -- --run tests/unit/project-parent-child-runtime.test.ts tests/unit/triage-step.test.ts
```

Expected:
- pass

Step 4: Commit

```bash
git add tests/unit/project-parent-child-runtime.test.ts tests/unit/triage-step.test.ts
git commit -m "test: align manual and automatic parent child runtime behavior"
```

---

### Task 5: Add failing test for official decomposition labels

Objective: make decomposition labels part of the official label governance path.

Files:
- Modify: `tests/unit/workflow.test.ts` or label-sync test if more appropriate
- Modify: `lib/workflow/labels.ts`
- Modify: `lib/tools/admin/sync-labels.ts`

Step 1: Add test expectation

Add assertions that the operational/syncable label set includes:
- `decomposition:parent`
- `decomposition:child`

Step 2: Run test and verify failure

Step 3: Implement label support

Update whichever label registry/sync list is canonical in the repo.

Step 4: Re-run tests

Expected:
- pass

Step 5: Commit

```bash
git add tests/unit/workflow.test.ts lib/workflow/labels.ts lib/tools/admin/sync-labels.ts
git commit -m "feat: register decomposition labels as managed labels"
```

---

### Task 6: Add parent/child visibility assertions to status/read paths

Objective: ensure Phase A data is visible to operators and later phases.

Files:
- Read/modify as needed: `lib/projects/index.ts`
- Possibly test-only in `tests/unit/project-parent-child-runtime.test.ts`

Step 1: Add assertions that helper reads expose data clearly

This can stay in the helper test suite for Phase A.

Step 2: If there is a project status serialization path, add a regression test there

Goal:
- make sure parent/child links survive read/write of `projects.json`

Step 3: Re-run targeted tests

Run:

```bash
npm test -- --run tests/unit/project-parent-child-runtime.test.ts tests/unit/triage-step.test.ts tests/unit/workflow.test.ts
```

Expected:
- pass

Step 4: Commit

```bash
git add tests/unit/project-parent-child-runtime.test.ts
# plus any extra file touched
git commit -m "test: preserve decomposition runtime visibility across project state"
```

---

### Task 7: Run hot-path verification

Objective: make sure Phase A does not break core Fabrica behavior.

Files:
- No code changes unless failures appear

Step 1: Run focused suite

```bash
npm test -- --run tests/unit/project-parent-child-runtime.test.ts tests/unit/triage-step.test.ts tests/unit/workflow.test.ts
```

Step 2: Run broader hot-path suite

```bash
npm test -- --run tests/unit/dispatch-identity.test.ts tests/unit/heartbeat-health-session.test.ts tests/integration/dispatch-flow.test.ts tests/unit/triage-step.test.ts
```

Step 3: Build

```bash
npm run build
```

Expected:
- all pass

Step 4: Commit any last fixups

```bash
git add <files>
git commit -m "test: verify phase a parent child runtime integration"
```

---

## Concrete implementation notes

### `lib/projects/types.ts`
Add only these new fields now:

```ts
decompositionMode?: "none" | "parent_child" | null;
decompositionStatus?: "draft" | "active" | "completed" | "blocked" | null;
```

Do not add `dependsOn`, `parallelizable`, or scheduler fields yet.

### `lib/intake/steps/triage.ts`
In the `canDecompose` branch:
- keep labels/comments behavior
- add runtime updates after children are created
- parent update should happen once after `createdChildIssueNumbers` is complete
- child runtime updates should happen inside the creation loop or immediately after

### `lib/tools/tasks/task-create.ts`
Do not redesign it in Phase A.
Only adjust if necessary to keep semantics aligned.
The manual path is already the reference behavior.

### Label sync
Use the same code path that already manages operational labels.
Do not invent a separate label management flow.

---

## Acceptance criteria for Phase A

- [ ] Automatic decomposition persists parent/child relationships canonically in `issueRuntime`
- [ ] Manual and automatic parent/child creation are shape-compatible
- [ ] Decomposition metadata exists on parent runtime
- [ ] Read helpers exist and are tested
- [ ] Decomposition labels are treated as official managed labels
- [ ] Targeted tests pass
- [ ] Hot-path validation passes
- [ ] `npm run build` passes

---

## Risks and how to avoid them

Risk 1: Phase A accidentally changes scheduler behavior
- Avoid by not touching dispatch/tick semantics yet.
- This phase is persistence + helper API only.

Risk 2: Parent and child runtime state drift apart
- Always update both sides in the same logical branch of code.
- Prefer canonical helper functions later, but for this phase keep writes explicit and tested.

Risk 3: Automatic decomposition duplicates or overwrites manual child links
- Preserve set semantics for `childIssueIds`
- Use `new Set([...])`

Risk 4: Labels exist in one provider path but not another
- Add them to the same managed label registry used elsewhere.

---

## Definition of done for this plan

This Phase A is done when Fabrica can reliably answer these questions from runtime state alone:
- Is this issue a parent epic?
- Is this issue a child task?
- What is the parent of this child?
- What are the children of this parent?
- Is this parent currently in an active decomposition state?

That is the minimum foundation required before building the Ideal scheduler/decomposition system.
