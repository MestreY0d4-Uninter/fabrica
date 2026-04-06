# Changelog

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
