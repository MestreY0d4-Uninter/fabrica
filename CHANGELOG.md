# Changelog

## 0.2.14 - 2026-04-01

- Made `agent_end` authoritative for reviewer completion as well, so reviewer sessions no longer depend on delayed `subagent_ended` or reviewer polling to advance the FSM.
- Added session-history fallback for developer/tester/architect lifecycle completion when `agent_end` arrives without the final assistant result line.
- Hardened Telegram bootstrap ownership so stale attempts stop before stamping `project_registered` data or replaying kickoff, `projectTick`, or completion DM side effects onto a newer attempt.
- Added regression coverage for reviewer `agent_end` routing, worker lifecycle session-history fallback, and successful bootstrap owner-loss races.

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
