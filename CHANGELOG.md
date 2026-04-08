# Changelog

## 0.2.45 - 2026-04-08

- Fixed clean-machine setup regressions found during fresh Ubuntu VPS validation: `openclaw fabrica setup --new-agent <name> --workspace <path>` now actually forwards the explicit workspace to agent creation, and setup no longer crashes when writing default models into a freshly scaffolded `workflow.yaml`.
- Updated README host requirements from Node 20+ to Node 22+ to match the real `openclaw@2026.4.8` engine requirement discovered during validation.

## 0.2.44 - 2026-04-08

- Documentation hardening for first-time users: clarified host prerequisites vs project provisioning, made GitHub permission expectations more explicit, added a minimal non-Telegram path, and documented the `FABRICA_PROJECTS_CHANNEL_ID` setup shortcut more clearly.
- No runtime behavior changed in this version; it is a release focused on onboarding clarity before clean-machine validation.

## 0.2.43 - 2026-04-08

- Hardened first-run Telegram setup for new users: `openclaw fabrica setup` now writes an explicit Fabrica `telegram` config block, defaults `bootstrapDmEnabled` to true in plugin config, and hydrates forum/account/chat IDs from environment variables like `FABRICA_PROJECTS_CHANNEL_ID` when available.
- Improved onboarding guidance so users missing `projectsForumChatId` are told about the env-based prefill path instead of only getting a generic rerun instruction.

## 0.2.42 - 2026-04-08

- Documentation closeout release: updated the README with the new `doctor issue` and convergence-aware metrics workflow, added `FUTURE_IMPROVEMENTS.md` for deferred non-blocking ideas, and removed stale internal planning docs from `docs/plans/` so the GitHub repo stays cleaner for public release.
- No runtime behavior changed in this version; it is a publication hygiene/documentation refresh on top of `0.2.41`.

## 0.2.41 - 2026-04-08

- Added a focused QA-convergence refinement pass: QA Evidence failures now expose richer subcauses, persist minimal canonical QA runtime state (missing gates, subcause, observed head-SHA, evidence fingerprint), and detect stale/unchanged retries before counting them as real progress.
- Improved `repair_qa_evidence` guidance, doctor output, and metrics normalization so post-PR invalid-QA loops are explained and measured in more actionable terms instead of collapsing into one generic `invalid_qa_evidence` bucket.

## 0.2.40 - 2026-04-08

- Added automatic doctor snapshots in key post-PR recovery paths. When convergence loops are re-queued/escalated after blocked completion or `stalled_with_artifact`, Fabrica now emits a compact `doctor_snapshot` audit event with PR, progress state, convergence cause/action, retry count, and head-SHA change context.
- Extended `openclaw fabrica metrics` with aggregated convergence telemetry: cause counts, human escalations, average dispatch→first-PR timing, and per-stack breakdowns. This is the first calibration-focused observability layer for tuning post-PR policies from real evidence.

## 0.2.39 - 2026-04-08

- Enriched the issue/run doctor output with lifecycle and progression context: dispatch cycle, dispatch run, progress state (`no_dispatch` / `accepted_idle` / `active` / `completed`), and head-SHA comparison against the last convergence attempt.
- Added head-SHA memory to convergence tracking so future retries and doctor output can distinguish stale churn from real PR movement more reliably.

## 0.2.38 - 2026-04-08

- Exposed the issue/run doctor as a first-class Fabrica tool (`doctor_issue`) in addition to the CLI command, so agents and operators can inspect a live converging/thrashing issue directly from the plugin tool surface.
- Refined post-PR convergence again with head-SHA awareness: repeating the same blocker cause only increments the retry budget when the PR head SHA has not changed. If the PR actually moved forward, Fabrica resets the convergence retry counter instead of escalating stale history.

## 0.2.37 - 2026-04-08

- Added `openclaw fabrica doctor issue --project <slug> --issue <id>` to inspect one live run with convergence metadata, PR context, issue labels, and a recommended next action. This gives an operator-level explanation of why a run is looping or what Fabrica is likely to do next.
- Refined post-PR convergence again so validation-failure paths reuse best-effort PR evidence before deciding retry vs escalation, making the convergence metadata more faithful in real runs.

## 0.2.36 - 2026-04-08

