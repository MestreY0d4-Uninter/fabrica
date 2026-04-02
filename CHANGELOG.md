# Changelog

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