- Preserved canonical PR evidence even when developer completion fails. The post-PR convergence budget now reuses a best-effort PR status snapshot from validation, so artifact-backed loops like invalid QA evidence can actually trip escalation instead of silently falling back to endless feedback retries when runtime PR binding is stale.
- This closes a gap discovered immediately after 0.2.35: the convergence controller logic was present, but some real runs still looked artifact-less because the open PR had not been re-bound into issue runtime before the validation failure path executed.

## 0.2.35 - 2026-04-08

- Added a first post-PR convergence layer: repeated developer/blocker causes are now typed in issue runtime (`lastConvergenceCause`, `lastConvergenceAction`, retry count, reason, timestamp) instead of being treated as generic queue churn.
- Added budgeted escalation for artifact-backed loops. When the same post-PR cause repeats beyond its retry budget (for example invalid QA evidence on an already-open PR, or repeated `stalled_with_artifact`), Fabrica escalates the issue to a hold state like `Refining` instead of redispatching the same `To Improve` cycle indefinitely.
- This is the first concrete step toward a PR-aware convergence controller rather than pure requeue-based recovery.

## 0.2.34 - 2026-04-08

- Added heartbeat recovery for developer sessions that already have a reviewable PR but stop converging for too long. Fabrica now detects the stalled-with-artifact pattern, re-queues the issue, and records `stalled_with_artifact` instead of leaving the run stuck in `Doing` indefinitely.
- This targets the real-world PR-open / no-progress loops observed in richer CLI/API validation runs.

## 0.2.33 - 2026-04-07

- Refined the new worktree-drift guard so explicit `~/.openclaw/workspace` evidence only blocks completion when it is the actual execution-path violation, while canonical result precedence still holds for unrelated strong-evidence transcript matches.
- This keeps the hardening introduced in 0.2.32 without breaking the established execution-surface contract tests.

## 0.2.32 - 2026-04-07

- Added worker-completion recovery guards for explicit worktree drift evidence in subagent transcripts. When a worker produces a final result after falling back into `~/.openclaw/workspace`, Fabrica now marks the completion inconclusive instead of trusting the result line.
- This hardens the pipeline beyond prompt-only guidance and prevents false DONE/PASS outcomes from sessions that visibly escaped their assigned worktree.

## 0.2.31 - 2026-04-07

- Strengthened developer/tester default prompts to treat the shell exec tool as stateless: every repo-scoped command must explicitly re-enter the assigned worktree (`cd "$WORKTREE" && ...`) or use absolute repo paths.
- This addresses a real validation failure where workers repeatedly drifted back to `~/.openclaw/workspace`, believed work was done, and then hit `work_finish(done)` on the base branch without an open PR.

## 0.2.30 - 2026-04-07

- Added a Telegram bootstrap recovery path for projects that were registered successfully but paused with `needs-human` due to missing auth requirements. A follow-up DM clarification now updates the existing issue and resumes automatic dispatch instead of being silently ignored.

## 0.2.29 - 2026-04-07

- Fixed generated Python-family `scripts/qa.sh` scaffolds so `sanitize_public_output()` is defined before the pytest/coverage pipes that use it.
- This resolves a real validation failure where tester QA runs on greenfield Python CLI projects were marked failed only because the generated QA script referenced an undefined sanitizer function.

## 0.2.28 - 2026-04-07

- Fixed final closeout evidence gating so tester-driven completion can use the canonical PR already stored in issue runtime/artifact metadata before deciding whether a CLI/project has meaningful evidence to close.
- This removes a real false-negative seen in Telegram/OpenClaw validation where a project advanced through developer/reviewer/tester but the final heartbeat close was blocked despite an existing bound PR.

## 0.2.27 - 2026-04-07

- Sanitized generated `scripts/qa.sh` output for greenfield scaffolds so canonical QA Evidence no longer leaks host-system paths into PR bodies during real Fabrica runs.
- This prevents valid developer completions from being bounced back into feedback loops only because Vitest/coverage output included absolute local paths.

## 0.2.26 - 2026-04-07

- Added a subagent-ended repair path for developer/tester/architect worker sessions so canonical completion can still be applied when a real worker run ends with a `Work result:` line but the primary `agent_end` path does not fire in time.
- This closes a real Fabrica validation gap that could leave successful runtime-dispatched workers stuck in `Doing`/feedback loops even after the session had already ended cleanly.

## 0.2.25 - 2026-04-07

- Improved Telegram bootstrap completion messaging so project topics and DM acknowledgements now include the GitHub issue and explicitly explain when automatic dispatch is paused by triage blockers.
- This makes real Fabrica runs easier to understand when a project registers successfully but still needs human refinement before worker dispatch.

## 0.2.24 - 2026-04-07

- Hardened Fabrica intake, triage, and acceptance flow so request fidelity, clarification policy, and runtime quality signals are carried from intake through final completion.
- Added explicit dispatch semantics and trigger-source auditing, plus clearer worker lifecycle notifications for fresh dispatches, resumes, feedback redispatches, and bootstrap-triggered cycles.
- Introduced stack policies, quality gates, done policies, and final acceptance summaries so completion decisions and human notifications carry more concrete evidence and archetype-aware reasoning.
- Propagated triage criticality/risk into issue runtime and parent-family rollups, improving final acceptance, operational timelines, and parent decomposition visibility.

## 0.2.23 - 2026-04-07

- Completed the parent/child runtime promotion for large work: decomposition metadata is now canonical in issue runtime, child issues carry dependency bindings, recommended level hints, and parent families persist a parallelism ceiling.
- Upgraded decomposition from naive chunking to child drafts with capability areas, execution profiles, dependency hints, and queue-ready child transitions so large initiatives can enter the normal worker flow safely.
- Made triage distinguish effort from parallelizability/coupling: tightly coupled `large` work no longer auto-splits just because it is big, while decomposable work can fan out into child execution families.
- Added family-aware scheduling and parent lifecycle reconciliation: parent issues stay coordinator-only, dependency ordering is respected, sibling parallelism is capped, blocked children propagate to the parent rollup, and completed families auto-close the parent dashboard issue.
- Hardened Telegram DM bootstrap naming/clarification, dispatch atomicity tests, environment-gate ordering, and pipeline/e2e coverage so the release gate (`npm publish --dry-run`) passes end-to-end again.

## 0.2.20 - 2026-04-06

- **Bug fix (clarification):** Added scope-ambiguity detection to the Telegram bootstrap flow. When a request spans 3+ subsystems (auth, notifications, workers, DB...) without explicit tech choices, the bot now asks for clarification before registering the project instead of proceeding with a vague LLM-minimised spec. User can reply "livre"/"your call" to skip and let the bot decide. Closes #1.
- **Bug fix (work_finish):** `work_finish` now emits a clear, actionable error with exact `git worktree add` and `gh pr create` commands when the developer tries to complete a task while still on the base branch (main/integration/etc.) without any open PR. Replaces the previous misleading `--head main` suggestion. Closes #2.
- **Bug fix (triage effort):** Effort calculation now applies a complexity floor derived from rawIdea signals. Requests with 4+ subsystem keywords (auth, worker, notifications, realtime...) floor at `effort:large`; 2–3 subsystems floor at `effort:medium`. Prevents complex multi-system features from being classified as `effort:small` when the LLM-generated spec is thin. The auth gate signal detection now also searches rawIdea directly. Closes #3.

## 0.2.19 - 2026-04-06

- Fixed developer feedback-cycle dispatch so task messages reuse the actual PR branch/worktree instead of always pointing back to the canonical issue branch.
- Hardened the developer feedback prompt to create a local tracking worktree from the existing PR branch, avoiding detached-head and wrong-branch update flows.
- Restored node-cli scaffold README setup/run snippets so generated repos document how to install dependencies and run the CLI.
- Added regression coverage for feedback-cycle branch/worktree messaging while keeping the node-cli scaffold/QA hot path green.

## 0.2.18 - 2026-04-05

- Fixed developer completion validation to respect the project base branch and prefer the canonical issue-linked PR when the main checkout branch is the configured base branch.
- Added active regression coverage for base-branch PR validation, including custom base branch names and retargeted branch PR protection.
- Fixed developer dispatch context to pass the canonical local repository path into worker task messages instead of degrading to repo remote or slug-only context.
- Exposed the canonical execution path in worker task messages and aligned the developer prompt so workers must start from the registered repo path instead of silently creating projects under `~/.openclaw/workspace/<slug>`.
- Normalized worker-completion recovery to use the workflow feedback queue label instead of hardcoding `To Improve`, and refreshed the associated unit coverage.

## 0.2.17 - 2026-04-04

- Removed bundled `pino` / `thread-stream` worker artifacts from the distributed plugin package so OpenClaw install security scanning no longer blocks Fabrica on `new Function(...)` inside generated worker bundles.
- Preserved opt-in pretty logging by switching `LOG_PRETTY=1` to a direct `pino-pretty` stream instead of worker-thread transport wiring.
- Tightened release/installability validation around the real published artifact so the package that passes `npm publish --dry-run` matches the package operators install via `openclaw plugins install @mestreyoda/fabrica`.

## 0.2.16 - 2026-04-04

- Closed the Batch 3 operational integration cycle and prepared the public 0.2.16 release path.
- Hardened the npm release gate so `npm publish --dry-run` no longer inherits lifecycle `dry-run` state into nested lockfile/bootstrap and installability checks.
- Stabilized release verification around deterministic pack/install smoke behavior, explicit publish-path validation, and canonical OpenClaw binary selection.
- Normalized package metadata for publish (`repository.url`) and documented a clean install-first operator flow in the distributed package surfaces.
- Hardened Telegram bootstrap flow test cleanup against transient `ENOTEMPTY` races during temporary workspace teardown.

## 0.2.15 - 2026-04-03

- Hardened Telegram DM intake around durable `pending_classify` / `classifying` recovery, newer-attempt ownership, and explicit late-classify reconciliation.
- Added runtime-aware DM claiming via `before_dispatch` plus short-lived message/conversation guards so Telegram prompts stay inside Fabrica instead of leaking to the generic OpenClaw agent.
- Fixed greenfield scaffold canonical repo path handling so `metadata.repo_path` / `scaffold_plan.repo_local` survive all the way into `scaffold-project.sh` and published genesis assets.
- Tightened bootstrap and register fail-closed behavior for unsupported stacks and missing materialized repositories, preventing half-registered validation projects.
- Reset and revalidated the temporary Telegram validation harness, including a reusable runner path and regression coverage for read/wait flows.
- Extended regression coverage for Telegram bootstrap recovery, scaffold path ownership, classify-step typing, and end-to-end hot-path stability.

## 0.2.14 - 2026-04-02

- Added a stack-aware environment gate so developer and tester pickup only start after project environments are provisioned and marked ready.
- Hardened Python stack bootstrap around durable environment state, retry scheduling, and stale provisioning recovery without `sudo`.
- Reworked worker recovery so observable activity without a canonical result enters bounded completion recovery instead of immediately corrupting dispatch health.
- Made heartbeat distinguish accepted-but-idle dispatches, inconclusive completion, terminal sessions, and true dead sessions with cycle-aware ownership checks.
- Added explicit timeline events for reviewer outcomes and worker recovery exhaustion, with cycle-aware dedupe and corrected destination-state messaging.
- Preserved reviewer notification routing through plugin notification config instead of bypassing runtime settings.
- Extended regression coverage for environment provisioning, gateway session transcript activity, heartbeat recovery, reviewer notifications, and end-to-end hot-path orchestration.

## 0.2.13 - 2026-03-31

- Disabled automatic pretty logging on TTY so the plugin no longer depends on `pino-pretty` during load.
- Added a safe one-shot fallback to structured logs when pretty transport resolution or initialization fails.
- Added logger transport regression coverage and promoted it into the hot-path test lane.

## 0.2.12 - 2026-03-31

- Made the published plugin self-contained by replacing remaining runtime helper imports from `openclaw/plugin-sdk`.
- Added release gates for runtime-boundary and isolated installability verification, with fail-closed behavior, timeouts, and cleanup.
- Documented the real install contract and workspace-scoped operational setup flow in the package README and architecture notes.
- Aligned local deploy to the same contract by removing the extension `node_modules` symlink fallback.

## 0.2.11 - 2026-03-31

- Unified reviewer completion around the canonical `Review result: APPROVE|REJECT` contract.
- Hardened dispatch identity and reduced heartbeat progression to repair-oriented behavior.
- Enforced canonical PR selection across reviewer/tester and queue-side flows.
- Preserved and hardened the Telegram three-plane model: DM bootstrap, project forum topics, and ops routing.
- Restored confidence lanes for release verification with explicit `test:unit`, `test:e2e`, and `test:hot-path`.
- Aligned plugin config governance and observability surfaces so runtime knobs are real and misleading signals no longer present themselves as authoritative.
